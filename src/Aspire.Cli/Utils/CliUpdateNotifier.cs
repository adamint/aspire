// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using Aspire.Cli.Commands;
using Aspire.Cli.Interaction;
using Aspire.Cli.Npm;
using Aspire.Cli.NuGet;
using Aspire.Shared;
using Microsoft.Extensions.Logging;
using Semver;

namespace Aspire.Cli.Utils;

internal interface ICliUpdateNotifier
{
    Task CheckForCliUpdatesAsync(DirectoryInfo workingDirectory, CancellationToken cancellationToken);
    Task<CliVersionStatus> GetVersionStatusAsync(DirectoryInfo workingDirectory, CancellationToken cancellationToken);
    void NotifyIfUpdateAvailable();
    bool IsUpdateAvailable();
}

internal sealed record CliVersionStatus(
    string? CurrentVersion,
    string? LatestVersion,
    string? UpdateCommand,
    string? UpdateCheckError = null,
    string? LatestVersionChannel = null);

/// <summary>
/// Coarse-grained labels for the channel a recommended CLI update is pulled
/// from. NuGet discovery selects between stable and prerelease candidates,
/// while npm's <c>latest</c> dist-tag already identifies one concrete version.
/// Both paths classify the selected version by its prerelease flag. We
/// deliberately don't try to distinguish staging from daily here because the
/// version string alone cannot reliably identify the feed.
/// </summary>
internal static class PackageUpdateRecommendationChannels
{
    public const string Stable = "stable";
    public const string Prerelease = "prerelease";
}

