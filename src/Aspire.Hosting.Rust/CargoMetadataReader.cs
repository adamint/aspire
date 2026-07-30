// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text;
using Aspire.Hosting.Dcp.Process;

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
    internal static string[] BuildArguments(string? manifestPath)
    {
        string[] arguments = ["metadata", "--format-version", "1", "--no-deps"];

        // Cargo discovers the manifest from the working directory, which is the crate directory the
        // resource already runs `cargo run` in, so metadata resolves exactly what run mode resolves.
        // Only a caller who redirected run mode with WithCargoManifestPath needs the flag here too.
        return manifestPath is null ? arguments : [.. arguments, "--manifest-path", manifestPath];
    }

    /// <summary>
    /// Runs <c>cargo metadata</c> for the crate in <paramref name="appDirectory"/>.
    /// </summary>
    public static async Task<CargoMetadata> ReadAsync(string appDirectory, string? manifestPath, string resourceName, CancellationToken cancellationToken)
    {
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();

        Task<ProcessResult> resultTask;
        IAsyncDisposable disposable;

        try
        {
            (resultTask, disposable) = ProcessUtil.Run(new ProcessSpec("cargo")
            {
                ArgumentList = BuildArguments(manifestPath),
                WorkingDirectory = appDirectory,
                // Cargo reports a missing or malformed manifest on stderr with a non-zero exit code, which is
                // more useful than a generic launch failure, so handle the exit code here instead.
                ThrowOnNonZeroReturnCode = false,
                OnOutputData = line => stdout.AppendLine(line),
                OnErrorData = line => stderr.AppendLine(line)
            });
        }
        catch (Exception ex)
        {
            throw new DistributedApplicationException(
                $"Unable to start 'cargo' to inspect the Rust app '{resourceName}'. Install Rust from https://www.rust-lang.org/tools/install " +
                $"or supply your own Dockerfile in '{appDirectory}'. {ex.Message}", ex);
        }

        ProcessResult result;

        await using (disposable.ConfigureAwait(false))
        {
            using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutSource.CancelAfter(s_timeout);

            try
            {
                result = await resultTask.WaitAsync(timeoutSource.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new DistributedApplicationException(
                    $"'cargo metadata' for the Rust app '{resourceName}' did not complete within {s_timeout.TotalSeconds:0} seconds.");
            }
        }

        if (result.ExitCode != 0)
        {
            throw new DistributedApplicationException(
                $"'cargo metadata' failed for the Rust app '{resourceName}' with exit code {result.ExitCode}. {stderr.ToString().Trim()}");
        }

        try
        {
            return CargoMetadata.Parse(stdout.ToString());
        }
        catch (Exception ex) when (ex is not DistributedApplicationException)
        {
            throw new DistributedApplicationException(
                $"Unable to read the output of 'cargo metadata' for the Rust app '{resourceName}'. {ex.Message}", ex);
        }
    }
}
