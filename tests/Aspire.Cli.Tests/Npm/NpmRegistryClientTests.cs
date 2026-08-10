// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net;
using System.Text;
using System.Text.Json;
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
    public async Task GetLatestVersionAsync_RequestsTheResolvedRegistry()
    {
        // A feed path must survive composition intact: the package is appended to the configured
        // registry rather than replacing its last segment.
        HttpRequestMessage? capturedRequest = null;
        var client = CreateClient(
            request =>
            {
                capturedRequest = request;
                return CreateJsonResponse("""{ "dist-tags": { "latest": "1.0.0" } }""");
            },
            registry: "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/");

        await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.Equal(
            "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/%40microsoft%2Faspire-cli",
            capturedRequest?.RequestUri?.AbsoluteUri);
    }

    [Fact]
    public async Task GetLatestVersionAsync_TimeoutMessageRedactsRegistryCredentials()
    {
        var timeProvider = new FakeTimeProvider();
        var timeout = TimeSpan.FromSeconds(10);
        var bodyReadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var client = CreateClient(
            _ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new StallingStream(bodyReadStarted))
            },
            timeProvider,
            timeout,
            registry: "https://user:secret-token@npm.contoso.example/feed/");

        var lookupTask = client.GetLatestVersionAsync(PackageName, CancellationToken.None);

        await bodyReadStarted.Task.DefaultTimeout();
        timeProvider.Advance(timeout);

        var exception = await Assert.ThrowsAsync<TimeoutException>(() => lookupTask).DefaultTimeout();
        Assert.Equal(
            "Timed out after 10 seconds while resolving @microsoft/aspire-cli@latest from https://npm.contoso.example/feed/.",
            exception.Message);
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
    public async Task GetLatestVersionAsync_AsksForTheAbbreviatedPackumentTheWayNpmDoes()
    {
        // Byte-for-byte pacote's corgiDoc. A registry that serves "npm install -g" has satisfied
        // pacote, not this client, so advertising only the vendor type would let a registry npm
        // copes with refuse a request npm itself completes.
        HttpRequestMessage? capturedRequest = null;
        var client = CreateClient(request =>
        {
            capturedRequest = request;
            return CreateJsonResponse("""{ "dist-tags": { "latest": "13.4.6" } }""");
        });

        await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.NotNull(capturedRequest);
        Assert.Equal(
            "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
            string.Join(", ", capturedRequest.Headers.GetValues("Accept")));
    }

    [Fact]
    public async Task GetLatestVersionAsync_RetriesWithTheFullPackumentWhenTheAbbreviatedOneIsNotFound()
    {
        // A registry that does not implement the abbreviated document can 404 it while serving the
        // package as the full one, so a bare 404 does not prove the package is missing. pacote
        // retries the same way, and without this the check reports a warning for a package the
        // recommended command installs successfully.
        var accepts = new List<string>();
        var client = CreateClient(request =>
        {
            accepts.Add(string.Join(", ", request.Headers.GetValues("Accept")));

            return accepts.Count == 1
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : CreateJsonResponse("""{ "dist-tags": { "latest": "13.4.6" } }""");
        });

        var version = await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.Equal("13.4.6", version.ToString());
        Assert.Equal(
            new[]
            {
                "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
                "application/json"
            },
            accepts);
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
    public async Task GetLatestVersionAsync_BoundsUnparsableLatestVersionInExceptionMessage()
    {
        var hostileVersion = $"1.0.0\u001b[31m{new string('x', 10_000)}";
        var client = CreateClient(_ => CreateJsonResponse($$"""{ "dist-tags": { "latest": {{JsonSerializer.Serialize(hostileVersion)}} } }"""));

        var exception = await Assert.ThrowsAsync<InvalidDataException>(
            () => client.GetLatestVersionAsync(PackageName, CancellationToken.None)).DefaultTimeout();

        Assert.Equal(
            "The npm registry reported an unparsable 'latest' version for @microsoft/aspire-cli.",
            exception.Message);
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
    public async Task GetLatestVersionAsync_AcceptsMaximumSizedBodyWithoutLargeReadBuffer()
    {
        var stream = new MaximumSizedPackumentStream("""{ "dist-tags": { "latest": "1.0.0" } }""");
        var client = CreateClient(_ =>
        {
            var content = new StreamContent(stream);
            content.Headers.ContentLength = MaximumSizedPackumentStream.MaximumResponseSize;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        });

        var version = await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.Equal("1.0.0", version.ToString());
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

    [Fact]
    public async Task GetLatestVersionAsync_DoesNotSendCredentialsEmbeddedInTheResolvedRegistry()
    {
        // npm accepts "user:token@" in a .npmrc registry value, so the resolved address can carry
        // one. This lookup is documented as anonymous, and RequestUri is read by every delegating
        // handler, DiagnosticSource listener, and HttpRequestException message, so the credential
        // must not reach the request at all.
        HttpRequestMessage? capturedRequest = null;
        var client = CreateClient(
            request =>
            {
                capturedRequest = request;
                return CreateJsonResponse("""{ "dist-tags": { "latest": "13.4.6" } }""");
            },
            registry: "https://user:super-secret-token@npm.contoso.example/feed/");

        await client.GetLatestVersionAsync(PackageName, CancellationToken.None).DefaultTimeout();

        Assert.NotNull(capturedRequest);
        Assert.Equal(string.Empty, capturedRequest.RequestUri?.UserInfo);
        Assert.Equal(
            "https://npm.contoso.example/feed/%40microsoft%2Faspire-cli",
            capturedRequest.RequestUri?.AbsoluteUri);
    }

    private static NpmRegistryClient CreateClient(
        Func<HttpRequestMessage, HttpResponseMessage> handler,
        TimeProvider? timeProvider = null,
        TimeSpan? timeout = null,
        string? registry = null)
    {
        var httpClient = new HttpClient(new DelegateHttpMessageHandler(handler));
        var resolver = new StubNpmRegistryResolver(registry);
        return new NpmRegistryClient(httpClient, resolver, timeProvider ?? TimeProvider.System, timeout);
    }

    private sealed class StubNpmRegistryResolver(string? registry) : INpmRegistryResolver
    {
        public NpmRegistryResolution Resolve(string packageName)
        {
            return new NpmRegistryResolution(
                new Uri(registry ?? "https://registry.npmjs.org/"),
                "test");
        }
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

    private sealed class MaximumSizedPackumentStream(string json) : Stream
    {
        public const int MaximumResponseSize = 1024 * 1024;
        private const int MaximumExpectedReadBufferSize = 16 * 1024;
        private readonly byte[] _jsonBytes = Encoding.UTF8.GetBytes(json);
        private int _position;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => MaximumResponseSize;
        public override long Position { get => _position; set => throw new NotSupportedException(); }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (buffer.Length > MaximumExpectedReadBufferSize)
            {
                throw new InvalidOperationException($"Read buffer was {buffer.Length} bytes.");
            }

            if (_position == MaximumResponseSize)
            {
                return ValueTask.FromResult(0);
            }

            var bytesToCopy = Math.Min(buffer.Length, MaximumResponseSize - _position);
            var bytesFromJson = Math.Min(bytesToCopy, Math.Max(0, _jsonBytes.Length - _position));

            if (bytesFromJson > 0)
            {
                _jsonBytes.AsMemory(_position, bytesFromJson).CopyTo(buffer);
            }

            if (bytesFromJson < bytesToCopy)
            {
                buffer[bytesFromJson..bytesToCopy].Span.Fill((byte)' ');
            }

            _position += bytesToCopy;
            return ValueTask.FromResult(bytesToCopy);
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
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
