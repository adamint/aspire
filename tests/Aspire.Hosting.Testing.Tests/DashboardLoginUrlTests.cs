// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net;
using Aspire.TestUtilities;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;
using Xunit;
using TestingResources = Aspire.Hosting.Testing.Properties.Resources;

namespace Aspire.Hosting.Testing.Tests;

public class DashboardLoginUrlTests
{
    [Fact]
    [RequiresFeature(TestFeature.ContainerRuntime)]
    public async Task GetDashboardLoginUrlAsyncAuthenticatesDashboardBrowser()
    {
        await using var builder = await CreateDashboardBuilderAsync();
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource(TestConstants.LongTimeoutTimeSpan);
        var dashboardUri = await app.GetDashboardLoginUrlAsync(cancellationTokenSource.Token);

        Assert.True(dashboardUri.IsAbsoluteUri);
        Assert.Equal(Uri.UriSchemeHttp, dashboardUri.Scheme);
        Assert.True(dashboardUri.IsLoopback);
        Assert.InRange(dashboardUri.Port, 1, 65535);
        Assert.Equal("/login", dashboardUri.AbsolutePath);
        Assert.StartsWith("?t=", dashboardUri.Query, StringComparison.Ordinal);
        Assert.True(dashboardUri.Query.Length > 3);

        using var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = true
        };
        using var httpClient = new HttpClient(handler)
        {
            Timeout = TestConstants.LongTimeoutTimeSpan
        };
        using var loginResponse = await httpClient.GetAsync(dashboardUri, cancellationTokenSource.Token);

        Assert.Equal(HttpStatusCode.Redirect, loginResponse.StatusCode);
        Assert.Equal("/", loginResponse.Headers.Location?.OriginalString);
        Assert.Single(
            loginResponse.Headers.GetValues("Set-Cookie"),
            cookie => cookie.StartsWith(".Aspire.Dashboard.Auth", StringComparison.Ordinal));

