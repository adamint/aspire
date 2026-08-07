// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Aspire.Cli.Tests.TestServices;

internal sealed class TestNpmRegistry : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cancellationTokenSource = new();
    private readonly ConcurrentQueue<TestNpmRegistryRequest> _requests = new();
    private readonly SemaphoreSlim _requestAvailable = new(0);
    private readonly Task _serverTask;
    private readonly string _version;

    public TestNpmRegistry(string version)
    {
        _version = version;
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        var endpoint = (IPEndPoint)_listener.LocalEndpoint;
        RegistryUri = new Uri($"http://127.0.0.1:{endpoint.Port}/");
        _serverTask = ServeAsync();
    }

    public Uri RegistryUri { get; }

    public async Task<TestNpmRegistryRequest> WaitForRequestAsync(CancellationToken cancellationToken)
    {
        return await WaitForRequestAsync(_ => true, cancellationToken);
    }

    public async Task<TestNpmRegistryRequest> WaitForRequestAsync(
        Func<TestNpmRegistryRequest, bool> predicate,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            await _requestAvailable.WaitAsync(cancellationToken);
            Assert.True(_requests.TryDequeue(out var request));
            if (predicate(request))
            {
                return request;
            }
        }
    }

    private async Task ServeAsync()
    {
        try
        {
            while (!_cancellationTokenSource.IsCancellationRequested)
            {
                using var client = await _listener.AcceptTcpClientAsync(_cancellationTokenSource.Token);

                try
                {
                    await HandleRequestAsync(client, _cancellationTokenSource.Token);
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException or SocketException)
                {
                    // npm's HTTP agent can open and drop connections (retries, agent pooling) without
                    // completing a request. Keep serving instead of faulting the server task, because a
                    // faulted task would surface from DisposeAsync and fail an otherwise passing test.
                }
            }
        }
        catch (OperationCanceledException) when (_cancellationTokenSource.IsCancellationRequested)
        {
        }
        catch (SocketException) when (_cancellationTokenSource.IsCancellationRequested)
        {
        }
    }

    private async Task HandleRequestAsync(TcpClient client, CancellationToken cancellationToken)
    {
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);

        // Request line shape: "GET /@microsoft%2faspire-cli HTTP/1.1". A connection that is opened
        // and closed without sending anything yields null here, which is not a test failure.
        var requestLine = await reader.ReadLineAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(requestLine))
        {
            return;
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (await reader.ReadLineAsync(cancellationToken) is { Length: > 0 } headerLine)
        {
            var separatorIndex = headerLine.IndexOf(':');
            if (separatorIndex > 0)
            {
                headers[headerLine[..separatorIndex].Trim()] = headerLine[(separatorIndex + 1)..].Trim();
            }
        }

        var requestParts = requestLine.Split(' ', 3);
        if (requestParts.Length < 2)
        {
            return;
        }

        _requests.Enqueue(new TestNpmRegistryRequest(requestParts[0], requestParts[1], headers));
        _requestAvailable.Release();

        var body =
            $"{{\"name\":\"@microsoft/aspire-cli\",\"dist-tags\":{{\"latest\":\"{_version}\"}},\"versions\":{{\"{_version}\":{{\"name\":\"@microsoft/aspire-cli\",\"version\":\"{_version}\"}}}}}}";
        var bodyBytes = Encoding.UTF8.GetBytes(body);
        var responseHeaders = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {bodyBytes.Length}\r\nConnection: close\r\n\r\n");

        await stream.WriteAsync(responseHeaders, cancellationToken);
        await stream.WriteAsync(bodyBytes, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        await _cancellationTokenSource.CancelAsync();
        _listener.Stop();
        await _serverTask;
        _requestAvailable.Dispose();
        _cancellationTokenSource.Dispose();
    }
}

internal sealed record TestNpmRegistryRequest(
    string Method,
    string Target,
    IReadOnlyDictionary<string, string> Headers);
