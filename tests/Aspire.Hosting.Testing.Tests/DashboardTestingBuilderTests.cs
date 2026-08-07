// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREINTERACTION001

using Aspire.Hosting.Dashboard;
using Aspire.Hosting.Dcp;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;
using TestingResources = Aspire.Hosting.Testing.Properties.Resources;

namespace Aspire.Hosting.Testing.Tests;

public class DashboardTestingBuilderTests
{
    private const string AspNetCoreUrls = "ASPNETCORE_URLS";
    private const string DashboardOtlpGrpcEndpointUrl = "ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL";
    private const string DashboardOtlpHttpEndpointUrl = "ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL";
    private const string DashboardUnsecuredAllowAnonymous = "ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS";
    private const string InteractivityEnabled = "ASPIRE_INTERACTIVITY_ENABLED";
    private const string ResourceServiceEndpointUrl = "ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL";
    private const string DashboardFrontendBrowserToken = "ASPIRE_DASHBOARD_FRONTEND_BROWSERTOKEN";
    private const string AppHostBrowserToken = "AppHost:BrowserToken";

    [Fact]
    public void DashboardIsDisabledByDefault()
    {
        var options = new DistributedApplicationTestingBuilderOptions();

        Assert.False(options.EnableDashboard);

        using var builder = DistributedApplicationTestingBuilder.Create();
        Assert.Null(builder.Services.FirstOrDefault(descriptor => descriptor.ServiceType == typeof(DashboardServiceHost)));
    }

    [Theory]
    [InlineData(CreationSurface.Generic)]
    [InlineData(CreationSurface.Type)]
    [InlineData(CreationSurface.AdHoc)]
    public async Task DashboardCanBeEnabledAtBuilderCreation(CreationSurface creationSurface)
    {
        var builder = await CreateDashboardBuilderAsync(creationSurface, []);

        Assert.Single(builder.Services, descriptor => descriptor.ServiceType == typeof(DashboardServiceHost));
        AssertDashboardTestingDefaults(builder);

        await using var app = await builder.BuildAsync();
    }

    [Theory]
    [InlineData(CreationSurface.Generic)]
    [InlineData(CreationSurface.Type)]
    [InlineData(CreationSurface.AdHoc)]
    public async Task DashboardTestingDefaultsOverrideConfigurationPresentDuringCreation(CreationSurface creationSurface)
    {
        string[] args =
        [
            "--DcpPublisher:RandomizePorts=false",
            $"--{AspNetCoreUrls}=http://127.0.0.1:12345",
            $"--{DashboardOtlpGrpcEndpointUrl}=http://127.0.0.1:12346",
            $"--{DashboardOtlpHttpEndpointUrl}=http://127.0.0.1:12347",
            $"--{ResourceServiceEndpointUrl}=http://127.0.0.1:12348",
            $"--{DashboardUnsecuredAllowAnonymous}=true",
            $"--{InteractivityEnabled}=true"
        ];

        await using var builder = await CreateDashboardBuilderAsync(creationSurface, args);

        AssertDashboardTestingDefaults(builder);
        Assert.Equal(nameof(ResourceServiceAuthMode.ApiKey), builder.Configuration["AppHost:ResourceService:AuthMode"]);
    }

    [Theory]
    [InlineData(CreationSurface.Generic)]
    [InlineData(CreationSurface.Type)]
    public async Task DashboardTestingDefaultsOverrideAppHostConfiguration(CreationSurface creationSurface)
    {
        await using var builder = await CreateDashboardBuilderAsync(
            creationSurface,
            ["--override-dashboard-testing-defaults"]);

        AssertDashboardTestingDefaults(builder);
    }

    [Theory]
    [InlineData(CreationSurface.Generic)]
    [InlineData(CreationSurface.Type)]
    [InlineData(CreationSurface.AdHoc)]
    public async Task DashboardTestingGeneratesAFreshBrowserTokenPerApplication(CreationSurface creationSurface)
    {
        // A token shared by every application under test is barely better than anonymous access, and this is
        // exactly the shape an ambient ASPIRE_DASHBOARD_FRONTEND_BROWSERTOKEN on a CI agent would take.
        const string SharedToken = "shared-browser-token";
        string[] args = [$"--{DashboardFrontendBrowserToken}={SharedToken}"];

        await using var first = await CreateDashboardBuilderAsync(creationSurface, args);
        await using var second = await CreateDashboardBuilderAsync(creationSurface, args);

        var firstToken = first.Configuration[AppHostBrowserToken];
        var secondToken = second.Configuration[AppHostBrowserToken];

        Assert.NotEmpty(firstToken!);
        Assert.NotEmpty(secondToken!);
        Assert.NotEqual(SharedToken, firstToken);
        Assert.NotEqual(SharedToken, secondToken);
        Assert.NotEqual(firstToken, secondToken);
    }