internal class CliUpdateNotifier(
    ILogger<CliUpdateNotifier> logger,
    INuGetPackageCache nuGetPackageCache,
    INpmRunner npmRunner,
    IInteractionService interactionService,
    IProcessPathProvider processPathProvider,
    CliExecutionContext executionContext,
    TimeProvider timeProvider) : ICliUpdateNotifier, IDisposable
{
    private const string LatestNpmVersionRange = "latest";
    private static readonly TimeSpan s_npmResolutionTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan s_npmResolutionDisposeTimeout = TimeSpan.FromSeconds(2);

    private readonly object _npmResolutionLock = new();
    private readonly CancellationTokenSource _npmResolutionCancellationSource = new();
    private IEnumerable<Shared.NuGetPackageCli>? _availablePackages;
    private NpmPackageInfo? _availableNpmPackage;
    private Task<NpmPackageInfo>? _npmResolutionTask;
    private bool _disposed;

    internal static TimeSpan NpmResolutionTimeout => s_npmResolutionTimeout;
    internal static TimeSpan NpmResolutionDisposeTimeout => s_npmResolutionDisposeTimeout;

    public async Task CheckForCliUpdatesAsync(DirectoryInfo workingDirectory, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();

        if (NpmInstallDetection.IsRunningFromNpm())
        {
            _availablePackages = null;
            _availableNpmPackage = await GetLatestNpmPackageAsync(cancellationToken);
            return;
        }

        _availableNpmPackage = null;
        _availablePackages = await GetCliPackagesAsync(workingDirectory, cancellationToken);
    }

    public void NotifyIfUpdateAvailable()
    {
        ThrowIfDisposed();
        ValidateCliPackageMetadataPrefetching();
        var status = GetCachedVersionStatus();
        if (status.LatestVersion is not null)
        {
            interactionService.DisplayVersionUpdateNotification(status.LatestVersion, status.UpdateCommand);
        }
    }

    public async Task<CliVersionStatus> GetVersionStatusAsync(DirectoryInfo workingDirectory, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();

        try
        {
            // Callers that need a synchronous answer cannot rely on the background
            // prefetcher racing to populate the cache before command exit.
            // Refresh through the same method used by background update notifications so
            // NuGet source selection and cache mutation stay consistent.
            await CheckForCliUpdatesAsync(workingDirectory, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to check for Aspire CLI updates.");
            return GetCachedVersionStatus(ex.Message);
        }

        return GetCachedVersionStatus();
    }

    public bool IsUpdateAvailable()
    {
        ThrowIfDisposed();
        ValidateCliPackageMetadataPrefetching();
        return GetCachedVersionStatus().LatestVersion is not null;
    }

    [Conditional("DEBUG")]
    private void ValidateCliPackageMetadataPrefetching()
    {
        if (executionContext.Command is BaseCommand { PrefetchesCliPackageMetadata: false } command)
        {
            throw new PackageMetadataPrefetchingValidationException($"Command '{command.Name}' consumes cached CLI package metadata but does not enable {nameof(BaseCommand.PrefetchesCliPackageMetadata)}.");
        }
    }

    protected virtual SemVersion? GetCurrentVersion()
    {
        // physical-binary-version-by-design (see docs/specs/cli-identity-sidecar.md):
        // the update check compares the ACTUAL installed binary against the latest available
        // package to decide whether to recommend an update, so it must read the real assembly
        // version rather than an emulated ASPIRE_CLI_VERSION identity.
        return PackageUpdateHelpers.GetCurrentPackageVersion();
    }

    private async Task<NpmPackageInfo> GetLatestNpmPackageAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        Task<NpmPackageInfo> resolutionTask;

        lock (_npmResolutionLock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);

            resolutionTask = _npmResolutionTask ??= ResolveLatestNpmPackageAsync();
        }

        try
        {
            // The npm lookup is shared for the process lifetime, so one caller cannot own its
            // cancellation. Apply cancellation only while each caller waits for the shared result.
            return await resolutionTask.WaitAsync(cancellationToken);
        }
        catch when (resolutionTask.IsFaulted || resolutionTask.IsCanceled)
        {
            // Background notification checks may fail before an explicit doctor check.
            // Clear only this failed or cancelled task so doctor can make a fresh attempt.
            lock (_npmResolutionLock)
            {
                if (ReferenceEquals(_npmResolutionTask, resolutionTask))
                {
                    _npmResolutionTask = null;
                }
            }

            throw;
        }
    }

    private async Task<NpmPackageInfo> ResolveLatestNpmPackageAsync()
    {
        var packageSpecifier = NpmPackageInfo.FormatPackageSpecifier(
            NpmInstallDetection.ExpectedPackageName,
            LatestNpmVersionRange);

        if (!npmRunner.IsAvailable)
        {
            throw new InvalidOperationException(
                "Unable to check for Aspire CLI updates because npm was not found on PATH.");
        }

        using var timeoutSource = new CancellationTokenSource(NpmResolutionTimeout, timeProvider);
        using var resolutionSource = CancellationTokenSource.CreateLinkedTokenSource(
            _npmResolutionCancellationSource.Token,
            timeoutSource.Token);

        try
        {
            return await npmRunner.ResolvePackageFromAnonymousInternalRegistryAsync(
                NpmInstallDetection.ExpectedPackageName,
                LatestNpmVersionRange,
                resolutionSource.Token)
                ?? throw new InvalidOperationException(
                    $"Unable to resolve {packageSpecifier} from the internal npm registry.");
        }
        catch (OperationCanceledException) when (
            timeoutSource.IsCancellationRequested &&
            !_npmResolutionCancellationSource.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"Timed out after {NpmResolutionTimeout.TotalSeconds:g} seconds while resolving {packageSpecifier} from the internal npm registry.");
        }
    }

    private CliVersionStatus GetCachedVersionStatus(string? updateCheckError = null)
    {
        // Keep all version comparison and update-command selection in one place so
        // callers cannot disagree when package metadata has already been fetched.
        var currentVersion = GetCurrentVersion();
        var currentVersionString = currentVersion?.ToString() ?? PackageUpdateHelpers.GetCurrentAssemblyVersion();

        if (updateCheckError is not null)
        {
            return new CliVersionStatus(currentVersionString, null, null, updateCheckError);
        }

        if (_availablePackages is null && _availableNpmPackage is null)
        {
            return new CliVersionStatus(currentVersionString, null, null);
        }

        if (currentVersion is null)
        {
            logger.LogDebug("Unable to determine current CLI version for update check.");
            return new CliVersionStatus(currentVersionString, null, null);
        }

        var newerVersion = _availableNpmPackage is { } npmPackage
            ? GetNewerNpmVersion(currentVersion, npmPackage.Version)
            : PackageUpdateHelpers.GetNewerVersion(logger, currentVersion, _availablePackages!);
        var updateCommand = newerVersion is null
            ? null
            : DotNetToolDetection.GetDotNetToolUpdateCommand(processPathProvider.ProcessPath)
            ?? NpmInstallDetection.GetNpmUpdateCommand()
            ?? "aspire update";
        var latestChannel = newerVersion is null
            ? null
            : (newerVersion.IsPrerelease
                ? PackageUpdateRecommendationChannels.Prerelease
                : PackageUpdateRecommendationChannels.Stable);

        return new CliVersionStatus(
            currentVersionString,
            newerVersion?.ToString(),
            updateCommand,
            UpdateCheckError: null,
            LatestVersionChannel: latestChannel);
    }

    private SemVersion? GetNewerNpmVersion(
        SemVersion currentVersion,
        SemVersion latestVersion)
    {
        logger.LogDebug(
            "Current CLI version: {CurrentVersion}. Latest npm version: {LatestVersion}.",
            currentVersion,
            latestVersion);

        if (SemVersion.PrecedenceComparer.Compare(currentVersion, latestVersion) < 0)
        {
            logger.LogDebug(
                "Newer CLI version available from npm: {CurrentVersion} -> {LatestVersion}",
                currentVersion,
                latestVersion);
            return latestVersion;
        }

        logger.LogDebug("No newer CLI version is available from npm.");
        return null;
    }

    private async Task<IEnumerable<Shared.NuGetPackageCli>> GetCliPackagesAsync(DirectoryInfo workingDirectory, CancellationToken cancellationToken)
    {
        return await nuGetPackageCache.GetCliPackagesAsync(
            workingDirectory: workingDirectory,
            prerelease: true,
            nugetConfigFile: null,
            cancellationToken: cancellationToken);
    }

    public void Dispose()
    {
        Task<NpmPackageInfo>? resolutionTask;
        Task cancellationTask;

        lock (_npmResolutionLock)
        {
            if (_disposed)
            {
                return;
            }

            Volatile.Write(ref _disposed, true);
            resolutionTask = _npmResolutionTask;
            cancellationTask = _npmResolutionCancellationSource.CancelAsync();
        }

        var shutdownTask = resolutionTask is null
            ? cancellationTask
            : Task.WhenAll(cancellationTask, resolutionTask);

        try
        {
            // The host disposes services synchronously after stopping hosted services. Give the
            // shared lookup a short drain budget, but never let a stuck npm process hold shutdown.
            shutdownTask
                .WaitAsync(NpmResolutionDisposeTimeout, timeProvider)
                .GetAwaiter()
                .GetResult();
        }
        catch (TimeoutException)
        {
            logger.LogDebug(
                "npm update resolution did not stop within {Timeout} during disposal.",
                NpmResolutionDisposeTimeout);
        }
        catch (OperationCanceledException) when (_npmResolutionCancellationSource.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed while waiting for npm update resolution to stop.");
        }
        finally
        {
            if (shutdownTask.IsCompleted)
            {
                _npmResolutionCancellationSource.Dispose();
            }
            else
            {
                _ = shutdownTask.ContinueWith(
                    static (task, state) =>
                    {
                        _ = task.Exception;
                        ((CancellationTokenSource)state!).Dispose();
                    },
                    _npmResolutionCancellationSource,
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed), this);
    }
}
