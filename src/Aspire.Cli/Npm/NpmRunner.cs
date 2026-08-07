// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using Aspire.Cli.Telemetry;
using Microsoft.Extensions.Logging;
using Semver;

namespace Aspire.Cli.Npm;

/// <summary>
/// Runs npm CLI commands for package management operations.
/// </summary>
internal sealed class NpmRunner : INpmRunner
{
    private static readonly TimeSpan s_processTerminationTimeout = TimeSpan.FromSeconds(2);

    internal static TimeSpan ProcessTerminationTimeout => s_processTerminationTimeout;

    /// <summary>
    /// The internal npm registry URL used by Aspire-managed npm operations. General package
    /// operations preserve ambient npm configuration for existing consumers; callers that
    /// require anonymous mirror semantics use the dedicated isolated resolver.
    /// </summary>
    private const string InternalRegistry = "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/";

    private readonly IEnvironment _environment;
    private readonly ILogger<NpmRunner> _logger;
    private readonly ProfilingTelemetry _profilingTelemetry;
    private readonly TimeProvider _timeProvider;
    private readonly string _internalRegistry;
    private readonly Lazy<string?> _npmPath = new(() => PathLookupHelper.FindFullPathFromPath("npm"));

    public NpmRunner(
        IEnvironment environment,
        ILogger<NpmRunner> logger,
        ProfilingTelemetry profilingTelemetry)
        : this(environment, logger, profilingTelemetry, TimeProvider.System, InternalRegistry)
    {
    }

    public NpmRunner(
        IEnvironment environment,
        ILogger<NpmRunner> logger,
        ProfilingTelemetry profilingTelemetry,
        TimeProvider timeProvider)
        : this(environment, logger, profilingTelemetry, timeProvider, InternalRegistry)
    {
    }

    internal NpmRunner(
        IEnvironment environment,
        ILogger<NpmRunner> logger,
        ProfilingTelemetry profilingTelemetry,
        TimeProvider timeProvider,
        string internalRegistry)
    {
        _environment = environment;
        _logger = logger;
        _profilingTelemetry = profilingTelemetry;
        _timeProvider = timeProvider;
        _internalRegistry = internalRegistry;
    }

    /// <inheritdoc />
    public bool IsAvailable => _npmPath.Value is not null;

    /// <summary>
    /// Overrides the parent directory used for isolated npm working directories. Tests set this to
    /// stage an ancestor directory that npm's local-prefix walk would find, without mutating the
    /// process-wide temp environment variables that concurrently running tests also depend on.
    /// </summary>
    internal string? TempDirectoryRootOverride { get; init; }

    /// <inheritdoc />
    public async Task<NpmPackageInfo?> ResolvePackageAsync(string packageName, string versionRange, CancellationToken cancellationToken)
    {
        var npmPath = FindNpmPath();
        if (npmPath is null)
        {
            return null;
        }

        _logger.LogDebug("Resolving npm package {PackageSpecifier}", NpmPackageInfo.FormatPackageSpecifier(packageName, versionRange));

        // Use an isolated temp subdirectory so npm doesn't pick up .npmrc or
        // other config files from the shared temp root or the user's CWD.
        var tempDir = CreateIsolatedTempDirectory();

        try
        {
            await PinNpmLocalPrefixAsync(tempDir, cancellationToken);

            // Resolve version: npm view <package>@<range> version
            var versionOutput = await RunNpmCommandInDirectoryAsync(
                npmPath,
                ["view", NpmPackageInfo.FormatPackageSpecifier(packageName, versionRange), "version", "--registry", _internalRegistry],
                tempDir,
                cancellationToken);

            if (versionOutput is null)
            {
                _logger.LogDebug("Failed to resolve version for {PackageSpecifier}", NpmPackageInfo.FormatPackageSpecifier(packageName, versionRange));
                return null;
            }

            if (!TryExtractLastVersion(versionOutput, out var versionString))
            {
                _logger.LogDebug("Could not extract version from npm output: {Output}", versionOutput.Trim());
                return null;
            }

            if (!SemVersion.TryParse(versionString, SemVersionStyles.Any, out var version))
            {
                _logger.LogDebug("Could not parse npm version from output: {Output}", versionString);
                return null;
            }

            _logger.LogDebug("Resolved {PackageSpecifier}", NpmPackageInfo.FormatPackageSpecifier(packageName, version));

            return new NpmPackageInfo
            {
                Version = version
            };
        }
        finally
        {
            CleanupTempDirectory(tempDir);
        }
    }

