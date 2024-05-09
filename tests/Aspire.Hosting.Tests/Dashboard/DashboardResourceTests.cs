// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;
using System.Text.Json;
using Aspire.Dashboard.Tests.Integration.Playright;
using Aspire.Hosting.Dashboard;
using Aspire.Hosting.Dcp;
using Aspire.Hosting.Tests.Helpers;
using Aspire.Hosting.Tests.Utils;
using Aspire.Hosting.Utils;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;
using Xunit;
using Xunit.Abstractions;

namespace Aspire.Hosting.Tests.Dashboard;

public class DashboardResourceTests : IClassFixture<PlaywrightFixture>
{
    private readonly ITestOutputHelper _testOutputHelper;
    private readonly PlaywrightFixture _playwrightFixture;

    public DashboardResourceTests(ITestOutputHelper testOutputHelper, PlaywrightFixture playwrightFixture)
    {
        _testOutputHelper = testOutputHelper;
        _playwrightFixture = playwrightFixture;
    }

    [Fact]
    public async Task DashboardIsAutomaticallyAddedAsHiddenResource()
    {
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        // Ensure any ambient configuration doesn't impact this test.
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DOTNET_ASPIRE_SHOW_DASHBOARD_RESOURCES"] = null
        });

        var dashboardPath = Path.GetFullPath("dashboard");

        builder.Services.Configure<DcpOptions>(o =>
        {
            o.DashboardPath = dashboardPath;
        });

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources.OfType<ExecutableResource>());
        var initialSnapshot = Assert.Single(dashboard.Annotations.OfType<ResourceSnapshotAnnotation>());

        Assert.NotNull(dashboard);
        Assert.Equal("aspire-dashboard", dashboard.Name);
        Assert.Equal(dashboardPath, dashboard.Command);
        Assert.Equal("Hidden", initialSnapshot.InitialSnapshot.State);
    }

    [Fact]
    public async Task DashboardIsAddedFirst()
    {
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        builder.AddContainer("my-container", "my-image");

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        Assert.Collection(model.Resources,
            r => Assert.Equal("aspire-dashboard", r.Name),
            r => Assert.Equal("my-container", r.Name)
        );
    }

    [Fact]
    public async Task DashboardDoesNotAddResource_ConfiguresExistingDashboard()
    {
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        builder.Services.AddSingleton<IDashboardEndpointProvider, MockDashboardEndpointProvider>();

        builder.Configuration.Sources.Clear();

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ASPNETCORE_URLS"] = "http://localhost",
            ["DOTNET_DASHBOARD_OTLP_ENDPOINT_URL"] = "http://localhost"
        });

        var container = builder.AddContainer(KnownResourceNames.AspireDashboard, "my-image");

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources);

        Assert.Same(container.Resource, dashboard);

        var config = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(dashboard);

        Assert.Collection(config,
            e =>
            {
                Assert.Equal("ASPNETCORE_ENVIRONMENT", e.Key);
                Assert.Equal("Production", e.Value);
            },
            e =>
            {
                Assert.Equal("ASPNETCORE_URLS", e.Key);
                Assert.Equal("http://localhost", e.Value);
            },
            e =>
            {
                Assert.Equal("DOTNET_RESOURCE_SERVICE_ENDPOINT_URL", e.Key);
                Assert.Equal("http://localhost:5000", e.Value);
            },
            e =>
            {
                Assert.Equal("DOTNET_DASHBOARD_OTLP_ENDPOINT_URL", e.Key);
                Assert.Equal("http://localhost", e.Value);
            },
            e =>
            {
                Assert.Equal("DASHBOARD__FRONTEND__AUTHMODE", e.Key);
                Assert.Equal("Unsecured", e.Value);
            },
            e =>
            {
                Assert.Equal("DASHBOARD__RESOURCESERVICECLIENT__AUTHMODE", e.Key);
                Assert.Equal("Unsecured", e.Value);
            },
            e =>
            {
                Assert.Equal("DASHBOARD__OTLP__AUTHMODE", e.Key);
                Assert.Equal("Unsecured", e.Value);
            },
            e =>
            {
                Assert.Equal("LOGGING__CONSOLE__FORMATTERNAME", e.Key);
                Assert.Equal("json", e.Value);
            }
        );
    }

    [Fact]
    public async Task DashboardWithDllPathLaunchesDotnet()
    {
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        var dashboardPath = Path.GetFullPath("dashboard.dll");

        builder.Services.Configure<DcpOptions>(o =>
        {
            o.DashboardPath = dashboardPath;
        });

        var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources.OfType<ExecutableResource>());

        var args = await ArgumentEvaluator.GetArgumentListAsync(dashboard);

        Assert.NotNull(dashboard);
        Assert.Equal("aspire-dashboard", dashboard.Name);
        Assert.Equal("dotnet", dashboard.Command);
        Assert.Equal([dashboardPath], args);
    }

    [Fact]
    public async Task DashboardAuthConfigured_EnvVarsPresent()
    {
        // Arrange
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        builder.Services.AddSingleton<IDashboardEndpointProvider, MockDashboardEndpointProvider>();

        builder.Configuration.Sources.Clear();

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ASPNETCORE_URLS"] = "http://localhost",
            ["DOTNET_DASHBOARD_OTLP_ENDPOINT_URL"] = "http://localhost",
            ["AppHost:BrowserToken"] = "TestBrowserToken!",
            ["AppHost:OtlpApiKey"] = "TestOtlpApiKey!"
        });

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources);

        var config = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(dashboard);

        Assert.Equal("BrowserToken", config.Single(e => e.Key == DashboardConfigNames.DashboardFrontendAuthModeName.EnvVarName).Value);
        Assert.Equal("TestBrowserToken!", config.Single(e => e.Key == DashboardConfigNames.DashboardFrontendBrowserTokenName.EnvVarName).Value);

        Assert.Equal("ApiKey", config.Single(e => e.Key == DashboardConfigNames.DashboardOtlpAuthModeName.EnvVarName).Value);
        Assert.Equal("TestOtlpApiKey!", config.Single(e => e.Key == DashboardConfigNames.DashboardOtlpPrimaryApiKeyName.EnvVarName).Value);
    }

    [Fact]
    public async Task DashboardAuthRemoved_EnvVarsUnsecured()
    {
        // Arrange
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        builder.Services.AddSingleton<IDashboardEndpointProvider, MockDashboardEndpointProvider>();

        builder.Configuration.Sources.Clear();

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ASPNETCORE_URLS"] = "http://localhost",
            ["DOTNET_DASHBOARD_OTLP_ENDPOINT_URL"] = "http://localhost"
        });

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources);

        var config = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(dashboard);

        Assert.Equal("Unsecured", config.Single(e => e.Key == DashboardConfigNames.DashboardFrontendAuthModeName.EnvVarName).Value);
        Assert.Equal("Unsecured", config.Single(e => e.Key == DashboardConfigNames.DashboardOtlpAuthModeName.EnvVarName).Value);
    }

    [Fact]
    public async Task DashboardResourceServiceUriIsSet()
    {
        // Arrange
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = false);

        builder.Services.AddSingleton<IDashboardEndpointProvider, MockDashboardEndpointProvider>();

        builder.Configuration.Sources.Clear();

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ASPNETCORE_URLS"] = "http://localhost",
            ["DOTNET_DASHBOARD_OTLP_ENDPOINT_URL"] = "http://localhost"
        });

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources);

        var config = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(dashboard);

        Assert.Equal("http://localhost:5000", config.Single(e => e.Key == DashboardConfigNames.ResourceServiceUrlName.EnvVarName).Value);
    }

    [Fact]
    public async Task DashboardIsNotAddedInPublishMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(options =>
        {
            options.DisableDashboard = false;
            options.Args = ["--publisher", "manifest"];
        });

        using var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        Assert.Empty(model.Resources);
    }

    [Fact]
    public async Task DashboardIsNotAddedIfDisabled()
    {
        using var builder = TestDistributedApplicationBuilder.Create(options => options.DisableDashboard = true);

        var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        Assert.Empty(model.Resources);
    }

    [Fact]
    public void ContainerIsValidWithDashboardIsDisabled()
    {
        // Set the host environment to "Development" so that the container validates services.
        using var builder = TestDistributedApplicationBuilder.Create(options =>
        {
            options.DisableDashboard = true;
            options.Args = ["--environment", "Development"];
        });

        // Container validation logic runs when the service provider is built.
        using var app = builder.Build();
    }

    [Theory]
    [InlineData(LogLevel.Critical)]
    [InlineData(LogLevel.Error)]
    [InlineData(LogLevel.Warning)]
    [InlineData(LogLevel.Information)]
    [InlineData(LogLevel.Debug)]
    [InlineData(LogLevel.Trace)]
    public async Task DashboardLifecycleHookWatchesLogs(LogLevel logLevel)
    {
        using var builder = TestDistributedApplicationBuilder.Create(o => o.DisableDashboard = false);

        var loggerProvider = new TestLoggerProvider();

        builder.Services.AddLogging(b =>
        {
            b.AddProvider(loggerProvider);
            b.AddFilter("Aspire.Hosting.Dashboard", logLevel);
        });

        var dashboardPath = Path.GetFullPath("dashboard");

        builder.Services.Configure<DcpOptions>(o =>
        {
            o.DashboardPath = dashboardPath;
        });

        var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();
        var resourceNotificationService = app.Services.GetRequiredService<ResourceNotificationService>();
        var resourceLoggerService = app.Services.GetRequiredService<ResourceLoggerService>();

        var dashboard = Assert.Single(model.Resources.OfType<ExecutableResource>());

        Assert.NotNull(dashboard);
        Assert.Equal("aspire-dashboard", dashboard.Name);

        // Push a notification through to the dashboard resource.
        await resourceNotificationService.PublishUpdateAsync(dashboard, "aspire-dashboard-0", s => s with { State = "Running" });

        // Push some logs through to the dashboard resource.
        var logger = resourceLoggerService.GetLogger("aspire-dashboard-0");

        // The logging watcher expects a JSON payload
        var dashboardLogMessage = new DashboardLogMessage
        {
            Category = "Test",
            LogLevel = logLevel,
            Message = "Test dashboard message"
        };

        logger.Log(logLevel, 0, JsonSerializer.Serialize(dashboardLogMessage), null, (s, _) => s);

        // Get the logger with the category we expect Aspire.Hosting.Dashboard.Test
        var testLogger = loggerProvider.CreateLogger("Aspire.Hosting.Dashboard.Test") as TestLogger;

        Assert.NotNull(testLogger);

        // Get the first log message that was logged
        var log = await testLogger.FirstLogTask.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal("Test dashboard message", log.Message);
        Assert.Equal(logLevel, log.LogLevel);

    }

    [Fact]
    public async Task DashboardIsExcludedFromManifestInPublishModeEvenIfAddedExplicitly()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish);

        builder.AddProject<DashboardProject>(KnownResourceNames.AspireDashboard);

        var app = builder.Build();

        await app.ExecuteBeforeStartHooksAsync(default);

        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        var dashboard = Assert.Single(model.Resources.OfType<ProjectResource>());

        Assert.NotNull(dashboard);
        var annotation = Assert.Single(dashboard.Annotations.OfType<ManifestPublishingCallbackAnnotation>());

        var manifest = await ManifestUtils.GetManifestOrNull(dashboard);

        Assert.Equal("aspire-dashboard", dashboard.Name);
        Assert.Same(ManifestPublishingCallbackAnnotation.Ignore, annotation);
        Assert.Null(manifest);
    }

    private async Task<(string DashboardUrl, IPage Page)> SetupDashboardForPlaywrightAsync()
    {
        var url = "http://localhost:1234";

        var args = new string[] {
            "ASPNETCORE_ENVIRONMENT=Development",
            "DOTNET_ENVIRONMENT=Development",
            $"ASPNETCORE_URLS={url}",
            $"DOTNET_DASHBOARD_OTLP_ENDPOINT_URL={url}5",
            "DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true",
            "DOTNET_ASPIRE_SHOW_DASHBOARD_RESOURCES=true"
        };

        using var testProgram = TestProgram.Create<DistributedApplicationTests>(
            args,
            includeIntegrationServices: true,
            disableDashboard: false);

        testProgram.AppBuilder.Services.AddLogging(b =>
        {
            b.AddProvider(new TestLoggerProvider());
        });

        await using var app = testProgram.Build();
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        await app.StartAsync(cts.Token);
        var page = await _playwrightFixture.Browser.NewPageAsync();
        await Task.Delay(5000);
        await page.GotoAsync(url);

        return (url, page);
    }

    [LocalOnlyFact]
    public async Task Dashboard_Playwright_Test()
    {
        var (baseUrl, page) = await SetupDashboardForPlaywrightAsync();
        var resource = page.Locator(".resource-name").First;
        var innerHtml = await resource.InnerHTMLAsync();
        Console.WriteLine(innerHtml);
        var resourceName = await resource.Locator("span.resource-name").TextContentAsync();
        await resource.Locator("css=resource-log-link").ClickAsync();

        Assert.StartsWith($"{baseUrl}/consolelogs/resource/{resourceName}", page.Url);
    }

    private sealed class DashboardProject : IProjectMetadata
    {
        public string ProjectPath => "dashboard.csproj";

        public LaunchSettings LaunchSettings { get; } = new();
    }

    private sealed class TestLogger : ILogger
    {
        private readonly TaskCompletionSource<LogMessage> _tcs = new();

        public Task<LogMessage> FirstLogTask => _tcs.Task;

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var message = new LogMessage
            {
                LogLevel = logLevel,
                Message = formatter(state, exception)
            };

            _tcs.TrySetResult(message);
        }

        public sealed class LogMessage
        {
            public LogLevel LogLevel { get; set; }
            public string Message { get; set; } = string.Empty;
        }
    }

    private sealed class TestLoggerProvider : ILoggerProvider
    {
        private readonly ConcurrentDictionary<string, TestLogger> _loggers = new();

        public ILogger CreateLogger(string categoryName)
        {
            return _loggers.GetOrAdd(categoryName, _ => new TestLogger());
        }

        public void Dispose() { }
    }

    private sealed class MockDashboardEndpointProvider : IDashboardEndpointProvider
    {
        public Task<string> GetResourceServiceUriAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult("http://localhost:5000");
        }
    }
}
