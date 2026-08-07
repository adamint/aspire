// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.TestUtilities;
using Microsoft.AspNetCore.InternalTesting;
using Xunit;

namespace Aspire.Hosting.Testing.Tests;

public class DashboardUrlTests
{
    [Fact]
    [RequiresFeature(TestFeature.Docker)]
    public async Task GetDashboardUrlAsyncReturnsReachableAuthenticatedDynamicLoopbackUrl()
    {
        var builder = CreateDashboardBuilder();
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource(TestConstants.LongTimeoutTimeSpan);
        var dashboardUri = await app.GetDashboardUrlAsync(cancellationTokenSource.Token);

        Assert.True(dashboardUri.IsAbsoluteUri);
        Assert.Equal(Uri.UriSchemeHttp, dashboardUri.Scheme);
        Assert.True(dashboardUri.IsLoopback);
        Assert.InRange(dashboardUri.Port, 1, 65535);
        Assert.Equal("/login", dashboardUri.AbsolutePath);
        Assert.StartsWith("?t=", dashboardUri.Query, StringComparison.Ordinal);
        Assert.True(dashboardUri.Query.Length > 3);

        using var httpClient = new HttpClient
        {
            Timeout = TestConstants.LongTimeoutTimeSpan
        };
        using var response = await httpClient.GetAsync(dashboardUri, cancellationTokenSource.Token);
        Assert.True(response.IsSuccessStatusCode, $"The dashboard returned HTTP status code {(int)response.StatusCode}.");
    }

    [Fact]
    [RequiresFeature(TestFeature.Docker)]
    public async Task ConcurrentApplicationsUseDifferentDashboardUrls()
    {
        var firstBuilder = CreateDashboardBuilder();
        var secondBuilder = CreateDashboardBuilder();
        await using var firstApp = await firstBuilder.BuildAsync();
        await using var secondApp = await secondBuilder.BuildAsync();

        await Task.WhenAll(firstApp.StartAsync(), secondApp.StartAsync()).WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource(TestConstants.LongTimeoutTimeSpan);
        var urls = await Task.WhenAll(
            firstApp.GetDashboardUrlAsync(cancellationTokenSource.Token),
            secondApp.GetDashboardUrlAsync(cancellationTokenSource.Token));

        Assert.Equal(Uri.UriSchemeHttp, urls[0].Scheme);
        Assert.Equal(Uri.UriSchemeHttp, urls[1].Scheme);
        Assert.NotEqual(urls[0].Port, urls[1].Port);
    }

    [Fact]
    [RequiresFeature(TestFeature.Docker)]
    public async Task GetDashboardUrlAsyncThrowsWhenDashboardIsDisabled()
    {
        var builder = DistributedApplicationTestingBuilder.Create();
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardUrlAsync(default));

        Assert.Equal("The dashboard is not enabled for this application.", exception.Message);
    }

    [Fact]
    public async Task GetDashboardUrlAsyncThrowsBeforeApplicationStarts()
    {
        var builder = CreateDashboardBuilder();
        await using var app = await builder.BuildAsync();

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardUrlAsync(default));

        Assert.Equal("The application must be started before retrieving the dashboard URL.", exception.Message);
    }

    [Fact]
    [RequiresFeature(TestFeature.Docker)]
    public async Task GetDashboardUrlAsyncHonorsCancellation()
    {
        var builder = CreateDashboardBuilder();
        await using var app = await builder.BuildAsync();
        await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);

        using var cancellationTokenSource = new CancellationTokenSource();
        cancellationTokenSource.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => app.GetDashboardUrlAsync(cancellationTokenSource.Token));
    }

    [Fact]
    [RequiresFeature(TestFeature.Docker)]
    public async Task GetDashboardUrlAsyncThrowsAfterApplicationIsDisposed()
    {
        var builder = CreateDashboardBuilder();
        var app = await builder.BuildAsync();

        try
        {
            await app.StartAsync().WaitAsync(TestConstants.LongTimeoutTimeSpan);
            _ = await app.GetDashboardUrlAsync(default);
            await app.DisposeAsync();

            await Assert.ThrowsAsync<ObjectDisposedException>(
                () => app.GetDashboardUrlAsync(default));
        }
        finally
        {
            await app.DisposeAsync();
        }
    }

    [Fact]
    public async Task GetDashboardUrlAsyncThrowsInPublishMode()
    {
        var builder = DistributedApplicationTestingBuilder.Create(
            ["--publisher", "manifest"],
            (options, _) => options.DisableDashboard = false);
        await using var app = await builder.BuildAsync();

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => app.GetDashboardUrlAsync(default));

        Assert.Equal("The dashboard URL is not available in publish mode.", exception.Message);
    }

    [Fact]
    [RequiresFeature(TestFeature.Docker)]
    public async Task GetDashboardUrlAsyncPreservesTerminalDashboardFailure()
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
            () => app.GetDashboardUrlAsync(cancellationTokenSource.Token));

        Assert.Equal(
            "Stopped waiting for resource 'aspire-dashboard' to become healthy because it failed to start.",
            exception.Message);
    }

    private static IDistributedApplicationTestingBuilder CreateDashboardBuilder()
    {
        return DistributedApplicationTestingBuilder.Create(CreateDashboardOptions(), []);
    }

    private static DistributedApplicationTestingBuilderOptions CreateDashboardOptions()
    {
        return new()
        {
            EnableDashboard = true
        };
    }
}
