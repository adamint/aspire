// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net;
using System.Text;
using Aspire.Cli.Npm;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.Time.Testing;

namespace Aspire.Cli.Tests.Npm;

public class NpmRegistryClientTests
{
    private const string PackageName = "@microsoft/aspire-cli";

    [Fact]
    public async Task GetLatestVersionAsync_ReadsLatestDistTag()
    {
        // Trimmed shape of an abbreviated packument from registry.npmjs.org.
        const string packument = """
            {
              "name": "@microsoft/aspire-cli",
              "dist-tags": { "latest": "13.4.6" },
              "versions": { "13.4.6": { "name": "@microsoft/aspire-cli", "version": "13.4.6" } }
            }
            """;

        HttpRequestMessage? capturedRequest = null;
        var client = CreateClient(request =>
        {
            capturedRequest = request;
            return CreateJsonResponse(packument);
        });

        var version = await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.Equal("13.4.6", version.ToString());
        Assert.NotNull(capturedRequest);
        Assert.Equal(HttpMethod.Get, capturedRequest.Method);
        Assert.Equal(
            "https://registry.npmjs.org/%40microsoft%2Faspire-cli",
            capturedRequest.RequestUri?.AbsoluteUri);
        Assert.Contains(
            capturedRequest.Headers.Accept,
            header => header.MediaType == "application/vnd.npm.install-v1+json");
    }

    [Fact]
    public async Task GetLatestVersionAsync_SendsNoAuthorizationOrCookies()
    {
        HttpRequestMessage? capturedRequest = null;
        var client = CreateClient(request =>
        {
            capturedRequest = request;
            return CreateJsonResponse("""{ "dist-tags": { "latest": "1.0.0" } }""");
        });

        await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.NotNull(capturedRequest);
        Assert.Null(capturedRequest.Headers.Authorization);
        Assert.Collection(
            capturedRequest.Headers,
            header => Assert.Equal("Accept", header.Key));
    }

    [Fact]
    public async Task GetLatestVersionAsync_PrereleaseLatestIsReturnedVerbatim()
    {
        var client = CreateClient(_ => CreateJsonResponse("""{ "dist-tags": { "latest": "14.0.0-preview.1.25000.1" } }"""));

        var version = await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.Equal("14.0.0-preview.1.25000.1", version.ToString());
        Assert.True(version.IsPrerelease);
    }

    [Fact]
    public async Task GetLatestVersionAsync_ThrowsWhenRegistryReturnsError()
    {
        var client = CreateClient(_ => new HttpResponseMessage(HttpStatusCode.NotFound));

        await Assert.ThrowsAsync<HttpRequestException>(
            () => client.GetLatestVersionAsync(PackageName, CancellationToken.None)).DefaultTimeout();
    }

    [Theory]
    [InlineData("""{ "versions": {} }""")]
    [InlineData("""{ "dist-tags": {} }""")]
    [InlineData("""{ "dist-tags": { "next": "1.0.0" } }""")]
    [InlineData("""{ "dist-tags": "latest" }""")]
    [InlineData("""{ "dist-tags": { "latest": 13 } }""")]
    [InlineData("""{ "dist-tags": { "latest": "not-a-version" } }""")]
    public async Task GetLatestVersionAsync_ThrowsWhenLatestDistTagIsUnusable(string packument)
    {
        var client = CreateClient(_ => CreateJsonResponse(packument));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => client.GetLatestVersionAsync(PackageName, CancellationToken.None)).DefaultTimeout();
    }

    [Fact]
    public async Task GetLatestVersionAsync_ThrowsWhenDeclaredContentLengthExceedsLimit()
    {
        var client = CreateClient(_ =>
        {
            var response = CreateJsonResponse("""{ "dist-tags": { "latest": "1.0.0" } }""");
            response.Content.Headers.ContentLength = (1024 * 1024) + 1;
            return response;
        });

        await Assert.ThrowsAsync<InvalidDataException>(
            () => client.GetLatestVersionAsync(PackageName, CancellationToken.None)).DefaultTimeout();
    }

    [Fact]
    public async Task GetLatestVersionAsync_ThrowsWhenUndeclaredBodyExceedsLimit()
    {
        // A registry that omits Content-Length must not be able to stream an unbounded body into
        // the CLI, so the limit is enforced while reading rather than only from the header.
        var client = CreateClient(_ =>
        {
            var content = new StreamContent(new EndlessStream());
            content.Headers.ContentLength = null;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        });

        await Assert.ThrowsAsync<InvalidDataException>(
            () => client.GetLatestVersionAsync(PackageName, CancellationToken.None)).DefaultTimeout();
    }

    [Fact]
    public async Task GetLatestVersionAsync_TimesOutWhenRegistryStallsAfterHeaders()
    {
        var timeProvider = new FakeTimeProvider();
        var timeout = TimeSpan.FromSeconds(10);
        var bodyReadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // ResponseHeadersRead means SendAsync completes before the body arrives, so this is the
        // stall the private timeout has to cover.
        var client = CreateClient(
            _ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new StallingStream(bodyReadStarted))
            },
            timeProvider,
            timeout);

        var lookupTask = client.GetLatestVersionAsync(PackageName, CancellationToken.None);

        await bodyReadStarted.Task.DefaultTimeout();
        timeProvider.Advance(timeout);

        await Assert.ThrowsAsync<TimeoutException>(() => lookupTask).DefaultTimeout();
    }

    [Fact]
    public async Task GetLatestVersionAsync_CallerCancellationSurfacesAsCancellationNotTimeout()
    {
        var timeProvider = new FakeTimeProvider();
        var bodyReadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var client = CreateClient(
            _ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new StallingStream(bodyReadStarted))
            },
            timeProvider,
            TimeSpan.FromSeconds(10));

        using var cancellation = new CancellationTokenSource();
        var lookupTask = client.GetLatestVersionAsync(PackageName, cancellation.Token);

        await bodyReadStarted.Task.DefaultTimeout();
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lookupTask).DefaultTimeout();
    }

    private static NpmRegistryClient CreateClient(
        Func<HttpRequestMessage, HttpResponseMessage> handler,
        TimeProvider? timeProvider = null,
        TimeSpan? timeout = null)
    {
        var httpClient = new HttpClient(new DelegateHttpMessageHandler(handler));
        return new NpmRegistryClient(httpClient, timeProvider ?? TimeProvider.System, timeout);
    }

    private static HttpResponseMessage CreateJsonResponse(string json)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
    }

    private sealed class DelegateHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(handler(request));
        }
    }

    private sealed class EndlessStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            buffer.Span.Fill((byte)' ');
            return ValueTask.FromResult(buffer.Length);
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            buffer.AsSpan(offset, count).Fill((byte)' ');
            return count;
        }

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class StallingStream(TaskCompletionSource readStarted) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            readStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