    /// <inheritdoc />
    public async Task<NpmPackageInfo?> ResolvePackageFromAnonymousInternalRegistryAsync(
        string packageName,
        string versionRange,
        CancellationToken cancellationToken)
    {
        var npmPath = FindNpmPath();
        if (npmPath is null)
        {
            return null;
        }

        var tempRoot = CreateIsolatedTempDirectory();

        try
        {
            // The isolation scaffolding is created inside the try so a failure while writing the
            // empty npmrc files still deletes the temp root instead of leaking it for the machine's
            // temp-cleanup policy to reclaim.
            var projectDirectory = Path.Combine(tempRoot, "project");
            var cacheDirectory = Path.Combine(tempRoot, "cache");
            var userConfigPath = Path.Combine(tempRoot, "user.npmrc");
            var globalConfigPath = Path.Combine(tempRoot, "global.npmrc");
            Directory.CreateDirectory(projectDirectory);
            Directory.CreateDirectory(cacheDirectory);
            await File.WriteAllTextAsync(userConfigPath, string.Empty, cancellationToken);
            await File.WriteAllTextAsync(globalConfigPath, string.Empty, cancellationToken);
            await PinNpmLocalPrefixAsync(projectDirectory, cancellationToken);

            var packageSpecifier = NpmPackageInfo.FormatPackageSpecifier(packageName, versionRange);
            _logger.LogDebug("Resolving npm package {PackageSpecifier} anonymously from the internal registry", packageSpecifier);

            var versionOutput = await RunNpmCommandInDirectoryAsync(
                npmPath,
                CreateAnonymousInternalRegistryViewArguments(
                    packageSpecifier,
                    _internalRegistry,
                    userConfigPath,
                    globalConfigPath,
                    cacheDirectory),
                projectDirectory,
                removeAmbientNpmConfiguration: true,
                cancellationToken);

            if (versionOutput is null ||
                !TryExtractLastVersion(versionOutput, out var versionString) ||
                !SemVersion.TryParse(versionString, SemVersionStyles.Any, out var version))
            {
                _logger.LogDebug("Failed to resolve {PackageSpecifier} anonymously from the internal npm registry", packageSpecifier);
                return null;
            }

            return new NpmPackageInfo
            {
                Version = version
            };
        }
        finally
        {
            CleanupTempDirectory(tempRoot);
        }
    }

