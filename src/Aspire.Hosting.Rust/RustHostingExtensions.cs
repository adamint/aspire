// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001
#pragma warning disable ASPIREDOCKERFILEBUILDER001

using System.Diagnostics.CodeAnalysis;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Rust;

namespace Aspire.Hosting;

/// <summary>
/// Provides extension methods for adding Rust applications to an <see cref="IDistributedApplicationBuilder"/>.
/// </summary>
public static class RustHostingExtensions
{
    /// <summary>
    /// Adds a Bacon-based Rust application to the application model.
    /// </summary>
    /// <param name="builder">The <see cref="IDistributedApplicationBuilder"/> to add the resource to.</param>
    /// <param name="name">The name of the resource.</param>
    /// <param name="appDirectory">The directory containing the Rust application files.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    [AspireExport]
    public static IResourceBuilder<BaconAppResource> AddBaconApp(
        this IDistributedApplicationBuilder builder,
        [ResourceName] string name,
        string appDirectory)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(appDirectory);

        appDirectory = Path.GetFullPath(appDirectory, builder.AppHostDirectory);
        var resource = new BaconAppResource(name, appDirectory);

        return builder.AddResource(resource)
            .WithArgs("run")
            .WithRequiredCommand("bacon", "https://dystroy.org/bacon/")
            .WithRustDefaults();
    }

    /// <summary>
    /// Adds a Rust application to the application model.
    /// </summary>
    /// <param name="builder">The <see cref="IDistributedApplicationBuilder"/> to add the resource to.</param>
    /// <param name="name">The name of the resource.</param>
    /// <param name="appDirectory">The directory containing the Rust application files.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    [AspireExport]
    public static IResourceBuilder<RustAppResource> AddRustApp(
        this IDistributedApplicationBuilder builder,
        [ResourceName] string name,
        string appDirectory)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(appDirectory);

        appDirectory = Path.GetFullPath(appDirectory, builder.AppHostDirectory);
        var resource = new RustAppResource(name, appDirectory);

        return builder.AddResource(resource)
            .WithRequiredCommand("cargo", "https://www.rust-lang.org/tools/install")
            .WithRustDefaults()
            .WithCargoArgs(context => AddInitialCargoArgs(resource, context.Args))
            .WithArgs(async context =>
            {
                context.Args.Add("run");

                foreach (var annotation in context.Resource.Annotations.OfType<RustCargoArgsCallbackAnnotation>())
                {
                    await annotation.Callback(new RustCargoArgsCallbackContext(context.Args, context.CancellationToken)).ConfigureAwait(false);
                }

                context.Args.Add("--");
            })
            // Must be registered after the cargo args above, otherwise the debug args filter has
            // nothing to strip. See https://github.com/microsoft/aspire/issues/18929
            .WithVSCodeDebugging()
            .PublishAsDockerFile(containerBuilder =>
            {
                if (File.Exists(Path.Combine(appDirectory, "Dockerfile")))
                {
                    return;
                }

                containerBuilder.WithDockerfileBuilder(appDirectory, async context =>
                {
                    // Cargo args must come from the same annotation pipeline that run mode uses, otherwise
                    // WithCargoArgs/WithCargoFeatures configuration silently changes meaning at publish time.
                    // They are read from `resource` (the original RustAppResource captured by this closure)
                    // because context.Resource is the ContainerResource that PublishAsDockerFile substitutes
                    // in, which does not carry the Rust annotations.
                    var cargoArgs = await ResolvePublishCargoArgsAsync(resource, context.CancellationToken).ConfigureAwait(false);

                    var baseImageAnnotation = ResolveBaseImageAnnotation(resource, context);
                    var buildImage = ResolveBuildImage(baseImageAnnotation?.BuildImage, appDirectory, resource.Name);
                    var runtimeImage = baseImageAnnotation?.RuntimeImage ?? "alpine:latest";

                    var explicitBinTarget = resource.TryGetLastAnnotation<RustCargoOptionsAnnotation>(out var cargoOptions)
                        ? cargoOptions.BinTarget
                        : null;
                    var binaryName = ResolvePublishBinaryName(explicitBinTarget, appDirectory, resource.Name);
                    var profileDirectory = ResolveProfileDirectory(cargoArgs);

                    var buildStage = context.Builder
                        .From(buildImage, "build")
                        .WorkDir("/app");

                    if (buildImage.Contains("alpine", StringComparison.OrdinalIgnoreCase))
                    {
                        // The rust:*-alpine images ship the Rust toolchain but no C toolchain. Any crate with
                        // native dependencies (ring and aws-lc-sys via rustls, openssl-sys, and anything using
                        // the cc crate) fails to link without these. Installing them unconditionally keeps the
                        // common TLS/OTLP configuration working out of the box.
                        // See https://github.com/rust-lang/docker-rust/issues/85
                        buildStage.Run("apk add --no-cache musl-dev gcc");
                    }

                    buildStage
                        .Copy(".", ".")
                        .Run(BuildCargoCommand(cargoArgs));

                    var runtimeStage = context.Builder.From(runtimeImage);

                    // The default runtime image is Alpine, so the hardening steps below use apk and
                    // BusyBox adduser/addgroup flags. A caller-supplied runtime image can be any distro
                    // (for example debian:bookworm-slim when pairing with a glibc build image), where
                    // `apk` does not exist and `adduser -S` is not valid syntax, so emitting them
                    // unconditionally would produce a Dockerfile that always fails to build. When the
                    // runtime image is not Alpine the caller owns provisioning certificates and a
                    // non-root user in their own image.
                    var runtimeIsAlpine = runtimeImage.Contains("alpine", StringComparison.OrdinalIgnoreCase);
                    if (runtimeIsAlpine)
                    {
                        runtimeStage
                            .Run("apk --no-cache add ca-certificates tzdata")
                            .Run("addgroup -S app && adduser -S -G app app");
                    }

                    runtimeStage
                        .WorkDir("/app")
                        .CopyFrom("build", $"/app/target/{profileDirectory}/{binaryName}", $"/app/{binaryName}");

                    // Only switch to the unprivileged user when this Dockerfile is the thing that created
                    // it, otherwise the container fails to start with an unknown-user error.
                    if (runtimeIsAlpine)
                    {
                        runtimeStage.User("app");
                    }

                    runtimeStage.Entrypoint([$"/app/{binaryName}"]);
                });
            });
    }

    /// <summary>
    /// Adds command-line arguments to the cargo command used by a Rust application.
    /// </summary>
    /// <typeparam name="T">The resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="args">The cargo arguments to append before <c>--</c>.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/> for chaining.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    [AspireExport]
    public static IResourceBuilder<T> WithCargoArgs<T>(this IResourceBuilder<T> builder, params string[] args)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(args);

        return builder.WithCargoArgs(context =>
        {
            foreach (var arg in args)
            {
                context.Args.Add(arg);
            }
        });
    }

    /// <summary>
    /// Adds command-line arguments to the cargo command used by a Rust application.
    /// </summary>
    /// <typeparam name="T">The resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="callback">A callback that computes cargo arguments at execution time.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/> for chaining.</returns>
    /// <remarks>This method is not available in polyglot app hosts. Use the string[] overload instead.</remarks>
    [AspireExportIgnore(Reason = "RustCargoArgsCallbackContext exposes IList<object> — not usable from polyglot hosts.")]
    public static IResourceBuilder<T> WithCargoArgs<T>(this IResourceBuilder<T> builder, Action<RustCargoArgsCallbackContext> callback)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(callback);

        return builder.WithCargoArgs(context =>
        {
            callback(context);
            return Task.CompletedTask;
        });
    }

    /// <summary>
    /// Adds command-line arguments to the cargo command used by a Rust application.
    /// </summary>
    /// <typeparam name="T">The resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="callback">A callback that computes cargo arguments at execution time.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/> for chaining.</returns>
    /// <remarks>This method is not available in polyglot app hosts. Use the string[] overload instead.</remarks>
    [AspireExportIgnore(Reason = "RustCargoArgsCallbackContext exposes IList<object> — not usable from polyglot hosts.")]
    public static IResourceBuilder<T> WithCargoArgs<T>(this IResourceBuilder<T> builder, Func<RustCargoArgsCallbackContext, Task> callback)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(callback);

        var annotation = new RustCargoArgsCallbackAnnotation(callback);
        return builder.WithAnnotation(annotation);
    }

    /// <summary>
    /// Configures the Rust application to run using release optimization.
    /// </summary>
    /// <typeparam name="T">The resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/> for chaining.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    [AspireExport]
    public static IResourceBuilder<T> WithCargoReleaseBuild<T>(this IResourceBuilder<T> builder)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);

        GetOrAddCargoOptions(builder).ReleaseBuild = true;
        return builder;
    }

    /// <summary>
    /// Configures cargo features for the Rust application.
    /// </summary>
    /// <typeparam name="T">The resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="features">The features to enable.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/> for chaining.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    [AspireExport]
    public static IResourceBuilder<T> WithCargoFeatures<T>(this IResourceBuilder<T> builder, params string[] features)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(features);

        GetOrAddCargoOptions(builder).Features = features;
        return builder;
    }

    /// <summary>
    /// Configures the binary target to run for Rust workspace applications.
    /// </summary>
    /// <typeparam name="T">The resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="binName">The binary target name.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/> for chaining.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    [AspireExport]
    public static IResourceBuilder<T> WithCargoBinTarget<T>(this IResourceBuilder<T> builder, string binName)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(binName);

        GetOrAddCargoOptions(builder).BinTarget = binName;
        return builder;
    }

    // Gets the resource's existing RustCargoOptionsAnnotation, or creates and attaches a new one. Callers mutate
    // the returned instance's properties directly rather than adding a new annotation per call, so repeated
    // WithCargo* calls (in any order) all end up configuring the same shared annotation instance.
    private static RustCargoOptionsAnnotation GetOrAddCargoOptions<T>(IResourceBuilder<T> builder)
        where T : RustAppResource
    {
        if (!builder.Resource.TryGetLastAnnotation<RustCargoOptionsAnnotation>(out var options))
        {
            options = new RustCargoOptionsAnnotation();
            builder.WithAnnotation(options);
        }

        return options;
    }

    private static void AddInitialCargoArgs(RustAppResource resource, IList<object> args)
    {
        if (!resource.TryGetLastAnnotation<RustCargoOptionsAnnotation>(out var options))
        {
            return;
        }

        if (options.Features is { Count: > 0 } features)
        {
            args.Add("--features");
            args.Add(string.Join(",", features));
        }

        if (options.BinTarget is { } binTarget)
        {
            args.Add("--bin");
            args.Add(binTarget);
        }

        if (options.ReleaseBuild)
        {
            args.Add("--release");
        }
    }

    [Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
    internal static IResourceBuilder<T> WithVSCodeDebugging<T>(this IResourceBuilder<T> builder)
        where T : RustAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);

        return builder.WithDebugSupport(
            mode =>
            {
                var cargoArgs = new List<string>();

                foreach (var annotation in builder.Resource.Annotations.OfType<RustCargoArgsCallbackAnnotation>())
                {
                    var args = new List<object>();
                    annotation.Callback(new RustCargoArgsCallbackContext(args)).GetAwaiter().GetResult();
                    cargoArgs.AddRange(args.OfType<string>());
                }

                return new RustLaunchConfiguration
                {
                    Mode = mode,
                    WorkingDirectory = Path.GetFullPath(builder.Resource.WorkingDirectory),
                    Cargo = new RustCargoLaunchTarget
                    {
                        Args = ["build", .. cargoArgs]
                    }
                };
            },
            "rust",
            static context =>
            {
                if (context.Args is not [string runCommand, ..] || runCommand != "run")
                {
                    return;
                }

                context.Args.RemoveAt(0);

                while (context.Args is [string arg, ..])
                {
                    context.Args.RemoveAt(0);
                    if (arg == "--")
                    {
                        break;
                    }
                }
            });
    }

    // Evaluates every cargo args callback exactly as run mode does, then ensures the result selects an
    // optimized build. --release is only appended when the user has not already chosen a profile, so an
    // explicit --profile is preserved rather than conflicting with a hard-coded --release.
    private static async Task<List<string>> ResolvePublishCargoArgsAsync(RustAppResource resource, CancellationToken cancellationToken)
    {
        var args = new List<object>();

        foreach (var annotation in resource.Annotations.OfType<RustCargoArgsCallbackAnnotation>())
        {
            await annotation.Callback(new RustCargoArgsCallbackContext(args, cancellationToken)).ConfigureAwait(false);
        }

        var cargoArgs = args.Select(static arg => arg?.ToString() ?? string.Empty)
            .Where(static arg => arg.Length > 0)
            .ToList();

        if (!cargoArgs.Contains("--release") && FindProfile(cargoArgs) is null)
        {
            cargoArgs.Add("--release");
        }

        return cargoArgs;
    }

    private static string BuildCargoCommand(List<string> cargoArgs)
        => string.Join(" ", new[] { "cargo", "build" }.Concat(cargoArgs.Select(ShellQuote)));

    // Dockerfile RUN uses the shell form (/bin/sh -c), so user-supplied values such as bin target and
    // feature names must be quoted to avoid changing the command's meaning. Mirrors the ShellQuote
    // helper in Aspire.Hosting.Go, but leaves already-safe tokens (notably cargo's own flags) bare so
    // the generated Dockerfile stays readable.
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

    // Maps the selected cargo profile to its output directory under target/. Cargo's built-in dev and
    // test profiles both emit to target/debug, bench emits to target/release, and custom profiles use
    // their own name. See https://doc.rust-lang.org/cargo/reference/profiles.html
    private static string ResolveProfileDirectory(IReadOnlyList<string> cargoArgs)
    {
        if (FindProfile(cargoArgs) is not { } profile)
        {
            return "release";
        }

        return profile switch
        {
            "dev" or "test" => "debug",
            "bench" => "release",
            _ => profile
        };
    }

    private static string? FindProfile(IReadOnlyList<string> cargoArgs)
    {
        const string inlinePrefix = "--profile=";

        for (var i = 0; i < cargoArgs.Count; i++)
        {
            if (cargoArgs[i] == "--profile" && i + 1 < cargoArgs.Count)
            {
                return cargoArgs[i + 1];
            }

            if (cargoArgs[i].StartsWith(inlinePrefix, StringComparison.Ordinal))
            {
                return cargoArgs[i][inlinePrefix.Length..];
            }
        }

        return null;
    }

    // WithDockerfileBaseImage may be applied either to the Rust resource builder or, inside the
    // PublishAsDockerFile callback, to the substituted container resource. Check both so the override
    // works wherever the user attaches it.
    private static DockerfileBaseImageAnnotation? ResolveBaseImageAnnotation(RustAppResource resource, DockerfileBuilderCallbackContext context)
        => context.Resource.Annotations.OfType<DockerfileBaseImageAnnotation>().LastOrDefault()
            ?? resource.Annotations.OfType<DockerfileBaseImageAnnotation>().LastOrDefault();

    /// <summary>
    /// Resolves the build-stage base image for the generated Dockerfile.
    /// </summary>
    /// <remarks>
    /// Docker Hub publishes the official Rust images by version (<c>rust:1.89-alpine</c>,
    /// <c>rust:1.89.0-alpine</c>) plus an unversioned <c>rust:alpine</c> that tracks current stable.
    /// There is no <c>rust:stable-alpine</c>, <c>rust:beta-*</c> or <c>rust:nightly-*</c> tag, so a named
    /// channel cannot simply be substituted into the tag.
    /// </remarks>
    internal static string ResolveBuildImage(string? explicitBuildImage, string appDirectory, string resourceName)
    {
        if (explicitBuildImage is not null)
        {
            return explicitBuildImage;
        }

        var channel = RustToolchainDetector.Detect(appDirectory);
        if (channel is null)
        {
            return $"rust:{RustToolchainDetector.DefaultChannel}-alpine";
        }

        if (RustToolchainDetector.GetChannelName(channel) is { } channelName)
        {
            return channelName is "stable"
                ? "rust:alpine"
                : throw new DistributedApplicationException(
                    $"The Rust app '{resourceName}' pins the '{channel}' toolchain, but there is no official Docker image for the '{channelName}' channel. " +
                    $"Call WithDockerfileBaseImage(buildImage: \"...\") to supply an image that provides it, or pin an explicit version in rust-toolchain.toml.");
        }

        return $"rust:{channel}-alpine";
    }

    /// <summary>
    /// Resolves the file name cargo writes into <c>target/&lt;profile&gt;/</c>.
    /// </summary>
    /// <remarks>
    /// Unlike library targets, binary target names are used verbatim, so hyphens are NOT translated to
    /// underscores. See https://doc.rust-lang.org/cargo/reference/cargo-targets.html#binaries
    /// </remarks>
    internal static string ResolvePublishBinaryName(string? explicitBinTarget, string appDirectory, string resourceName)
    {
        if (explicitBinTarget is not null)
        {
            return explicitBinTarget;
        }

        var manifest = CargoManifestReader.Read(appDirectory);

        if (manifest?.BinTargetNames is { Count: > 1 } binTargets)
        {
            throw new DistributedApplicationException(
                $"The Rust app '{resourceName}' declares {binTargets.Count} [[bin]] targets in '{Path.Combine(appDirectory, "Cargo.toml")}'. " +
                $"Call WithCargoBinTarget(...) to select which binary to publish.");
        }

        if (manifest?.BinTargetNames is [var singleBinTarget])
        {
            return singleBinTarget;
        }

        // Cargo names the default binary after the package, which is frequently unrelated to the Aspire
        // resource name, so the package name must be read rather than assumed.
        if (manifest?.PackageName is { } packageName)
        {
            return packageName;
        }

        throw new DistributedApplicationException(
            $"Unable to determine the cargo binary name for the Rust app '{resourceName}' because '{Path.Combine(appDirectory, "Cargo.toml")}' " +
            $"{(manifest is null ? "was not found" : "does not declare a [package] name or a [[bin]] target")}. " +
            $"Call WithCargoBinTarget(...) to specify the binary to publish.");
    }

    // Common defaults shared by both Rust resource kinds (bacon and cargo apps): OTLP export plus
    // certificate trust so outbound TLS calls made by the app pick up the dev/test certificate bundle.
    private static IResourceBuilder<TResource> WithRustDefaults<TResource>(this IResourceBuilder<TResource> builder)
        where TResource : ExecutableResource
    {
        return builder.WithOtlpExporter()
            .WithCertificateTrustConfiguration(ctx =>
            {
                ctx.EnvironmentVariables["SSL_CERT_DIR"] = ctx.CertificateDirectoriesPath;
                ctx.EnvironmentVariables["SSL_CERT_FILE"] = ctx.CertificateBundlePath;

                return Task.CompletedTask;
            });
    }
}

#pragma warning restore ASPIREEXTENSION001
#pragma warning restore ASPIREDOCKERFILEBUILDER001
