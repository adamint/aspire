// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREINTERACTION001

using Aspire.Hosting.Dashboard;
using Aspire.Hosting.Dcp;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Aspire.Hosting.Testing.Tests;

public class DashboardTestingBuilderTests
{
    private const string AspNetCoreUrls = "ASPNETCORE_URLS";
    private const string DashboardOtlpGrpcEndpointUrl = "ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL";
    private const string DashboardOtlpHttpEndpointUrl = "ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL";
    private const string DashboardUnsecuredAllowAnonymous = "ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS";
    private const string InteractivityEnabled = "ASPIRE_INTERACTIVITY_ENABLED";
    private const string ResourceServiceEndpointUrl = "ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL";

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
        Assert.Equal("true", builder.Configuration["DcpPublisher:RandomizePorts"]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[AspNetCoreUrls]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[DashboardOtlpGrpcEndpointUrl]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[DashboardOtlpHttpEndpointUrl]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[ResourceServiceEndpointUrl]);
        Assert.Equal("false", builder.Configuration[DashboardUnsecuredAllowAnonymous]);
        Assert.Equal("false", builder.Configuration[InteractivityEnabled]);

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

        Assert.Equal("true", builder.Configuration["DcpPublisher:RandomizePorts"]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[AspNetCoreUrls]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[DashboardOtlpGrpcEndpointUrl]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[DashboardOtlpHttpEndpointUrl]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[ResourceServiceEndpointUrl]);
        Assert.Equal("false", builder.Configuration[DashboardUnsecuredAllowAnonymous]);
        Assert.Equal("false", builder.Configuration[InteractivityEnabled]);
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

        Assert.Equal("true", builder.Configuration["DcpPublisher:RandomizePorts"]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[AspNetCoreUrls]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[DashboardOtlpGrpcEndpointUrl]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[DashboardOtlpHttpEndpointUrl]);
        Assert.Equal("http://127.0.0.1:0", builder.Configuration[ResourceServiceEndpointUrl]);
        Assert.Equal("false", builder.Configuration[DashboardUnsecuredAllowAnonymous]);
        Assert.Equal("false", builder.Configuration[InteractivityEnabled]);
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
        Assert.Throws<ArgumentNullException>(() => DistributedApplicationTestingBuilder.Create(default!));

        await using var genericBuilder =
            await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(default);
        await using var typeBuilder =
            await DistributedApplicationTestingBuilder.CreateAsync(typeof(Projects.TestingAppHost1_AppHost), default);

        Func<Task<IDistributedApplicationTestingBuilder>> genericOptionsCall = () =>
            DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
                CreateDashboardOptions(),
                [],
                default);
        Func<Task<IDistributedApplicationTestingBuilder>> typeOptionsCall = () =>
            DistributedApplicationTestingBuilder.CreateAsync(
                typeof(Projects.TestingAppHost1_AppHost),
                CreateDashboardOptions(),
                [],
                default);

        Assert.NotNull(genericOptionsCall);
        Assert.NotNull(typeOptionsCall);
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
    public async Task BuildAsyncCancellationAfterReleaseDisposesBuiltApplication()
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
            await Task.Delay(50);
            probe.ContinueBuilding();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => buildTask);
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
    public async Task BuildAsyncAfterBuilderDisposedThrowsObjectDisposedException()
    {
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>();
        await builder.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(() => builder.BuildAsync());
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

        Assert.Equal("Dashboard testing is not supported in publish mode.", exception.Message);
    }

    private static DistributedApplicationTestingBuilderOptions CreateDashboardOptions()
    {
        return new()
        {
            EnableDashboard = true
        };
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