    [Fact]
    public async Task DashboardTestingDefaultsAreNonInteractiveAndFailFast()
    {
        var builder = DistributedApplicationTestingBuilder.Create(CreateDashboardOptions(), []);

        await using var app = await builder.BuildAsync();

        Assert.False(app.Services.GetRequiredService<IInteractionService>().IsAvailable);
        Assert.Equal(
            WaitBehavior.StopOnResourceUnavailable,
            app.Services.GetRequiredService<IOptions<ResourceNotificationServiceOptions>>().Value.DefaultWaitBehavior);
    }

    [Fact]
    public async Task DashboardTestingDefaultWaitBehaviorCanBeOverriddenThroughOptions()
    {
        // Fail-fast is right for an unattended run, but when the dashboard is up to be looked at, waiting keeps the
        // stuck resource alive long enough to inspect instead of tearing the application down.
        var options = CreateDashboardOptions();
        options.DefaultWaitBehavior = WaitBehavior.WaitOnResourceUnavailable;

        var builder = DistributedApplicationTestingBuilder.Create(options, []);

        await using var app = await builder.BuildAsync();

        Assert.Equal(
            WaitBehavior.WaitOnResourceUnavailable,
            app.Services.GetRequiredService<IOptions<ResourceNotificationServiceOptions>>().Value.DefaultWaitBehavior);
    }

    [Fact]
    public async Task DashboardTestingDefaultsCanBeOverriddenAfterCreation()
    {
        var builder = DistributedApplicationTestingBuilder.Create(CreateDashboardOptions(), []);
        builder.Configuration[InteractivityEnabled] = "true";
        builder.Configuration["DcpPublisher:RandomizePorts"] = "false";
        builder.Configuration[AspNetCoreUrls] = "http://127.0.0.1:12345";
        builder.Services.Configure<ResourceNotificationServiceOptions>(
            options => options.DefaultWaitBehavior = WaitBehavior.WaitOnResourceUnavailable);

        await using var app = await builder.BuildAsync();

        Assert.True(app.Services.GetRequiredService<IInteractionService>().IsAvailable);
        Assert.False(app.Services.GetRequiredService<IOptions<DcpOptions>>().Value.RandomizePorts);
        Assert.Equal(
            "http://127.0.0.1:12345",
            app.Services.GetRequiredService<IOptions<DashboardOptions>>().Value.DashboardUrl);
        Assert.Equal(
            WaitBehavior.WaitOnResourceUnavailable,
            app.Services.GetRequiredService<IOptions<ResourceNotificationServiceOptions>>().Value.DefaultWaitBehavior);
    }

