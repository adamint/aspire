// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net;
using System.Text;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils.EnvironmentChecker;

namespace Aspire.Cli.Tests.Commands;

public class VsCodeExtensionMarketplaceClientTests
{
    [Fact]
    public async Task GetLatestVersionsAsync_ReturnsLatestVersionForEachChannel()
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """
                {
                  "results": [{
                    "extensions": [{
                      "versions": [
                        { "version": "1.3.0" },
                        {
                          "version": "1.4.0",
                          "properties": [{
                            "key": "Microsoft.VisualStudio.Code.PreRelease",
                            "value": "true"
                          }]
                        }
                      ]
                    }]
                  }]
                }
                """,
                Encoding.UTF8,
                "application/json")
        };
        var handler = new MockHttpMessageHandler(response);
        using var httpClient = new HttpClient(handler);
        var client = new VsCodeExtensionMarketplaceClient(httpClient);

        var versions = await client.GetLatestVersionsAsync(TestContext.Current.CancellationToken);

        Assert.Equal("1.3.0", versions.StableVersion?.ToString());
        Assert.Equal("1.4.0", versions.PreReleaseVersion?.ToString());
    }

    [Fact]
    public async Task GetLatestVersionsAsync_SendsTheAnonymousMarketplaceQuery()
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{ "results": [] }""", Encoding.UTF8, "application/json")
        };
        var handler = new MockHttpMessageHandler(
            response,
            request =>
            {
                Assert.Equal(HttpMethod.Post, request.Method);
                Assert.Equal(
                    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
                    request.RequestUri?.AbsoluteUri);
                Assert.Equal("3.0-preview.1", request.Headers.Accept.Single().Parameters.Single().Value);
            });
        using var httpClient = new HttpClient(handler);
        var client = new VsCodeExtensionMarketplaceClient(httpClient);

        await client.GetLatestVersionsAsync(TestContext.Current.CancellationToken);

        Assert.True(handler.RequestValidated);
    }
}