        using var protectedResponse = await httpClient.GetAsync(
            new Uri(dashboardUri.GetLeftPart(UriPartial.Authority) + "/structuredlogs"),
            cancellationTokenSource.Token);
        Assert.Equal(HttpStatusCode.OK, protectedResponse.StatusCode);
    }

    [Fact]
    [RequiresFeature(TestFeature.ContainerRuntime)]
    public async Task DashboardRejectsWrongCrossApplicationAndBogusLoginTokens()
    {
        await using var firstBuilder = await CreateDashboardBuilderAsync();
        await using var secondBuilder = await CreateDashboardBuilderAsync();
        await using var firstApp = await firstBuilder.BuildAsync();
        await using var secondApp = await secondBuilder.BuildAsync();

        await Task.WhenAll(firstApp.StartAsync(), secondApp.StartAsync()).WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource(TestConstants.LongTimeoutTimeSpan);
        var firstUrl = await firstApp.GetDashboardLoginUrlAsync(cancellationTokenSource.Token);
        var secondUrl = await secondApp.GetDashboardLoginUrlAsync(cancellationTokenSource.Token);
        var firstBaseUrl = firstUrl.GetLeftPart(UriPartial.Authority);
        Uri[] invalidLoginUrls =
        [
            new($"{firstBaseUrl}/login?t=wrong-token"),
            new(firstBaseUrl + secondUrl.PathAndQuery),
            new($"{firstBaseUrl}/login?t=%25")
        ];

        Assert.NotEqual(firstUrl.Port, secondUrl.Port);
        Assert.NotEqual(firstUrl.Query, secondUrl.Query);

        foreach (var invalidLoginUrl in invalidLoginUrls)
        {
            using var handler = new HttpClientHandler
            {
                AllowAutoRedirect = false,
                UseCookies = true
            };
            using var httpClient = new HttpClient(handler)
            {
                Timeout = TestConstants.LongTimeoutTimeSpan
            };
            using var response = await httpClient.GetAsync(invalidLoginUrl, cancellationTokenSource.Token);

            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            Assert.Equal("/login", response.Headers.Location?.OriginalString);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
        }
    }

    [Fact]
    [RequiresFeature(TestFeature.ContainerRuntime)]
    public async Task GetDashboardLoginUrlAsyncThrowsWhenDashboardIsDisabled()
    {
        var builder = DistributedApplicationTestingBuilder.Create();
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardLoginUrlAsync(default));

        Assert.Equal(TestingResources.DashboardDisabledExceptionMessage, exception.Message);
    }

    [Fact]
    [RequiresFeature(TestFeature.ContainerRuntime)]
    public async Task GetDashboardLoginUrlAsyncThrowsWhenDashboardAllowsAnonymousAccess()
    {
        await using var builder = await CreateDashboardBuilderAsync();
        builder.Configuration["AppHost:BrowserToken"] = string.Empty;
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardLoginUrlAsync(default));

        Assert.Equal(TestingResources.DashboardLoginUrlAnonymousExceptionMessage, exception.Message);
    }

    [Fact]
    public async Task GetDashboardLoginUrlAsyncThrowsBeforeApplicationStarts()
    {
        await using var builder = await CreateDashboardBuilderAsync();
        await using var app = await builder.BuildAsync();

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardLoginUrlAsync(default));

        Assert.Equal(TestingResources.DashboardLoginUrlApplicationNotStartedExceptionMessage, exception.Message);
    }

    [Fact]
    public async Task GetDashboardLoginUrlAsyncThrowsInPublishMode()
    {
        var builder = DistributedApplicationTestingBuilder.Create(["--publisher", "manifest"]);
        await using var app = await builder.BuildAsync();

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardLoginUrlAsync(default));

        Assert.Equal(TestingResources.DashboardLoginUrlPublishModeExceptionMessage, exception.Message);
    }

    [Fact]
    [RequiresFeature(TestFeature.ContainerRuntime)]
    public async Task GetDashboardLoginUrlAsyncPreservesTerminalDashboardFailure()
    {
        var missingDashboardPath = Path.Combine(
            AppContext.BaseDirectory,
            "missing-dashboard",
            Guid.NewGuid().ToString("N"));
        var builder = DistributedApplicationTestingBuilder.Create(
            CreateDashboardOptions(),
            [$"DcpPublisher:DashboardPath={missingDashboardPath}"]);
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource(TestConstants.LongTimeoutTimeSpan);
        var exception = await Assert.ThrowsAsync<DistributedApplicationException>(
            () => app.GetDashboardLoginUrlAsync(cancellationTokenSource.Token));

        Assert.Contains(KnownResourceNames.AspireDashboard, exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    [RequiresFeature(TestFeature.ContainerRuntime)]
    public async Task DashboardStartupSummaryDoesNotWriteTheBrowserTokenToAppHostLogs()
    {
        await using var builder = await CreateDashboardBuilderAsync();
        var logCollector = new FakeLogCollector();
        builder.Services.AddLogging(logging => logging.AddProvider(new FakeLoggerProvider(logCollector)));

        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource(TestConstants.LongTimeoutTimeSpan);
        var dashboardUri = await app.GetDashboardLoginUrlAsync(cancellationTokenSource.Token);
        var token = dashboardUri.Query["?t=".Length..];
        Assert.NotEmpty(token);

        // Resource log forwarding is asynchronous. Wait for the child dashboard's summary, which is written after
        // its separate login URL line, so the assertion covers both the AppHost and dashboard-process output.
        while (!logCollector.GetSnapshot().Any(record =>
            record.Category?.EndsWith(".Resources.aspire-dashboard", StringComparison.Ordinal) == true &&
            GetLogText(record).Contains("Aspire Dashboard", StringComparison.Ordinal)))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationTokenSource.Token);
        }

        var written = string.Join(
            Environment.NewLine,
            logCollector.GetSnapshot().Select(GetLogText));

        Assert.False(
            written.Contains(token, StringComparison.Ordinal),
            "The dashboard browser token was written to AppHost logs.");
        Assert.Contains("Aspire Dashboard", written, StringComparison.Ordinal);
    }

    private static string GetLogText(FakeLogRecord record)
    {
        return record.Message + " " + record.StructuredState?.Aggregate(
            string.Empty,
            (accumulated, pair) => accumulated + " " + pair.Value);
    }

    private static Task<IDistributedApplicationTestingBuilder> CreateDashboardBuilderAsync()
    {
        return DistributedApplicationTestingBuilder.CreateAsync<Projects.TestingAppHost1_AppHost>(
            CreateDashboardOptions(),
            []);
    }

    private static DistributedApplicationTestingBuilderOptions CreateDashboardOptions()
    {
        return new()
        {
            EnableDashboard = true
        };
    }
}
