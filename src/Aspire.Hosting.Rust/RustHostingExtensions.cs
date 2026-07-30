// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001

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
    /// Adds a Rust application to the application model.
    /// </summary>
    /// <param name="builder">The <see cref="IDistributedApplicationBuilder"/> to add the resource to.</param>
    /// <param name="name">The name of the resource.</param>
    /// <param name="appDirectory">The directory containing the Rust application files.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <ats-returns>The resource builder.</ats-returns>
    /// <remarks>
    /// <para>
    /// The resource runs <c>cargo run</c> in <paramref name="appDirectory"/>, which must contain a
    /// <c>Cargo.toml</c>. Cargo requires the two kinds of argument to be separated by <c>--</c>, so they
    /// are configured separately: <c>WithCargoArgs</c> adds arguments for cargo itself (before the
    /// separator) and <c>WithArgs</c> adds arguments for the application (after it).
    /// </para>
    /// <para>
    /// Debugging is wired up automatically. In VS Code the resource is built with <c>cargo build</c> and
    /// the resulting binary is launched under a native debugger, so the cargo arguments are applied to
    /// the build rather than to <c>cargo run</c>.
    /// </para>
    /// <para>
    /// OTLP export and dev certificate trust are configured by default. Rust does not read a port from
    /// the environment on its own, so bind to the port named by <c>WithHttpEndpoint(env: ...)</c> rather
    /// than a hard-coded one.
    /// </para>
    /// </remarks>
    /// <example>
    /// Add a Rust application to the app host and expose an HTTP endpoint:
    /// <code language="csharp">
    /// var builder = DistributedApplication.CreateBuilder(args);
    ///
    /// builder.AddRustApp("api", "../rust-api")
    ///        .WithHttpEndpoint(env: "PORT")
    ///        .WithCargoReleaseBuild();
    ///
    /// builder.Build().Run();
    /// </code>
    /// </example>
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
                // Resolve the cargo arguments once and record them: the debug launch configuration
                // reuses this list rather than invoking the user's callbacks a second time.
                var cargoArgs = new List<string>();

                foreach (var annotation in resource.Annotations.OfType<RustCargoArgsCallbackAnnotation>())
                {
                    await annotation.Callback(new RustCargoArgsCallbackContext(cargoArgs, context.CancellationToken)).ConfigureAwait(false);
                }

                resource.ResolvedCargoArgs = cargoArgs;

                context.Args.Add("run");
                foreach (var cargoArg in cargoArgs)
                {
                    context.Args.Add(cargoArg);
                }

                context.Args.Add("--");
            })
            // Must be registered after the cargo args above, otherwise the debug args filter has
            // nothing to strip. See https://github.com/microsoft/aspire/issues/18929
            .WithVSCodeDebugging();
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
    [AspireExportIgnore(Reason = "Callback-based cargo arguments are not expressible in polyglot app hosts.")]
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
    [AspireExportIgnore(Reason = "Callback-based cargo arguments are not expressible in polyglot app hosts.")]
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

    private static void AddInitialCargoArgs(RustAppResource resource, IList<string> args)
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
                // DCP resolves the resource's arguments before it asks for the launch configuration
                // (ExecutableCreator.CreateObjectAsync builds the args, then invokes this annotator),
                // so the resolved cargo arguments are reused here. That keeps the debug build identical
                // to the run command and means user cargo argument callbacks run exactly once per launch.
                var cargoArgs = builder.Resource.ResolvedCargoArgs
                    ?? throw new InvalidOperationException(
                        $"Cargo arguments for resource '{builder.Resource.Name}' have not been resolved yet. " +
                        "The debug launch configuration must be created after the resource's arguments are evaluated.");

                return new RustLaunchConfiguration
                {
                    Mode = mode,
                    WorkingDirectory = Path.GetFullPath(builder.Resource.WorkingDirectory),
                    Cargo = new RustCargoLaunchTarget
                    {
                        // The same cargo arguments run mode uses, so any target selection the user made
                        // (`--bin`, `--example`, `--package`) narrows the debug build the same way it
                        // narrows `cargo run`.
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

    // OTLP export plus certificate trust so outbound TLS calls made by the app pick up the dev/test
    // certificate bundle.
    private static IResourceBuilder<RustAppResource> WithRustDefaults(this IResourceBuilder<RustAppResource> builder)
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
