// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Queries cargo for a crate's package/target layout without compiling anything.
/// </summary>
/// <remarks>
/// Publishing a Rust app builds it inside the container, so the host must never compile. It still needs the
/// name of the produced binary in order to emit a correct <c>COPY --from=build</c> and <c>ENTRYPOINT</c>, and
/// <c>cargo metadata</c> is the only cargo subcommand that answers that from the manifest alone.
/// <c>--no-deps</c> additionally stops cargo from resolving or downloading the dependency graph.
/// See https://doc.rust-lang.org/cargo/commands/cargo-metadata.html
/// </remarks>
internal static class CargoMetadataReader
{
    private static readonly TimeSpan s_timeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Builds the argument vector passed to cargo.
    /// </summary>
    /// <remarks>
    /// Exposed separately so tests can assert that publishing never invokes a compiling subcommand.
    /// </remarks>
    internal static string[] BuildArguments(string manifestPath)
        => ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifestPath];

    /// <summary>
    /// Runs <c>cargo metadata</c> for the crate in <paramref name="appDirectory"/>.
    /// </summary>
    public static async Task<CargoMetadata> ReadAsync(string appDirectory, string resourceName, CancellationToken cancellationToken)
    {
        var manifestPath = Path.Combine(appDirectory, "Cargo.toml");

        if (!File.Exists(manifestPath))
        {
            throw new DistributedApplicationException(
                $"Unable to publish the Rust app '{resourceName}' because no Cargo.toml was found at '{manifestPath}'.");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "cargo",
            // The manifest path is passed explicitly rather than relying on the working directory so that
            // cargo cannot walk up to an unrelated parent manifest.
            WorkingDirectory = appDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        foreach (var argument in BuildArguments(manifestPath))
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = StartCargo(startInfo, resourceName);

        // Read both streams concurrently: cargo metadata output for a large workspace easily exceeds the
        // pipe buffer, and waiting for exit before draining stdout would deadlock.
        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(s_timeout);

        try
        {
            await process.WaitForExitAsync(timeoutSource.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);

            throw new DistributedApplicationException(
                $"'cargo metadata' for the Rust app '{resourceName}' did not complete within {s_timeout.TotalSeconds:0} seconds.");
        }

        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);

        if (process.ExitCode != 0)
        {
            throw new DistributedApplicationException(
                $"'cargo metadata' failed for the Rust app '{resourceName}' with exit code {process.ExitCode}. {stderr.Trim()}");
        }

        try
        {
            return CargoMetadata.Parse(stdout);
        }
        catch (Exception ex) when (ex is not DistributedApplicationException)
        {
            throw new DistributedApplicationException(
                $"Unable to read the output of 'cargo metadata' for the Rust app '{resourceName}'. {ex.Message}", ex);
        }
    }

    private static Process StartCargo(ProcessStartInfo startInfo, string resourceName)
    {
        try
        {
            return Process.Start(startInfo)
                ?? throw new DistributedApplicationException($"Unable to start 'cargo' to inspect the Rust app '{resourceName}'.");
        }
        catch (Exception ex) when (ex is not DistributedApplicationException)
        {
            throw new DistributedApplicationException(
                $"Unable to start 'cargo' to inspect the Rust app '{resourceName}'. Install Rust from https://www.rust-lang.org/tools/install " +
                $"or supply your own Dockerfile next to '{startInfo.WorkingDirectory}'. {ex.Message}", ex);
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // The process exited between the timeout firing and the kill attempt.
        }
    }
}