    [Fact]
    public async Task DashboardTestingOptionsCannotBeNull()
    {
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(null!, []));
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => DistributedApplicationTestingBuilder.CreateAsync(typeof(Projects.TestingAppHost1_AppHost), null!, []));
        Assert.Throws<ArgumentNullException>(() => DistributedApplicationTestingBuilder.Create(null!, []));
    }

    [Fact]
    public async Task ExistingDefaultCallsRemainUnambiguous()
    {
        // `default` has to keep binding to the pre-existing params string[] and CancellationToken overloads
        // rather than to the new options overloads, otherwise adding those overloads is a source-breaking change.
        // The compiler proves the binding; these assertions prove the bound overloads still behave as before.
        Assert.Throws<ArgumentNullException>(() => DistributedApplicationTestingBuilder.Create(default!));

        await using var genericBuilder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(default);
        await using var typeBuilder =
            await DistributedApplicationTestingBuilder.CreateAsync(typeof(Projects.TestingAppHost1_AppHost), default);

        Assert.Null(genericBuilder.Services.FirstOrDefault(descriptor => descriptor.ServiceType == typeof(DashboardServiceHost)));
        Assert.Null(typeBuilder.Services.FirstOrDefault(descriptor => descriptor.ServiceType == typeof(DashboardServiceHost)));

        await using var genericOptionsBuilder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                CreateDashboardOptions(),
                [],
                default);
        await using var typeOptionsBuilder =
            await DistributedApplicationTestingBuilder.CreateAsync(
                typeof(Projects.TestingAppHost1_AppHost),
                CreateDashboardOptions(),
                [],
                default);

        Assert.Single(genericOptionsBuilder.Services, descriptor => descriptor.ServiceType == typeof(DashboardServiceHost));
        Assert.Single(typeOptionsBuilder.Services, descriptor => descriptor.ServiceType == typeof(DashboardServiceHost));
    }

    [Fact]
    public async Task BuildAsyncWithPreCanceledTokenDoesNotReleaseAppHost()
    {
        var probe = TestingAppHostBuildProbe.Create();
        var builder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                [$"--block-apphost-build={probe.Id}"]);
        try
        {
            using var cancellationTokenSource = new CancellationTokenSource();
            cancellationTokenSource.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => builder.BuildAsync(cancellationTokenSource.Token));
            await Assert.ThrowsAsync<TimeoutException>(
                () => probe.BuildEntered.WaitAsync(TimeSpan.FromMilliseconds(500)));
        }
        finally
        {
            probe.ContinueBuilding();
            await builder.DisposeAsync();
            probe.Dispose();
        }
    }

    [Fact]
    public async Task BuildAsyncCancellationAfterReleaseReturnsPromptlyAndDisposesBuiltApplication()
    {
        var probe = TestingAppHostBuildProbe.Create();
        var builder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                [$"--block-apphost-build={probe.Id}"]);
        try
        {
            using var cancellationTokenSource = new CancellationTokenSource();
            var buildTask = builder.BuildAsync(cancellationTokenSource.Token);
            await probe.BuildEntered.DefaultTimeout();
            Assert.False(buildTask.IsCompleted);

            cancellationTokenSource.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => buildTask.DefaultTimeout());

            // The AppHost is still blocked inside Build(), so observing cancellation here proves BuildAsync
            // returned without waiting for the application it already released.
            Assert.False(probe.ApplicationDisposed.IsCompleted);

            probe.ContinueBuilding();

            // Promptness is already proven by the assertion above. Reclaiming the late application goes through
            // DistributedApplicationFactory.DisposeAsync, which first waits for the released AppHost entry point to
            // exit under the host's shutdown timeout, so this leg needs a budget larger than DefaultTimeout's 5s.
            await probe.ApplicationDisposed.WaitAsync(TimeSpan.FromSeconds(60));
        }
        finally
        {
            probe.ContinueBuilding();
            await builder.DisposeAsync();
            probe.Dispose();
        }
    }

    [Fact]
    public async Task BuildAsyncCancellationFollowedByDisposeStillDisposesLateApplication()
    {
        var probe = TestingAppHostBuildProbe.Create();
        var builder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                [$"--block-apphost-build={probe.Id}"]);
        try
        {
            using var cancellationTokenSource = new CancellationTokenSource();
            var buildTask = builder.BuildAsync(cancellationTokenSource.Token);
            await probe.BuildEntered.DefaultTimeout();

            cancellationTokenSource.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => buildTask.DefaultTimeout());

            // Disposing before the AppHost finishes building is the ordinary `await using` sequence. The
            // application arrives after disposal has already claimed the factory, so nothing the caller holds
            // can tear it down; the factory has to reclaim it.
            await builder.DisposeAsync().DefaultTimeout();

            probe.ContinueBuilding();

            await probe.ApplicationDisposed.DefaultTimeout();
        }
        finally
        {
            probe.ContinueBuilding();
            await builder.DisposeAsync();
            probe.Dispose();
        }
    }

    [Fact]
    public async Task BuildAsyncCancellationPreservesOperationCanceledExceptionWhenAppHostLaterFails()
    {
        var probe = TestingAppHostBuildProbe.Create();
        var builder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                [$"--block-apphost-build={probe.Id}", "--crash-after-build"]);
        try
        {
            using var cancellationTokenSource = new CancellationTokenSource();
            var buildTask = builder.BuildAsync(cancellationTokenSource.Token);
            await probe.BuildEntered.DefaultTimeout();

            cancellationTokenSource.Cancel();
            probe.ContinueBuilding();
            await probe.EntryPointFailure.DefaultTimeout();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => buildTask);
        }
        finally
        {
            probe.ContinueBuilding();
            await builder.DisposeAsync();
            probe.Dispose();
        }
    }

    [Fact]
    public async Task BuildAsyncAfterBuilderDisposedThrowsObjectDisposedException()
    {
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>();
        await builder.DisposeAsync();

        var exception = await Assert.ThrowsAsync<ObjectDisposedException>(() => builder.BuildAsync());

        Assert.Equal(nameof(IDistributedApplicationTestingBuilder), exception.ObjectName);
    }

    [Theory]
    [InlineData(CreationSurface.Generic, "--operation", "publish")]
    [InlineData(CreationSurface.Generic, "--publisher", "manifest")]
    [InlineData(CreationSurface.Type, "--operation", "publish")]
    [InlineData(CreationSurface.Type, "--publisher", "manifest")]
    [InlineData(CreationSurface.AdHoc, "--operation", "publish")]
    [InlineData(CreationSurface.AdHoc, "--publisher", "manifest")]
    public async Task DashboardTestingIsRejectedInPublishMode(
        CreationSurface creationSurface,
        string argumentName,
        string argumentValue)
    {
        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => CreatePublishBuilderAsync(creationSurface, [argumentName, argumentValue]));

        Assert.Equal(TestingResources.DashboardTestingPublishModeExceptionMessage, exception.Message);
    }

    [Fact]
    public async Task DashboardTestingIsRejectedInPublishModeWhenEnabledThroughConfigureBuilder()
    {
        // DistributedApplicationOptions.DisableDashboard = false is the older spelling of "run the dashboard", and
        // it has to reach the same rejection as the EnableDashboard option rather than silently skipping it.
        var exception = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            var builder = DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                ["--publisher", "manifest"],
                (options, _) => options.DisableDashboard = false);

            await using var created = await builder;
        });

        Assert.Equal(TestingResources.DashboardTestingPublishModeExceptionMessage, exception.Message);
    }

    private static DistributedApplicationTestingBuilderOptions CreateDashboardOptions()
    {
        return new()
        {
            EnableDashboard = true
        };
    }

    private static void AssertDashboardTestingDefaults(IDistributedApplicationTestingBuilder builder)
    {
        Assert.Equal("true", builder.Configuration["DcpPublisher:RandomizePorts"]);

        // Blank is how the product spells "assign me a free port", so these must stay empty rather than
        // carrying an explicit :0, which would be a literal fixed port.
        Assert.Equal(string.Empty, builder.Configuration[AspNetCoreUrls]);
        Assert.Equal(string.Empty, builder.Configuration[DashboardOtlpGrpcEndpointUrl]);
        Assert.Equal(string.Empty, builder.Configuration[DashboardOtlpHttpEndpointUrl]);

        Assert.Equal("http://127.0.0.1:0", builder.Configuration[ResourceServiceEndpointUrl]);
        Assert.Equal("false", builder.Configuration[DashboardUnsecuredAllowAnonymous]);
        Assert.Equal("false", builder.Configuration[InteractivityEnabled]);

        // The token has to survive all the way into AppHost:BrowserToken, which is the key the dashboard
        // actually validates against and the one GetDashboardLoginUrlAsync hands back.
        var browserToken = builder.Configuration[DashboardFrontendBrowserToken];
        Assert.NotEmpty(browserToken!);
        Assert.Equal(browserToken, builder.Configuration[AppHostBrowserToken]);
    }

    private static async Task<IDistributedApplicationTestingBuilder> CreateDashboardBuilderAsync(
        CreationSurface creationSurface,
        string[] args)
    {
        var options = CreateDashboardOptions();

        return creationSurface switch
        {
            CreationSurface.Generic => await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(options, args),
            CreationSurface.Type => await DistributedApplicationTestingBuilder.CreateAsync(typeof(Projects.TestingAppHost1_AppHost), options, args),
            CreationSurface.AdHoc => DistributedApplicationTestingBuilder.Create(options, args),
            _ => throw new ArgumentOutOfRangeException(nameof(creationSurface))
        };
    }

    private static async Task CreatePublishBuilderAsync(CreationSurface creationSurface, string[] args)
    {
        var options = CreateDashboardOptions();

        var builder = creationSurface switch
        {
            CreationSurface.Generic => await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(options, args),
            CreationSurface.Type => await DistributedApplicationTestingBuilder.CreateAsync(typeof(Projects.TestingAppHost1_AppHost), options, args),
            CreationSurface.AdHoc => DistributedApplicationTestingBuilder.Create(options, args),
            _ => throw new ArgumentOutOfRangeException(nameof(creationSurface))
        };

        await builder.DisposeAsync();
    }

    public enum CreationSurface
    {
        Generic,
        Type,
        AdHoc
    }
}
