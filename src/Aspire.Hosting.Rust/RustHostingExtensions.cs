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
            .WithVSCodeDebugging()
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
            .PublishAsDockerFile(containerBuilder =>
            {
                if (File.Exists(Path.Combine(appDirectory, "Dockerfile")))
                {
                    return;
                }

                containerBuilder.WithDockerfileBuilder(appDirectory, context =>
                {
                    var rustVersion = RustVersionDetector.DetectVersion(appDirectory) ?? "1.89";
                    var binaryName = ResolvePublishBinaryName(resource);

                    context.Builder
                        .From($"rust:{rustVersion}-alpine", "build")
                        .WorkDir("/app")
                        .Copy(".", ".")
                        .Run("cargo build --release");

                    context.Builder
                        .From("alpine:latest")
                        .Run("apk --no-cache add ca-certificates tzdata")
                        .Run("addgroup -S app && adduser -S -G app app")
                        .WorkDir("/app")
                        .CopyFrom("build", $"/app/target/release/{binaryName}", $"/app/{binaryName}")
                        .User("app")
                        .Entrypoint([$"/app/{binaryName}"]);
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

    private static string ResolvePublishBinaryName(RustAppResource resource)
    {
        return resource.TryGetLastAnnotation<RustCargoOptionsAnnotation>(out var options) && options.BinTarget is { } binTarget
            ? binTarget
            : resource.Name;
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
