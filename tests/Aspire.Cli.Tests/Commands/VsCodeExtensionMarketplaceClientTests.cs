// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net;
using System.Text;
using System.Text.Json;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils.EnvironmentChecker;
using Microsoft.Extensions.Time.Testing;

namespace Aspire.Cli.Tests.Commands;

public class VsCodeExtensionMarketplaceClientTests
{
    [Fact]
    public async Task GetLatestStableVersionAsync_ReturnsLatestStableVersionFromMarketplaceResponse()
    {
        const string responseJson = """
            {
              "results": [
                {
                  "extensions": [
                    {
                      "versions": [
                        {
                          "version": "9.0.0",
                          "properties": [
                            {
                              "key": "Microsoft.VisualStudio.Code.PreRelease",
                              "value": "true"
                            }
                          ]
                        },
                        {
                          "version": "2.0.0-preview.1",
                          "properties": []
                        },
                        {
                          "version": "1.15.0",
                          "properties": []
                        },
                        {
                          "version": "1.16.0",
                          "properties": []
                        }
                      ]
                    }
                  ]
                }
              ]
            }
            """;
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(responseJson, Encoding.UTF8, "application/json")
        };
        HttpMethod? requestMethod = null;
        Uri? requestUri = null;
        string? requestBody = null;
        using var handler = new MockHttpMessageHandler(async (request, cancellationToken) =>
        {
            requestMethod = request.Method;
            requestUri = request.RequestUri;
            requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return response;
        });
        using var httpClient = new HttpClient(handler);
        var client = new VsCodeExtensionMarketplaceClient(httpClient, TimeProvider.System);

        var version = await client.GetLatestStableVersionAsync(TestContext.Current.CancellationToken);

        Assert.Equal("1.16.0", version.ToString());
        Assert.Equal(HttpMethod.Post, requestMethod);
        Assert.Equal(
            "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
            requestUri!.AbsoluteUri);

        using var requestJson = JsonDocument.Parse(requestBody!);
        var filter = Assert.Single(requestJson.RootElement.GetProperty("filters").EnumerateArray());
        var criteria = filter.GetProperty("criteria").EnumerateArray().ToArray();
        Assert.Collection(
            criteria,
            criterion =>
            {
                Assert.Equal(7, criterion.GetProperty("filterType").GetInt32());
                Assert.Equal(VsCodeExtensionMarketplaceClient.ExtensionId, criterion.GetProperty("value").GetString());
            },
            criterion =>
            {
                Assert.Equal(8, criterion.GetProperty("filterType").GetInt32());
                Assert.Equal("Microsoft.VisualStudio.Code", criterion.GetProperty("value").GetString());
            },
            criterion =>
            {
                Assert.Equal(12, criterion.GetProperty("filterType").GetInt32());
                Assert.Equal("4096", criterion.GetProperty("value").GetString());
            });
        Assert.Equal(65584, requestJson.RootElement.GetProperty("flags").GetInt32());
    }

    [Fact]
    public async Task GetLatestStableVersionAsync_ThrowsTimeoutException_WhenBoundedTimeoutExpires()
    {
        var timeProvider = new FakeTimeProvider();
        var requestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new MockHttpMessageHandler(async (_, cancellationToken) =>
        {
            requestStarted.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var httpClient = new HttpClient(handler);
        var timeout = TimeSpan.FromSeconds(5);
        var client = new VsCodeExtensionMarketplaceClient(httpClient, timeProvider, timeout);

        var requestTask = client.GetLatestStableVersionAsync(TestContext.Current.CancellationToken);
        await requestStarted.Task;
        timeProvider.Advance(timeout);

        var exception = await Assert.ThrowsAsync<TimeoutException>(() => requestTask);
        Assert.Equal("The VS Code Marketplace request timed out after 5 seconds.", exception.Message);
    }

    [Fact]
    public async Task GetLatestStableVersionAsync_PropagatesCallerCancellation()
    {
        var timeProvider = new FakeTimeProvider();
        var requestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new MockHttpMessageHandler(async (_, cancellationToken) =>
        {
            requestStarted.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var httpClient = new HttpClient(handler);
        var client = new VsCodeExtensionMarketplaceClient(httpClient, timeProvider, TimeSpan.FromHours(1));
        using var cancellationTokenSource = new CancellationTokenSource();

        var requestTask = client.GetLatestStableVersionAsync(cancellationTokenSource.Token);
        await requestStarted.Task;
        await cancellationTokenSource.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => requestTask);
    }
}
