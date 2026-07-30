// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREDOCKERFILEBUILDER001

using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.ApplicationModel.Docker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Generates the multi-stage Dockerfile that publishes a <see cref="RustAppResource"/>.
/// </summary>
/// <remarks>
/// The container build is the only build: nothing here compiles the crate on the host. The single piece of
/// host-side information the Dockerfile needs is the name of the binary cargo will produce, which comes from
/// <c>cargo metadata</c> — a manifest query that neither compiles nor downloads dependencies.
/// </remarks>
internal static class RustDockerfileGenerator
{
    public static async Task WriteAsync(RustAppResource resource, string appDirectory, DockerfileBuilderCallbackContext context)
    {
        var logger = context.Services.GetService<ILogger<RustAppResource>>();

        // Cargo args must come from the same annotation pipeline that run mode uses, otherwise
        // WithCargoArgs/WithCargoFeatures configuration silently changes meaning at publish time. They are
        // read from `resource` rather than context.Resource because the latter is the ContainerResource that
        // PublishAsDockerFile substitutes in, which does not carry the Rust annotations.
        var cargoArgs = await ResolvePublishCargoArgsAsync(resource, context.CancellationToken).ConfigureAwait(false);

        // Target selection comes from the options annotation rather than from the argument list: those are
        // the values that decide which file ends up under target/, and reading them here keeps publish in
        // step with whatever the WithCargo* methods emitted into the argument list.
        var options = resource.TryGetLastAnnotation<RustCargoOptionsAnnotation>(out var cargoOptions)
            ? cargoOptions
            : new RustCargoOptionsAnnotation();

        var metadata = await CargoMetadataReader.ReadAsync(resource, appDirectory, options.ManifestPath, context.CancellationToken).ConfigureAwait(false);
        var target = RustCargoTargetResolver.Resolve(metadata, options, options.PublishProfileDirectory, resource.Name);

        var baseImageAnnotation = ResolveBaseImageAnnotation(resource, context);
        var images = RustPublishImageResolver.Resolve(
            baseImageAnnotation?.BuildImage,
            baseImageAnnotation?.RuntimeImage,
            appDirectory,
            options.Target,
            resource.Name);

        var buildStage = context.Builder
            .From(images.BuildImage, "build")
            .WorkDir("/app");

        if (images.BuildImageIsAlpine)
        {
            // The rust:*-alpine images ship the Rust toolchain but no C toolchain. Any crate with native
            // dependencies (ring and aws-lc-sys via rustls, openssl-sys, and anything using the cc crate)
            // fails to link without these. Installing them unconditionally keeps the common TLS/OTLP
            // configuration working out of the box.
            // See https://github.com/rust-lang/docker-rust/issues/85
            buildStage.Run("apk add --no-cache musl-dev gcc");
        }

        if (target.Target is { } triple)
        {
            // A cross target's standard library is not present in the base image, so it has to be installed
            // before cargo can build for it.
            buildStage.Run($"rustup target add {ShellQuote(triple)}");
        }

        buildStage
            .Copy(".", ".")
            // Cache the downloaded crate registry across builds. The target directory is deliberately NOT a
            // cache mount: cache mounts are not part of the resulting layer, so the COPY --from below would
            // not be able to see the binary.
            // CARGO_HOME is /usr/local/cargo in the official rust images; a cache mount on a path a custom
            // build image does not use is harmless.
            .RunWithMounts(
                BuildCargoCommand(cargoArgs),
                "type=cache,target=/usr/local/cargo/registry");

        // Add intermediate FROM stages for any container files sources (e.g. FROM frontend AS frontend_stage).
        context.Builder.AddContainerFilesStages(context.Resource, logger);

        var runtimeStage = context.Builder.From(images.RuntimeImage);

        // The default runtime image is Alpine, so the hardening steps below use apk and BusyBox
        // adduser/addgroup flags. A caller-supplied runtime image can be any distro (for example
        // debian:bookworm-slim when pairing with a glibc build image), where `apk` does not exist and
        // `adduser -S` is not valid syntax.
        if (images.RuntimeImageIsAlpine)
        {
            runtimeStage
                .Run("apk --no-cache add ca-certificates tzdata")
                .Run("addgroup -S app && adduser -S -G app app");
        }
        else
        {
            // Debian/Ubuntu and other glibc-based images use groupadd/useradd.
            runtimeStage.Run("groupadd --system --gid 999 app && useradd --system --gid 999 --uid 999 --no-create-home app");
        }

        runtimeStage
            .WorkDir("/app")
            // Add COPY --from=<source> instructions for each container files source.
            .AddContainerFiles(context.Resource, "/app", logger)
            // RelativePath is relative to cargo's target directory, which inside the build stage is
            // /app/target because the crate was copied to /app.
            .CopyFrom("build", $"/app/target/{target.RelativePath}", $"/app/{target.Name}")
            .User("app")
            .Entrypoint([$"/app/{target.Name}"]);
    }

    // Evaluates every cargo args callback exactly as run mode does, then ensures the result selects an
    // optimized build. --release is only appended when the resource has chosen neither a profile nor a
    // release build, so an explicit --profile is preserved rather than conflicting with a hard-coded
    // --release (cargo rejects the two together).
    private static async Task<List<string>> ResolvePublishCargoArgsAsync(RustAppResource resource, CancellationToken cancellationToken)
    {
        var args = new List<string>();

        foreach (var annotation in resource.Annotations.OfType<RustCargoArgsCallbackAnnotation>())
        {
            await annotation.Callback(new RustCargoArgsCallbackContext(args, cancellationToken)).ConfigureAwait(false);
        }

        var cargoArgs = args.Where(static arg => arg.Length > 0).ToList();

        var alreadyOptimized = resource.TryGetLastAnnotation<RustCargoOptionsAnnotation>(out var options)
            && (options.ReleaseBuild || options.Profile is not null);

        if (!alreadyOptimized)
        {
            cargoArgs.Add("--release");
        }

        return cargoArgs;
    }

    private static string BuildCargoCommand(List<string> cargoArgs)
        => string.Join(" ", new[] { "cargo", "build" }.Concat(cargoArgs.Select(ShellQuote)));

    // Dockerfile RUN uses the shell form (/bin/sh -c), so user-supplied values such as bin target and feature
    // names must be quoted to avoid changing the command's meaning. Already-safe tokens (notably cargo's own
    // flags) are left bare so the generated Dockerfile stays readable.
    private static string ShellQuote(string value)
    {
        if (value.Length > 0 && value.All(static c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or '/' or '=' or ',' or '+' or ':'))
        {
            return value;
        }

        // Single quotes suppress all shell expansion. An embedded single quote is emitted by closing the
        // quoted run, escaping the quote, then reopening: don't => 'don'\''t'.
        return $"'{value.Replace("'", "'\\''")}'";
    }

    // WithDockerfileBaseImage may be applied either to the Rust resource builder or, inside the
    // PublishAsDockerFile callback, to the substituted container resource. Check both so the override works
    // wherever the user attaches it.
    private static DockerfileBaseImageAnnotation? ResolveBaseImageAnnotation(RustAppResource resource, DockerfileBuilderCallbackContext context)
        => context.Resource.Annotations.OfType<DockerfileBaseImageAnnotation>().LastOrDefault()
            ?? resource.Annotations.OfType<DockerfileBaseImageAnnotation>().LastOrDefault();
}

#pragma warning restore ASPIREDOCKERFILEBUILDER001