    /// <inheritdoc />
    public async Task<string?> PackAsync(string packageName, string version, string outputDirectory, CancellationToken cancellationToken)
    {
        var npmPath = FindNpmPath();
        if (npmPath is null)
        {
            return null;
        }

        _logger.LogDebug("Packing npm package {PackageSpecifier} to {OutputDirectory}", NpmPackageInfo.FormatPackageSpecifier(packageName, version), outputDirectory);

        var output = await RunNpmCommandInDirectoryAsync(
            npmPath,
            ["pack", NpmPackageInfo.FormatPackageSpecifier(packageName, version), "--pack-destination", outputDirectory, "--registry", _internalRegistry],
            outputDirectory,
            cancellationToken);

        if (output is null)
        {
            _logger.LogDebug("Failed to pack {PackageSpecifier}", NpmPackageInfo.FormatPackageSpecifier(packageName, version));
            return null;
        }

        // npm pack outputs the filename of the created tarball
        var filename = output.Trim().Split(['\n', '\r'], StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        if (string.IsNullOrWhiteSpace(filename))
        {
            _logger.LogDebug("npm pack returned empty filename");
            return null;
        }

        var tarballPath = Path.Combine(outputDirectory, filename);
        if (!File.Exists(tarballPath))
        {
            _logger.LogDebug("npm pack output file not found: {Path}", tarballPath);
            return null;
        }

        _logger.LogDebug("Packed {PackageSpecifier} to {TarballPath}", NpmPackageInfo.FormatPackageSpecifier(packageName, version), tarballPath);

        return tarballPath;
    }

    /// <inheritdoc />
    public async Task<bool> InstallGlobalAsync(string tarballPath, CancellationToken cancellationToken)
    {
        var npmPath = FindNpmPath();
        if (npmPath is null)
        {
            return false;
        }

        _logger.LogDebug("Installing npm package globally from {TarballPath}", tarballPath);

        // Use an isolated temp subdirectory so npm doesn't pick up .npmrc or
        // other config files from the shared temp root or the user's CWD.
        var tempDir = CreateIsolatedTempDirectory();

        try
        {
            await PinNpmLocalPrefixAsync(tempDir, cancellationToken);

            // The root tarball is provenance-verified, but its transitive dependencies are not.
            // Prevent dependency lifecycle scripts from executing during installation.
            var output = await RunNpmCommandInDirectoryAsync(
                npmPath,
                ["install", "-g", tarballPath, "--ignore-scripts", "--registry", _internalRegistry],
                tempDir,
                cancellationToken);

            if (output is null)
            {
                _logger.LogDebug("Failed to install npm package globally from {TarballPath}", tarballPath);
                return false;
            }

            _logger.LogDebug("Successfully installed npm package globally from {TarballPath}", tarballPath);
            return true;
        }
        finally
        {
            CleanupTempDirectory(tempDir);
        }
    }

    private string? FindNpmPath()
    {
        var npmPath = _npmPath.Value;
        if (npmPath is null)
        {
            _logger.LogDebug("npm is not installed or not found in PATH");
        }

        return npmPath;
    }

    /// <summary>
    /// Builds the <c>npm view</c> argument list that resolves a package from the internal registry
    /// with no ambient npm configuration in effect.
    /// </summary>
    /// <remarks>
    /// Every argument here is load-bearing, so this list is built in one place and asserted by
    /// <c>NpmRunnerTests</c>:
    /// <list type="bullet">
    /// <item><description>
    /// <c>--registry</c> alone is NOT enough. A user-level <c>@microsoft:registry=</c> takes
    /// precedence over it, so <c>--userconfig</c> and <c>--globalconfig</c> point at freshly
    /// created empty files to make <c>--registry</c> authoritative.
    /// </description></item>
    /// <item><description>
    /// <c>--cache</c> uses a private directory so a previously cached answer from a different
    /// registry cannot satisfy the request, and <c>--prefer-online</c> revalidates metadata.
    /// </description></item>
    /// <item><description>
    /// <c>--json=false</c> forces deterministic text output. An inherited <c>json=true</c> makes
    /// <c>npm view &lt;pkg&gt; version</c> print a quoted JSON string (<c>"13.4.6"</c>), which the
    /// version parser rejects.
    /// </description></item>
    /// </list>
    /// See https://docs.npmjs.com/cli/v11/using-npm/config and
    /// https://docs.npmjs.com/cli/v11/configuring-npm/npmrc#files.
    /// </remarks>
    internal static string[] CreateAnonymousInternalRegistryViewArguments(
        string packageSpecifier,
        string registry,
        string userConfigPath,
        string globalConfigPath,
        string cacheDirectory)
        =>
        [
            "view",
            packageSpecifier,
            "version",
            "--registry", registry,
            "--userconfig", userConfigPath,
            "--globalconfig", globalConfigPath,
            "--cache", cacheDirectory,
            "--prefer-online",
            "--json=false"
        ];

    private string CreateIsolatedTempDirectory()
    {
        if (TempDirectoryRootOverride is not { } root)
        {
            return Directory.CreateTempSubdirectory("aspire-npm-").FullName;
        }

        // Only tests reach this branch, and they supply a directory they already created and own.
        // Directory.CreateTempSubdirectory has no overload that accepts a parent, so the unique-name
        // behavior is mirrored here rather than composing a path under Path.GetTempPath().
        return Directory.CreateDirectory(Path.Combine(root, $"aspire-npm-{Path.GetRandomFileName()}")).FullName;
    }

    /// <summary>
    /// Pins npm's "local prefix" to <paramref name="directory"/> by writing a private marker
    /// <c>package.json</c> into it.
    /// </summary>
    /// <remarks>
    /// npm resolves the local prefix by walking UP from the working directory until it finds a
    /// directory containing <c>package.json</c> or <c>node_modules</c>, and then reads that
    /// directory's <c>.npmrc</c> as the per-project config. Without a marker file the walk escapes
    /// our temp directory into the shared temp root (for example the world-writable <c>/tmp</c> on
    /// Linux), where a planted <c>.npmrc</c> can set a scoped registry such as
    /// <c>@microsoft:registry=</c>. A scoped registry takes precedence over the <c>--registry</c>
    /// argument, so the marker is what actually makes <c>--registry</c> authoritative here.
    /// See https://docs.npmjs.com/cli/v11/configuring-npm/npmrc#files and
    /// https://docs.npmjs.com/cli/v11/using-npm/config#npmrc-files.
    /// </remarks>
    private static async Task PinNpmLocalPrefixAsync(string directory, CancellationToken cancellationToken)
    {
        await File.WriteAllTextAsync(
            Path.Combine(directory, "package.json"),
            """{"name":"aspire-npm-isolated","version":"0.0.0","private":true}""",
            cancellationToken);
    }

    private void CleanupTempDirectory(string tempDir)
    {
        try
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
        catch (IOException ex)
        {
            _logger.LogDebug(ex, "Failed to clean up temporary directory: {TempDir}", tempDir);
        }
    }

    /// <summary>
    /// Creates a <see cref="ProcessStartInfo"/> configured to run an npm command.
    /// On Windows, .cmd files are invoked via cmd.exe /c for reliable stdout redirection.
    /// </summary>
    internal static ProcessStartInfo CreateNpmProcessStartInfo(string npmPath, string[] args, string workingDirectory, IEnvironment environment)
    {
        var startInfo = new ProcessStartInfo
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory
        };

        // On Windows, npm resolves to npm.cmd (a batch wrapper). Launching
        // .cmd files via Process.Start with redirected stdout can produce empty
        // output. Use cmd.exe /c to invoke the batch file reliably.
        // Note: cmd.exe /c has special quote-stripping rules that are incompatible
        // with ArgumentList (which individually quotes each argument). We must use
        // the Arguments string property and wrap the entire command in an outer set
        // of quotes so cmd.exe preserves interior quoting correctly.
        if (environment.IsWindows() && npmPath.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
        {
            startInfo.FileName = "cmd.exe";
            startInfo.Arguments = @$"/c """"{npmPath}"" {string.Join(" ", args.Select(a => @$"""{a}"""))}""";
        }
        else
        {
            startInfo.FileName = npmPath;
            foreach (var arg in args)
            {
                startInfo.ArgumentList.Add(arg);
            }
        }

        return startInfo;
    }

    /// <summary>
    /// Tries to extract the version string from npm view output. When a version range
    /// matches multiple versions, npm returns multi-line output in the format
    /// <c>@scope/pkg@version 'version'</c> per line, sorted ascending. This method
    /// returns the last (highest) version from such output, or the trimmed output
    /// when it contains a single version.
    /// </summary>
    internal static bool TryExtractLastVersion(string npmOutput, [NotNullWhen(true)] out string? version)
    {
        version = null;

        var lastLine = npmOutput
            .Split(['\n', '\r'], StringSplitOptions.RemoveEmptyEntries)
            .LastOrDefault()?
            .Trim();

        if (string.IsNullOrEmpty(lastLine))
        {
            return false;
        }

        // Multi-version format: "@scope/pkg@version 'version'" — extract the quoted version.
        // Single-version format: just "version" — return as-is.
        var quoteStart = lastLine.IndexOf('\'');
        if (quoteStart >= 0)
        {
            var quoteEnd = lastLine.IndexOf('\'', quoteStart + 1);
            if (quoteEnd > quoteStart)
            {
                version = lastLine[(quoteStart + 1)..quoteEnd];
                return !string.IsNullOrEmpty(version);
            }
        }

        version = lastLine;
        return true;
    }

    private async Task<string?> RunNpmCommandInDirectoryAsync(string npmPath, string[] args, string workingDirectory, CancellationToken cancellationToken)
        => await RunNpmCommandInDirectoryAsync(
            npmPath,
            args,
            workingDirectory,
            removeAmbientNpmConfiguration: false,
            cancellationToken);

    private async Task<string?> RunNpmCommandInDirectoryAsync(
        string npmPath,
        string[] args,
        string workingDirectory,
        bool removeAmbientNpmConfiguration,
        CancellationToken cancellationToken)
    {
        var argsString = string.Join(" ", args);
        _logger.LogDebug("Running npm {Args} in {WorkingDirectory}", argsString, workingDirectory);

        try
        {
            var startInfo = CreateNpmProcessStartInfo(npmPath, args, workingDirectory, _environment);
            if (removeAmbientNpmConfiguration)
            {
                RemoveAmbientNpmConfiguration(startInfo);
            }

            using var process = new Process { StartInfo = startInfo };
            using var activity = _profilingTelemetry.StartNpmCommand(npmPath, args, workingDirectory);
            process.Start();
            activity.SetProcessId(process.Id);

            // Read both streams concurrently to avoid deadlock when either pipe buffer fills.
            // The reads intentionally have no caller cancellation token: after cancellation we
            // terminate the process, then observe both tasks within the same bounded drain budget.
            var outputTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
            var errorTask = process.StandardError.ReadToEndAsync(CancellationToken.None);

            try
            {
                await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                await TerminateNpmProcessAsync(process).ConfigureAwait(false);
                await ObserveProcessStreamsAfterTerminationAsync(outputTask, errorTask).ConfigureAwait(false);
                throw;
            }

            activity.SetProcessExitCode(process.ExitCode);
            await Task.WhenAll(outputTask, errorTask).ConfigureAwait(false);
            var output = await outputTask.ConfigureAwait(false);
            var errorOutput = await errorTask.ConfigureAwait(false);

            if (process.ExitCode != 0)
            {
                activity.SetError($"npm exited with code {process.ExitCode}.");
                _logger.LogDebug("npm {Args} returned non-zero exit code {ExitCode}: {Error}", argsString, process.ExitCode, errorOutput.Trim());
                return null;
            }

            return output;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _logger.LogDebug(ex, "Failed to run npm {Args}", argsString);
            return null;
        }
    }

    private static void RemoveAmbientNpmConfiguration(ProcessStartInfo startInfo)
    {
        var keysToRemove = startInfo.Environment.Keys
            .Where(key =>
                key.StartsWith("NPM_CONFIG_", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("NODE_AUTH_TOKEN", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("NPM_TOKEN", StringComparison.OrdinalIgnoreCase))
            .ToArray();

        foreach (var key in keysToRemove)
        {
            startInfo.Environment.Remove(key);
        }
    }

    private async Task TerminateNpmProcessAsync(Process process)
    {
        try
        {
            if (process.HasExited)
            {
                return;
            }

            _logger.LogDebug("Terminating npm process {ProcessId} because the operation was cancelled.", process.Id);
            process.Kill(entireProcessTree: true);
            if (!await WaitWithinTerminationBudgetAsync(
                process.WaitForExitAsync(CancellationToken.None),
                _timeProvider).ConfigureAwait(false))
            {
                _logger.LogDebug(
                    "npm process {ProcessId} did not exit within {Timeout} after termination.",
                    process.Id,
                    ProcessTerminationTimeout);
            }
        }
        catch (Exception ex) when (IsExpectedProcessTerminationException(ex))
        {
            _logger.LogDebug(ex, "Unable to terminate npm process after cancellation.");
        }
    }

    private async Task ObserveProcessStreamsAfterTerminationAsync(Task outputTask, Task errorTask)
    {
        var streamsTask = Task.WhenAll(outputTask, errorTask);

        try
        {
            if (!await WaitWithinTerminationBudgetAsync(streamsTask, _timeProvider).ConfigureAwait(false))
            {
                _logger.LogDebug(
                    "npm output streams did not close within {Timeout} after process termination.",
                    ProcessTerminationTimeout);
            }
        }
        catch (Exception ex) when (IsExpectedProcessStreamTerminationException(ex))
        {
            _logger.LogDebug(ex, "npm output streams failed while draining after process termination.");
        }
    }

    /// <summary>
    /// Waits up to <see cref="ProcessTerminationTimeout"/> for <paramref name="task"/> and reports
    /// whether it completed within that budget.
    /// </summary>
    /// <remarks>
    /// Both post-kill waits go through this helper because killing a process guarantees neither
    /// that it is reaped nor that its redirected pipes close: an orphaned grandchild that inherited
    /// the stdout/stderr handles keeps them open. Awaiting either without a budget would let a stuck
    /// npm process tree hang CLI exit indefinitely. On timeout the wait is abandoned with a fault
    /// observer attached so the abandoned task cannot resurface as an unobserved task exception.
    /// </remarks>
    internal static async Task<bool> WaitWithinTerminationBudgetAsync(
        Task task,
        TimeProvider timeProvider)
    {
        try
        {
            await task.WaitAsync(ProcessTerminationTimeout, timeProvider).ConfigureAwait(false);
            return true;
        }
        catch (TimeoutException)
        {
            _ = task.ContinueWith(
                static continuedTask => _ = continuedTask.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return false;
        }
    }

    private static bool IsExpectedProcessStreamTerminationException(Exception exception)
        => exception switch
        {
            IOException or ObjectDisposedException => true,
            AggregateException { InnerExceptions.Count: > 0 } aggregateException =>
                aggregateException.InnerExceptions.All(IsExpectedProcessStreamTerminationException),
            _ => false
        };

    internal static bool IsExpectedProcessTerminationException(Exception exception)
        => exception switch
        {
            InvalidOperationException or System.ComponentModel.Win32Exception => true,
            AggregateException { InnerExceptions.Count: > 0 } aggregateException =>
                aggregateException.InnerExceptions.All(IsExpectedProcessTerminationException),
            _ => false
        };
}
