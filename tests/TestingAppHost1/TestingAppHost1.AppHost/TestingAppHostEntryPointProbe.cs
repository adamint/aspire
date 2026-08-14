// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;

public static class TestingAppHostEntryPointProbe
{
    private const string ArgumentPrefix = "--entry-point-exit-probe=";
    private static readonly ConcurrentDictionary<string, TaskCompletionSource> s_probes = new();

    public static Probe Create()
    {
        var id = Guid.NewGuid().ToString("N");
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!s_probes.TryAdd(id, exited))
        {
            throw new InvalidOperationException($"Could not create entry-point probe '{id}'.");
        }

        return new Probe(id, exited.Task);
    }

    public static IDisposable Track(string[] args)
    {
        // The test passes the probe as:
        //   --entry-point-exit-probe=<32-character GUID>
        var argument = args.FirstOrDefault(arg => arg.StartsWith(ArgumentPrefix, StringComparison.Ordinal));
        if (argument is null)
        {
            return EmptyDisposable.Instance;
        }

        var id = argument[ArgumentPrefix.Length..];
        if (!s_probes.TryGetValue(id, out var exited))
        {
            throw new InvalidOperationException($"Entry-point probe '{id}' was not registered.");
        }

        return new ExitSignal(exited);
    }

    public sealed class Probe(string id, Task exited) : IDisposable
    {
        public string Id { get; } = id;

        public Task Exited { get; } = exited;

        public void Dispose()
        {
            s_probes.TryRemove(Id, out _);
        }
    }

    private sealed class ExitSignal(TaskCompletionSource exited) : IDisposable
    {
        public void Dispose()
        {
            exited.TrySetResult();
        }
    }

    private sealed class EmptyDisposable : IDisposable
    {
        public static EmptyDisposable Instance { get; } = new();

        public void Dispose()
        {
        }
    }
}
