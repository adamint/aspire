// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREPIPELINES001
#pragma warning disable ASPIREUSERSECRETS001
#pragma warning disable ASPIREFILESYSTEM001

using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Eventing;
using Aspire.Hosting.Pipelines;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Aspire.Hosting.Testing;

/// <summary>
/// Methods for creating distributed application instances for testing purposes.
/// </summary>
public static class DistributedApplicationTestingBuilder
{
    private const string DashboardTestingPublishModeExceptionMessage = "Dashboard testing is not supported in publish mode.";

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <typeparam name="TEntryPoint">
    /// A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.
    /// </typeparam>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync<TEntryPoint>(CancellationToken cancellationToken = default)
        where TEntryPoint : class
        => CreateAsync(typeof(TEntryPoint), cancellationToken);

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/> using the specified testing options.
    /// </summary>
    /// <typeparam name="TEntryPoint">
    /// A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.
    /// </typeparam>
    /// <param name="options">The options that configure behavior selected while the underlying builder is constructed.</param>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="options"/> or <paramref name="args"/> is <see langword="null"/>, or when
    /// <paramref name="args"/> contains a <see langword="null"/> value.
    /// </exception>
    /// <exception cref="ArgumentException">Thrown when <paramref name="args"/> contains an empty value.</exception>
    /// <exception cref="InvalidOperationException">
    /// Thrown when <see cref="DistributedApplicationTestingBuilderOptions.EnableDashboard"/> is enabled in publish mode.
    /// </exception>
    /// <remarks>
    /// The <paramref name="args"/> parameter is required so calls such as <c>CreateAsync&lt;TEntryPoint&gt;(default)</c>
    /// continue to bind to the existing cancellation-token overload.
    /// </remarks>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync<TEntryPoint>(
        DistributedApplicationTestingBuilderOptions options,
        string[] args,
        CancellationToken cancellationToken = default)
        where TEntryPoint : class
    {
        ArgumentNullException.ThrowIfNull(options);

        return CreateAsync(typeof(TEntryPoint), options, args, cancellationToken);
    }

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <param name="entryPoint">A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync(Type entryPoint, CancellationToken cancellationToken = default)
        => CreateAsync(entryPoint, [], cancellationToken);

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/> using the specified testing options.
    /// </summary>
    /// <param name="entryPoint">A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.</param>
    /// <param name="options">The options that configure behavior selected while the underlying builder is constructed.</param>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="entryPoint"/>, <paramref name="options"/>, or <paramref name="args"/> is
    /// <see langword="null"/>, or when <paramref name="args"/> contains a <see langword="null"/> value.
    /// </exception>
    /// <exception cref="ArgumentException">Thrown when <paramref name="args"/> contains an empty value.</exception>
    /// <exception cref="InvalidOperationException">
    /// Thrown when <see cref="DistributedApplicationTestingBuilderOptions.EnableDashboard"/> is enabled in publish mode.
    /// </exception>
    /// <remarks>
    /// The <paramref name="args"/> parameter is required so calls such as <c>CreateAsync(entryPoint, default)</c>
    /// continue to bind to the existing cancellation-token overload.
    /// </remarks>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync(
        Type entryPoint,
        DistributedApplicationTestingBuilderOptions options,
        string[] args,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);

        return CreateAsyncCore(entryPoint, args, options.EnableDashboard, (_, __) => { }, cancellationToken);
    }

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <typeparam name="TEntryPoint">
    /// A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.
    /// </typeparam>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync<TEntryPoint>(string[] args, CancellationToken cancellationToken = default)
        where TEntryPoint : class
        => CreateAsync(typeof(TEntryPoint), args, (_, __) => { }, cancellationToken);

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <param name="entryPoint">A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.</param>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync(Type entryPoint, string[] args, CancellationToken cancellationToken = default)
        => CreateAsync(entryPoint, args, (_, __) => { }, cancellationToken);

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <typeparam name="TEntryPoint">
    /// A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.
    /// </typeparam>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="configureBuilder">The delegate used to configure the builder.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static Task<IDistributedApplicationTestingBuilder> CreateAsync<TEntryPoint>(string[] args, Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder, CancellationToken cancellationToken = default)
        => CreateAsync(typeof(TEntryPoint), args, configureBuilder, cancellationToken);

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <param name="entryPoint">A type in the entry point assembly of the target Aspire AppHost. Typically, the Program class can be used.</param>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="configureBuilder">The delegate used to configure the builder.</param>
    /// <param name="cancellationToken">The <see cref="CancellationToken"/>.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    [SuppressMessage("ApiDesign", "RS0026:Do not add multiple public overloads with optional parameters", Justification = "Generic and non-generic")]
    public static async Task<IDistributedApplicationTestingBuilder> CreateAsync(Type entryPoint, string[] args, Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder, CancellationToken cancellationToken = default)
        => await CreateAsyncCore(entryPoint, args, enableDashboard: false, configureBuilder, cancellationToken).ConfigureAwait(false);

    private static async Task<IDistributedApplicationTestingBuilder> CreateAsyncCore(
        Type entryPoint,
        string[] args,
        bool enableDashboard,
        Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(entryPoint);
        ThrowIfNullOrContainsIsNullOrEmpty(args);
        ArgumentNullException.ThrowIfNull(configureBuilder, nameof(configureBuilder));

        var factory = new SuspendingDistributedApplicationFactory(entryPoint, args, enableDashboard, configureBuilder);
        try
        {
            return await factory.CreateBuilderAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await factory.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    public static IDistributedApplicationTestingBuilder Create(params string[] args)
        => Create(args, (_, __) => { });

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/> using the specified testing options.
    /// </summary>
    /// <param name="options">The options that configure behavior selected while the underlying builder is constructed.</param>
    /// <param name="args">The command line arguments to use when building the distributed application.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="options"/> or <paramref name="args"/> is <see langword="null"/>, or when
    /// <paramref name="args"/> contains a <see langword="null"/> value.
    /// </exception>
    /// <exception cref="ArgumentException">Thrown when <paramref name="args"/> contains an empty value.</exception>
    /// <exception cref="InvalidOperationException">
    /// Thrown when <see cref="DistributedApplicationTestingBuilderOptions.EnableDashboard"/> is enabled in publish mode.
    /// </exception>
    /// <remarks>
    /// The <paramref name="args"/> parameter is required so calls such as <c>Create(default)</c> continue to bind to
    /// the existing command-line-arguments overload.
    /// </remarks>
    public static IDistributedApplicationTestingBuilder Create(
        DistributedApplicationTestingBuilderOptions options,
        string[] args)
    {
        ArgumentNullException.ThrowIfNull(options);

        return CreateCore(args, options.EnableDashboard, (_, __) => { });
    }

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="configureBuilder">The delegate used to configure the builder.</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    public static IDistributedApplicationTestingBuilder Create(string[] args, Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder)
        => CreateCore(args, enableDashboard: false, configureBuilder);

    private static IDistributedApplicationTestingBuilder CreateCore(
        string[] args,
        bool enableDashboard,
        Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder,
        Assembly? appHostAssembly = null)
    {
        ThrowIfNullOrContainsIsNullOrEmpty(args);
        ArgumentNullException.ThrowIfNull(configureBuilder);

        return new TestingBuilder(args, enableDashboard, configureBuilder, appHostAssembly);
    }

    /// <summary>
    /// Creates a new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </summary>
    /// <param name="args">The command line arguments to pass to the entry point.</param>
    /// <param name="configureBuilder">The delegate used to configure the builder.</param>
    /// <param name="appHostAssembly">The assembly of app host</param>
    /// <returns>
    /// A new instance of <see cref="IDistributedApplicationTestingBuilder"/>.
    /// </returns>
    internal static IDistributedApplicationTestingBuilder Create(
        string[] args,
        Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder,
        Assembly appHostAssembly)
        => CreateCore(args, enableDashboard: false, configureBuilder, appHostAssembly);

    private static void ConfigureDashboardTesting(
        DistributedApplicationOptions applicationOptions,
        HostApplicationBuilderSettings hostBuilderOptions,
        bool enableDashboard)
    {
        if (!enableDashboard)
        {
            return;
        }

        applicationOptions.DisableDashboard = false;

        // Command-line configuration has higher precedence than the configuration sources supplied through
        // HostApplicationBuilderSettings. Append this after the AppHost callback so creation-time arguments and
        // configuration cannot select anonymous dashboard authentication before testing defaults are reapplied.
        hostBuilderOptions.Args =
        [
            .. (hostBuilderOptions.Args ?? applicationOptions.Args ?? []),
            $"{KnownConfigNames.DashboardUnsecuredAllowAnonymous}=false"
        ];
        applicationOptions.Args = hostBuilderOptions.Args;

        hostBuilderOptions.Configuration ??= new();
        AddDashboardTestingConfiguration(hostBuilderOptions.Configuration);
    }

    private static void ConfigureDashboardTesting(IDistributedApplicationBuilder builder, bool enableDashboard)
    {
        if (!enableDashboard)
        {
            return;
        }

        if (builder.ExecutionContext.IsPublishMode)
        {
            throw new InvalidOperationException(DashboardTestingPublishModeExceptionMessage);
        }

        // Apply these after the builder has loaded environment variables and command-line arguments so test
        // automation cannot accidentally opt back into fixed ports, anonymous access, or interactivity.
        // Callers can still override runtime settings through the returned builder; constructor-time service
        // selection, including dashboard authentication, has already completed.
        AddDashboardTestingConfiguration(builder.Configuration);

        // Enabling the dashboard changes the hosting default to wait indefinitely when a dependency becomes
        // unavailable. Tests must retain the testing builder's fail-fast behavior, while a later user
        // registration can still override this default.
        builder.Services.Configure<ResourceNotificationServiceOptions>(
            options => options.DefaultWaitBehavior = WaitBehavior.StopOnResourceUnavailable);
    }

    private static void AddDashboardTestingConfiguration(IConfigurationBuilder configuration)
    {
        configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DcpPublisher:RandomizePorts"] = "true",
            [KnownAspNetCoreConfigNames.Urls] = "http://127.0.0.1:0",
            [KnownConfigNames.DashboardOtlpGrpcEndpointUrl] = "http://127.0.0.1:0",
            [KnownConfigNames.DashboardOtlpHttpEndpointUrl] = "http://127.0.0.1:0",
            [KnownConfigNames.ResourceServiceEndpointUrl] = "http://127.0.0.1:0",
            [KnownConfigNames.AllowUnsecuredTransport] = "true",
            [KnownConfigNames.DashboardUnsecuredAllowAnonymous] = "false",
            [KnownConfigNames.InteractivityEnabled] = "false"
        });
    }

    private static void ThrowIfNullOrContainsIsNullOrEmpty(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);
        foreach (var arg in args)
        {
            if (string.IsNullOrEmpty(arg))
            {
                var values = string.Join(", ", args);
                if (arg is null)
                {
                    throw new ArgumentNullException(nameof(args), $"Array params contains null item: [{values}]");
                }
                throw new ArgumentException($"Array params contains empty item: [{values}]", nameof(args));
            }
        }
    }

    private sealed class SuspendingDistributedApplicationFactory(
        Type entryPoint,
        string[] args,
        bool enableDashboard,
        Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder)
        : DistributedApplicationFactory(entryPoint, args)
    {
        private readonly SemaphoreSlim _continueBuilding = new(0);
        private int _buildingContinuationState;

        public async Task<IDistributedApplicationTestingBuilder> CreateBuilderAsync(CancellationToken cancellationToken)
        {
            var innerBuilder = await ResolveBuilderAsync(cancellationToken).ConfigureAwait(false);
            ConfigureDashboardTesting(innerBuilder, enableDashboard);
            return new Builder(this, innerBuilder);
        }

        protected override void OnBuilderCreating(DistributedApplicationOptions applicationOptions, HostApplicationBuilderSettings hostOptions)
        {
            base.OnBuilderCreating(applicationOptions, hostOptions);
            configureBuilder(applicationOptions, hostOptions);
            ConfigureDashboardTesting(applicationOptions, hostOptions, enableDashboard);
        }

        protected override void OnBuilding(DistributedApplicationBuilder applicationBuilder)
        {
            base.OnBuilding(applicationBuilder);

            // Wait until the owner signals that building can continue by calling BuildAsync().
            _continueBuilding.Wait();
            if (Volatile.Read(ref _buildingContinuationState) == 2)
            {
                throw new ObjectDisposedException(
                    nameof(IDistributedApplicationTestingBuilder),
                    "The testing builder was disposed before the application was built.");
            }
        }

        public async Task<DistributedApplication> BuildAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var previousState = Interlocked.CompareExchange(ref _buildingContinuationState, 1, 0);
            ObjectDisposedException.ThrowIf(previousState == 2, this);
            if (previousState == 0)
            {
                _continueBuilding.Release();
            }

            try
            {
                return await ResolveApplicationAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Once the AppHost has been released, it can still finish building after the caller stops waiting.
                // Wait for that application and dispose the factory before propagating cancellation so it cannot
                // continue running without an owner.
                try
                {
                    _ = await ResolveApplicationAsync(CancellationToken.None).ConfigureAwait(false);
                }
                finally
                {
                    await DisposeAsync().ConfigureAwait(false);
                }

                throw;
            }
            catch (OperationCanceledException) when (Volatile.Read(ref _buildingContinuationState) == 2)
            {
                throw new ObjectDisposedException(
                    nameof(IDistributedApplicationTestingBuilder),
                    "The testing builder was disposed before the application was built.");
            }
        }

        public override async ValueTask DisposeAsync()
        {
            PrepareForDisposal();
            await base.DisposeAsync().ConfigureAwait(false);
        }

        public override void Dispose()
        {
            PrepareForDisposal();
            base.Dispose();
        }

        private void PrepareForDisposal()
        {
            var previousState = Interlocked.Exchange(ref _buildingContinuationState, 2);
            if (previousState == 0)
            {
                // Abort on the AppHost entry-point thread instead of allowing a rejected or canceled
                // builder to continue into Build() after the factory has already been disposed.
                _continueBuilding.Release();
            }
        }

        private sealed class Builder(SuspendingDistributedApplicationFactory factory, DistributedApplicationBuilder innerBuilder) : IDistributedApplicationTestingBuilder
        {
            public ConfigurationManager Configuration => innerBuilder.Configuration;

            public string AppHostDirectory => innerBuilder.AppHostDirectory;

            public Assembly? AppHostAssembly => innerBuilder.AppHostAssembly;

            public IHostEnvironment Environment => innerBuilder.Environment;

            public IServiceCollection Services => innerBuilder.Services;

            public DistributedApplicationExecutionContext ExecutionContext => innerBuilder.ExecutionContext;

            public IResourceCollection Resources => innerBuilder.Resources;

            public IDistributedApplicationEventing Eventing => innerBuilder.Eventing;

            public IDistributedApplicationPipeline Pipeline => innerBuilder.Pipeline;

            public IUserSecretsManager UserSecretsManager => innerBuilder.UserSecretsManager;

            public IResourceBuilder<T> AddResource<T>(T resource) where T : IResource => innerBuilder.AddResource(resource);

            public DistributedApplication Build() => BuildAsync(CancellationToken.None).Result;

            public async Task<DistributedApplication> BuildAsync(CancellationToken cancellationToken)
            {
                var innerApp = await factory.BuildAsync(cancellationToken).ConfigureAwait(false);
                return new DelegatedDistributedApplication(new DelegatedHost(factory, innerApp));
            }

            public IResourceBuilder<T> CreateResourceBuilder<T>(T resource) where T : IResource => innerBuilder.CreateResourceBuilder(resource);

            public void Dispose()
            {
                factory.Dispose();
            }

            public async ValueTask DisposeAsync()
            {
                await factory.DisposeAsync().ConfigureAwait(false);
            }
        }

        private sealed class DelegatedDistributedApplication(DelegatedHost host) : DistributedApplication(host)
        {
            private readonly DelegatedHost _host = host;

            public override async Task RunAsync(CancellationToken cancellationToken)
            {
                // Avoid calling the base here, since it will execute the pre-start hooks
                // before calling the corresponding host method, which also executes the same pre-start hooks.
                await _host.RunAsync(cancellationToken).ConfigureAwait(false);
            }

            public override async Task StartAsync(CancellationToken cancellationToken)
            {
                // Avoid calling the base here, since it will execute the pre-start hooks
                // before calling the corresponding host method, which also executes the same pre-start hooks.
                await _host.StartAsync(cancellationToken).ConfigureAwait(false);
            }

            public override async Task StopAsync(CancellationToken cancellationToken)
            {
                await _host.StopAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        private sealed class DelegatedHost(SuspendingDistributedApplicationFactory appFactory, DistributedApplication innerApp) : IHost, IAsyncDisposable
        {
            public IServiceProvider Services => innerApp.Services;

            public void Dispose()
            {
                appFactory.Dispose();
            }

            public async ValueTask DisposeAsync()
            {
                await appFactory.DisposeAsync().ConfigureAwait(false);
            }

            public async Task StartAsync(CancellationToken cancellationToken)
            {
                await appFactory.StartAsync(cancellationToken).ConfigureAwait(false);
            }

            public async Task StopAsync(CancellationToken cancellationToken)
            {
                await appFactory.DisposeAsync().AsTask().WaitAsync(cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private sealed class TestingBuilder(
        string[] args,
        bool enableDashboard,
        Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder,
        Assembly? appHostAssembly = null)
        : IDistributedApplicationTestingBuilder
    {
        private readonly DistributedApplicationBuilder _innerBuilder = CreateInnerBuilder(args, enableDashboard, configureBuilder, appHostAssembly);
        private DistributedApplication? _app;

        private static DistributedApplicationBuilder CreateInnerBuilder(
            string[] args,
            bool enableDashboard,
            Action<DistributedApplicationOptions, HostApplicationBuilderSettings> configureBuilder,
            Assembly? appHostAssembly = null)
        {
            var builder = TestingBuilderFactory.CreateBuilder(args, onConstructing: (applicationOptions, hostBuilderOptions) =>
            {
                Assembly appAssembly;
                if (appHostAssembly is not null && GetDcpCliPath(appHostAssembly) is { Length: > 0 })
                {
                    appAssembly = appHostAssembly;
                }
                else
                {
                    appAssembly = FindApplicationAssembly();
                }

                DistributedApplicationFactory.ConfigureBuilder(args, applicationOptions, hostBuilderOptions, appAssembly, (options, settings) =>
                {
                    configureBuilder(options, settings);
                    ConfigureDashboardTesting(options, settings, enableDashboard);
                });
            });

            ConfigureDashboardTesting(builder, enableDashboard);

            if (!builder.Configuration.GetValue(KnownConfigNames.TestingDisableHttpClient, false))
            {
                builder.Services.AddHttpClient();
                builder.Services.ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler());
            }

            return builder;

            static Assembly FindApplicationAssembly()
            {
                // Walk the stack trace to find the first assembly that has the 'dcpclipath' metadata attribute.
                // This will be selected as the application host assembly. DCP is necessary to launch the application.
                var stackTrace = new StackTrace();
                foreach (var stackFrame in stackTrace.GetFrames())
                {
                    var asm = stackFrame.GetMethod()?.DeclaringType?.Assembly;
                    if (asm is not null && GetDcpCliPath(asm) is { Length: > 0 })
                    {
                        return asm;
                    }
                }

                throw new InvalidOperationException("No application host assembly was found. Ensure that you have a project that references the 'Aspire.Hosting.AppHost' package and imports the 'Aspire.AppHost.Sdk' SDK.");
            }

            static string? GetDcpCliPath(Assembly? assembly)
            {
                var assemblyMetadata = assembly?.GetCustomAttributes<AssemblyMetadataAttribute>();
                return assemblyMetadata?.FirstOrDefault(m => string.Equals(m.Key, "dcpclipath", StringComparison.OrdinalIgnoreCase))?.Value;
            }
        }

        public ConfigurationManager Configuration => _innerBuilder.Configuration;

        public string AppHostDirectory => _innerBuilder.AppHostDirectory;

        public Assembly? AppHostAssembly => _innerBuilder.AppHostAssembly;

        public IHostEnvironment Environment => _innerBuilder.Environment;

        public IServiceCollection Services => _innerBuilder.Services;

        public DistributedApplicationExecutionContext ExecutionContext => _innerBuilder.ExecutionContext;

        public IResourceCollection Resources => _innerBuilder.Resources;

        public IDistributedApplicationEventing Eventing => _innerBuilder.Eventing;

        public IDistributedApplicationPipeline Pipeline => _innerBuilder.Pipeline;

        public IUserSecretsManager UserSecretsManager => _innerBuilder.UserSecretsManager;

        public IResourceBuilder<T> AddResource<T>(T resource) where T : IResource => _innerBuilder.AddResource(resource);

        [MemberNotNull(nameof(_app))]
        public DistributedApplication Build()
        {
            return _app = _innerBuilder.Build();
        }

        public Task<DistributedApplication> BuildAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Build());
        }

        public IResourceBuilder<T> CreateResourceBuilder<T>(T resource) where T : IResource => _innerBuilder.CreateResourceBuilder(resource);

        public void Dispose()
        {
            if (_app is null)
            {
                try
                {
                    Build();
                }
                catch
                {
                    // Suppress.
                }
            }

            if (_app is { } app)
            {
                app.Dispose();
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_app is null)
            {
                try
                {
                    Build();
                }
                catch
                {
                    // Suppress.
                }
            }

            if (_app is IAsyncDisposable asyncDisposable)
            {
                await asyncDisposable.DisposeAsync().ConfigureAwait(false);
            }
        }
    }
}

/// <summary>
/// A builder for creating instances of <see cref="DistributedApplication"/> for testing purposes.
/// </summary>
public interface IDistributedApplicationTestingBuilder : IDistributedApplicationBuilder, IAsyncDisposable, IDisposable
{
    /// <inheritdoc cref="IDistributedApplicationBuilder.Configuration" />
    new ConfigurationManager Configuration => ((IDistributedApplicationBuilder)this).Configuration;

    /// <inheritdoc cref="IDistributedApplicationBuilder.AppHostDirectory" />
    new string AppHostDirectory => ((IDistributedApplicationBuilder)this).AppHostDirectory;

    /// <inheritdoc cref="IDistributedApplicationBuilder.AppHostAssembly" />
    new Assembly? AppHostAssembly => ((IDistributedApplicationBuilder)this).AppHostAssembly;

    /// <inheritdoc cref="IDistributedApplicationBuilder.Environment" />
    new IHostEnvironment Environment => ((IDistributedApplicationBuilder)this).Environment;

    /// <inheritdoc cref="IDistributedApplicationBuilder.Services" />
    new IServiceCollection Services => ((IDistributedApplicationBuilder)this).Services;

    /// <inheritdoc cref="IDistributedApplicationBuilder.ExecutionContext" />
    new DistributedApplicationExecutionContext ExecutionContext => ((IDistributedApplicationBuilder)this).ExecutionContext;

    /// <inheritdoc cref="IDistributedApplicationBuilder.Eventing" />
    new IDistributedApplicationEventing Eventing => ((IDistributedApplicationBuilder)this).Eventing;

    /// <inheritdoc cref="IDistributedApplicationBuilder.Pipeline" />
    new IDistributedApplicationPipeline Pipeline => ((IDistributedApplicationBuilder)this).Pipeline;

    /// <inheritdoc cref="IDistributedApplicationBuilder.Resources" />
    new IResourceCollection Resources => ((IDistributedApplicationBuilder)this).Resources;

    /// <inheritdoc cref="IDistributedApplicationBuilder.FileSystemService" />
    new IFileSystemService FileSystemService => ((IDistributedApplicationBuilder)this).FileSystemService;

    /// <inheritdoc cref="IDistributedApplicationBuilder.UserSecretsManager" />
    new IUserSecretsManager UserSecretsManager => ((IDistributedApplicationBuilder)this).UserSecretsManager;

    /// <inheritdoc cref="IDistributedApplicationBuilder.AddResource{T}(T)" />
    new IResourceBuilder<T> AddResource<T>(T resource) where T : IResource => ((IDistributedApplicationBuilder)this).AddResource(resource);

    /// <inheritdoc cref="IDistributedApplicationBuilder.CreateResourceBuilder{T}(T)" />
    new IResourceBuilder<T> CreateResourceBuilder<T>(T resource) where T : IResource => ((IDistributedApplicationBuilder)this).CreateResourceBuilder(resource);

    /// <summary>
    /// Builds and returns a new <see cref="DistributedApplication"/> instance. This can only be called once.
    /// </summary>
    /// <returns>A new <see cref="DistributedApplication"/> instance.</returns>
    Task<DistributedApplication> BuildAsync(CancellationToken cancellationToken = default);
}
