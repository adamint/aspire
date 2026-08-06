# npm CLI Update Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover npm-installed Aspire CLI updates through `dotnet-public-npm` and make every stable release seed and anonymously verify the mirrored `@microsoft/aspire-cli` package before channel promotion.

**Architecture:** `CliUpdateNotifier` will branch before NuGet lookup: npm launches resolve `@microsoft/aspire-cli@latest` through the existing `INpmRunner`, while non-npm launches retain the current NuGet path. The notifier will share one in-flight npm resolution, retain successful metadata for the process lifetime, clear failures so an explicit `aspire doctor` check can retry, and cancel and drain the npm child process when the notifier is disposed. The release pipeline will continue publishing only to public npm, stage the selected source build's npm artifacts even on stable publish-skipped reruns, authenticate to `dotnet-public-npm`, install the exact released pointer package to trigger upstream ingestion, switch to a fresh credential-free working directory, user/global configuration, and cache, and require anonymous `@latest` resolution at or above the released version before promotion.

**Tech Stack:** .NET 10, C# 13, `Semver`, xUnit v3 with Microsoft.Testing.Platform, Azure Pipelines YAML, PowerShell 7, npm, Azure Artifacts `npmAuthenticate@0`

---

## File map

No new production source files are required. Keep update-source selection in the existing notifier and keep npm process/registry ownership in the existing runner.

| File | Responsibility |
|---|---|
| `src/Aspire.Cli/Utils/CliUpdateNotifier.cs` | Select npm versus NuGet update discovery, cache npm resolution, and classify the selected update. |
| `tests/Aspire.Cli.Tests/Utils/CliUpdateNotificationServiceTests.cs` | Prove npm launches ignore NuGet, compare npm `latest`, retry failures, and reuse in-flight/successful resolution. |
| `tests/Aspire.Cli.Tests/TestServices/FakePlaywrightServices.cs` | Make the shared `FakeNpmRunner` configurable. |
| `tests/Aspire.Cli.Tests/Npm/NpmRunnerTests.cs` | Prove the existing runner resolves Aspire CLI `latest` through `dotnet-public-npm` and parses npm output. |
| `eng/pipelines/release-publish-nuget.yml` | Seed the authenticated mirror and verify anonymous visibility before promotion, including publish-skipped reruns. |
| `tests/Infrastructure.Tests/Pipelines/ReleasePublishNugetPipelineTests.cs` | Lock down release gating, ordering, authentication, anonymous isolation, and retries. |
| `docs/specs/npm-cli-package.md` | Document mirrored update discovery and release-time seeding. |
| `docs/release-process.md` | Document safe reruns and mirror troubleshooting. |

### Task 1: Route npm update discovery through `INpmRunner`

**Consumed by:** Tasks 3 and 4 — documentation and final validation depend on the finished CLI behavior

**Files:**
- Modify: `tests/Aspire.Cli.Tests/TestServices/FakePlaywrightServices.cs:13-30`
- Modify: `tests/Aspire.Cli.Tests/Utils/CliUpdateNotificationServiceTests.cs:1-430`
- Modify: `tests/Aspire.Cli.Tests/Npm/NpmRunnerTests.cs:145-275`
- Modify: `src/Aspire.Cli/Utils/CliUpdateNotifier.cs:1-160`

- [ ] **Step 1: Restore the worktree SDK and dependencies**

Run from `/Volumes/DevDrive/source/repos/aspire-adamint/.worktrees/issue-17808-npm-update-guidance`:

```bash
./restore.sh
```

Expected: restore succeeds and the repository-local .NET SDK is available.

- [ ] **Step 2: Make the shared npm fake configurable**

Replace `FakeNpmRunner` with:

```csharp
internal sealed class FakeNpmRunner : INpmRunner
{
    public bool IsAvailable { get; set; } = true;

    public Func<string, string, CancellationToken, Task<NpmPackageInfo?>> ResolvePackageAsyncCallback { get; set; }
        = (_, _, _) => Task.FromResult<NpmPackageInfo?>(null);

    public Task<NpmPackageInfo?> ResolvePackageAsync(
        string packageName,
        string versionRange,
        CancellationToken cancellationToken)
        => ResolvePackageAsyncCallback(packageName, versionRange, cancellationToken);

    public Task<string?> PackAsync(
        string packageName,
        string version,
        string outputDirectory,
        CancellationToken cancellationToken)
        => Task.FromResult<string?>(null);

    public Task<bool> InstallGlobalAsync(string tarballPath, CancellationToken cancellationToken)
        => Task.FromResult(true);
}
```

- [ ] **Step 3: Replace the npm command-only test with source-selection coverage**

Add `using Aspire.Cli.Npm;` to `CliUpdateNotificationServiceTests.cs`.

Replace `NotifyIfUpdateAvailable_UsesNpmCommandForNpmInstall` with:

```csharp
[Fact]
public async Task NotifyIfUpdateAvailable_UsesNpmRegistryVersionForNpmInstall()
{
    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
    var nuGetCallCount = 0;
    TestInteractionService? interactionService = null;

    var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
    {
        UseProcessPath(configure, "/home/test/.aspire/bin/aspire");

        configure.NuGetPackageCacheFactory = _ => new FakeNuGetPackageCache
        {
            GetCliPackagesAsyncCallback = (_, _, _, _) =>
            {
                Interlocked.Increment(ref nuGetCallCount);
                return Task.FromResult<IEnumerable<NuGetPackage>>(
                [
                    new NuGetPackage { Id = "Aspire.Cli", Version = "99.0.0", Source = "nuget.org" }
                ]);
            }
        };
        configure.NpmRunnerFactory = _ => new FakeNpmRunner
        {
            ResolvePackageAsyncCallback = (packageName, versionRange, _) =>
            {
                Assert.Equal(NpmInstallDetection.ExpectedPackageName, packageName);
                Assert.Equal("latest", versionRange);
                return Task.FromResult<NpmPackageInfo?>(CreateNpmPackageInfo("9.5.0"));
            }
        };
        configure.InteractionServiceFactory = _ =>
        {
            interactionService = new TestInteractionService
            {
                DisplayVersionUpdateNotificationCallback = version => Assert.Equal("9.5.0", version)
            };
            return interactionService;
        };
        configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
    });

    using var provider = services.BuildServiceProvider();
    var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

    await notifier.CheckForCliUpdatesAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None).DefaultTimeout();
    notifier.NotifyIfUpdateAvailable();

    Assert.NotNull(interactionService);
    Assert.Equal(0, nuGetCallCount);
    Assert.Equal(
        "npm install -g @microsoft/aspire-cli@latest",
        interactionService.LastVersionUpdateCommand);
    Assert.True(notifier.IsUpdateAvailable());
}
```

- [ ] **Step 4: Add equal-and-older npm version coverage**

Add:

```csharp
[Theory]
[InlineData("9.4.0")]
[InlineData("9.3.0")]
public async Task NotifyIfUpdateAvailable_DoesNotNotifyWhenNpmLatestIsNotNewer(
    string latestVersion)
{
    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());

    var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
    {
        configure.NpmRunnerFactory = _ => new FakeNpmRunner
        {
            ResolvePackageAsyncCallback = (_, _, _) =>
                Task.FromResult<NpmPackageInfo?>(CreateNpmPackageInfo(latestVersion))
        };
        configure.InteractionServiceFactory = _ => new TestInteractionService
        {
            DisplayVersionUpdateNotificationCallback = _ =>
                Assert.Fail("An equal or older npm latest version must not produce an update notification.")
        };
        configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
    });

    using var provider = services.BuildServiceProvider();
    var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

    await notifier.CheckForCliUpdatesAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None).DefaultTimeout();
    notifier.NotifyIfUpdateAvailable();

    Assert.False(notifier.IsUpdateAvailable());
}
```

- [ ] **Step 5: Add failure-and-retry coverage for doctor**

Add:

```csharp
[Fact]
public async Task GetVersionStatusAsync_NpmResolutionFailureReturnsErrorAndCanRetry()
{
    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
    var resolveCallCount = 0;

    var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
    {
        configure.NpmRunnerFactory = _ => new FakeNpmRunner
        {
            ResolvePackageAsyncCallback = (_, _, _) =>
            {
                var call = Interlocked.Increment(ref resolveCallCount);
                return Task.FromResult<NpmPackageInfo?>(
                    call == 1 ? null : CreateNpmPackageInfo("9.5.0"));
            }
        };
        configure.InteractionServiceFactory = _ => new TestInteractionService
        {
            DisplayVersionUpdateNotificationCallback = _ =>
                Assert.Fail("A failed npm lookup must not produce an update notification.")
        };
        configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
    });

    using var provider = services.BuildServiceProvider();
    var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

    var failedStatus = await notifier.GetVersionStatusAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None).DefaultTimeout();
    notifier.NotifyIfUpdateAvailable();

    Assert.Equal(
        "Unable to resolve @microsoft/aspire-cli@latest from the internal npm registry.",
        failedStatus.UpdateCheckError);
    Assert.Null(failedStatus.LatestVersion);

    var retryStatus = await notifier.GetVersionStatusAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None).DefaultTimeout();

    Assert.Equal(2, resolveCallCount);
    Assert.Null(retryStatus.UpdateCheckError);
    Assert.Equal("9.5.0", retryStatus.LatestVersion);
}
```

The first call deliberately returns a synchronously completed `null` task. The production cache must clear the failed task after assignment, not only when the underlying operation completes asynchronously.

- [ ] **Step 6: Add in-flight and successful-result reuse coverage**

Add:

```csharp
[Fact]
public async Task NpmResolutionIsSharedAcrossConcurrentAndLaterChecks()
{
    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());

    var resolveCallCount = 0;
    var resolutionStarted = new TaskCompletionSource(
        TaskCreationOptions.RunContinuationsAsynchronously);
    var resolution = new TaskCompletionSource<NpmPackageInfo?>(
        TaskCreationOptions.RunContinuationsAsynchronously);

    var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
    {
        configure.NpmRunnerFactory = _ => new FakeNpmRunner
        {
            ResolvePackageAsyncCallback = (_, _, _) =>
            {
                Interlocked.Increment(ref resolveCallCount);
                resolutionStarted.TrySetResult();
                return resolution.Task;
            }
        };
        configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
    });

    using var provider = services.BuildServiceProvider();
    var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

    var prefetchTask = notifier.CheckForCliUpdatesAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None);
    await resolutionStarted.Task.DefaultTimeout();

    var doctorTask = notifier.GetVersionStatusAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None);
    Assert.Equal(1, Volatile.Read(ref resolveCallCount));

    resolution.SetResult(CreateNpmPackageInfo("9.5.0"));
    await prefetchTask.DefaultTimeout();
    var doctorStatus = await doctorTask.DefaultTimeout();

    var laterStatus = await notifier.GetVersionStatusAsync(
        workspace.WorkspaceRoot,
        CancellationToken.None).DefaultTimeout();

    Assert.Equal(1, Volatile.Read(ref resolveCallCount));
    Assert.Equal("9.5.0", doctorStatus.LatestVersion);
    Assert.Equal("9.5.0", laterStatus.LatestVersion);
}
```

- [ ] **Step 7: Add the npm package-info helper**

Add near the private helpers at the bottom of the test class:

```csharp
private static NpmPackageInfo CreateNpmPackageInfo(string version)
{
    return new NpmPackageInfo
    {
        Version = SemVersion.Parse(version, SemVersionStyles.Strict)
    };
}
```

- [ ] **Step 8: Run the notifier tests and observe the failure**

Run:

```bash
dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-launch-profile -- \
  --filter-method "*.NotifyIfUpdateAvailable_UsesNpmRegistryVersionForNpmInstall" \
  --filter-method "*.NotifyIfUpdateAvailable_DoesNotNotifyWhenNpmLatestIsNotNewer" \
  --filter-method "*.GetVersionStatusAsync_NpmResolutionFailureReturnsErrorAndCanRetry" \
  --filter-method "*.NpmResolutionIsSharedAcrossConcurrentAndLaterChecks" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: FAIL because the current notifier queries NuGet for npm launches and never calls the npm fake.

- [ ] **Step 9: Inject `INpmRunner` and select the metadata source**

Add `using Aspire.Cli.Npm;` to `CliUpdateNotifier.cs`.

Change the constructor and fields to:

```csharp
internal class CliUpdateNotifier(
    ILogger<CliUpdateNotifier> logger,
    INuGetPackageCache nuGetPackageCache,
    INpmRunner npmRunner,
    IInteractionService interactionService,
    IProcessPathProvider processPathProvider,
    CliExecutionContext executionContext) : ICliUpdateNotifier, IDisposable
{
    private const string LatestNpmVersionRange = "latest";

    private readonly object _npmResolutionLock = new();
    private readonly CancellationTokenSource _npmResolutionCancellationSource = new();
    private IEnumerable<Shared.NuGetPackageCli>? _availablePackages;
    private NpmPackageInfo? _availableNpmPackage;
    private Task<NpmPackageInfo>? _npmResolutionTask;
```

Replace `CheckForCliUpdatesAsync` with:

```csharp
public async Task CheckForCliUpdatesAsync(
    DirectoryInfo workingDirectory,
    CancellationToken cancellationToken)
{
    if (NpmInstallDetection.IsRunningFromNpm())
    {
        _availablePackages = null;
        _availableNpmPackage = await GetLatestNpmPackageAsync(cancellationToken);
        return;
    }

    _availableNpmPackage = null;
    _availablePackages = await GetCliPackagesAsync(workingDirectory, cancellationToken);
}
```

Add before `GetCachedVersionStatus`:

```csharp
private async Task<NpmPackageInfo> GetLatestNpmPackageAsync(
    CancellationToken cancellationToken)
{
    Task<NpmPackageInfo> resolutionTask;

    lock (_npmResolutionLock)
    {
        resolutionTask = _npmResolutionTask ??= ResolveLatestNpmPackageAsync();
    }

    try
    {
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
    return await npmRunner.ResolvePackageAsync(
        NpmInstallDetection.ExpectedPackageName,
        LatestNpmVersionRange,
        _npmResolutionCancellationSource.Token)
        ?? throw new InvalidOperationException(
            $"Unable to resolve {NpmPackageInfo.FormatPackageSpecifier(NpmInstallDetection.ExpectedPackageName, LatestNpmVersionRange)} from the internal npm registry.");
}
```

Implement `Dispose()` by cancelling `_npmResolutionCancellationSource`,
waiting for the shared resolution task to finish, and then disposing the
source. Update `NpmRunner` so cancellation kills the npm process tree and waits
for it to exit before cleaning its temporary directory.

- [ ] **Step 10: Compare npm's concrete version and preserve existing status behavior**

Replace the XML documentation on `PackageUpdateRecommendationChannels` with:

```csharp
/// <summary>
/// Coarse-grained labels for the channel a recommended CLI update is pulled
/// from. NuGet discovery selects between stable and prerelease candidates,
/// while npm's <c>latest</c> dist-tag already identifies one concrete version.
/// Both paths classify the selected version by its prerelease flag. We
/// deliberately don't try to distinguish staging from daily here because the
/// version string alone cannot reliably identify the feed.
/// </summary>
```

Replace `GetCachedVersionStatus` with:

```csharp
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
```

Add immediately before `GetCliPackagesAsync`:

```csharp
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
```

Do not catch npm errors in `CheckForCliUpdatesAsync`. The existing background prefetcher suppresses routine-command failures, while `GetVersionStatusAsync` returns `UpdateCheckError` for doctor.

- [ ] **Step 11: Forward `INpmRunner` through the test-only notifier**

Replace the derived notifier declaration with:

```csharp
internal sealed class CliUpdateNotifierWithPackageVersionOverride(
    string currentVersion,
    ILogger<CliUpdateNotifier> logger,
    INuGetPackageCache nuGetPackageCache,
    INpmRunner npmRunner,
    IInteractionService interactionService,
    IProcessPathProvider processPathProvider,
    CliExecutionContext executionContext)
    : CliUpdateNotifier(
        logger,
        nuGetPackageCache,
        npmRunner,
        interactionService,
        processPathProvider,
        executionContext)
{
    protected override SemVersion? GetCurrentVersion()
    {
        return SemVersion.Parse(currentVersion, SemVersionStyles.Strict);
    }
}
```

Update `CreateCliUpdateNotifier` to:

```csharp
return new CliUpdateNotifierWithPackageVersionOverride(
    currentVersion,
    serviceProvider.GetRequiredService<ILogger<CliUpdateNotifier>>(),
    serviceProvider.GetRequiredService<INuGetPackageCache>(),
    serviceProvider.GetRequiredService<INpmRunner>(),
    serviceProvider.GetRequiredService<IInteractionService>(),
    serviceProvider.GetRequiredService<IProcessPathProvider>(),
    serviceProvider.GetRequiredService<CliExecutionContext>());
```

- [ ] **Step 12: Add a fake-executable regression test for the existing npm resolver**

Change the Windows fake npm script in `WriteFakeNpm` to:

```csharp
File.WriteAllText(
    Path.Combine(directory.FullName, "npm.cmd"),
    """
    @echo off
    type nul > "%NPM_ARGS_FILE%"
    :loop
    if "%~1"=="" goto output
    >> "%NPM_ARGS_FILE%" echo %~1
    shift
    goto loop
    :output
    if defined NPM_STDOUT echo %NPM_STDOUT%
    exit /b 0
    """);
```

Change the Unix fake script to:

```csharp
File.WriteAllText(
    npmPath,
    """
    #!/bin/sh
    printf '%s\n' "$@" > "$NPM_ARGS_FILE"
    if [ -n "$NPM_STDOUT" ]; then
      printf '%s\n' "$NPM_STDOUT"
    fi
    exit 0
    """);
```

Add next to `InstallGlobalAsync_UsesInternalRegistryForDependencies`:

```csharp
[Fact]
public async Task ResolvePackageAsync_UsesInternalRegistryForAspireCliLatest()
{
    var tempDirectory = Directory.CreateTempSubdirectory("aspire-npm-runner-test-");

    try
    {
        WriteFakeNpm(tempDirectory);
        var argumentsPath = Path.Combine(tempDirectory.FullName, "arguments.txt");
        var existingPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        using var pathOverride = new EnvVarOverride(
            "PATH",
            $"{tempDirectory.FullName}{Path.PathSeparator}{existingPath}");
        using var pathExtensionsOverride = OperatingSystem.IsWindows()
            ? new EnvVarOverride("PATHEXT", ".CMD")
            : null;
        using var argumentsPathOverride = new EnvVarOverride("NPM_ARGS_FILE", argumentsPath);
        using var stdoutOverride = new EnvVarOverride("NPM_STDOUT", "13.4.6");
        using var profilingTelemetry = new ProfilingTelemetry(new ConfigurationBuilder().Build());
        var runner = new NpmRunner(
            new TestEnvironment(),
            NullLogger<NpmRunner>.Instance,
            profilingTelemetry);

        var package = await runner.ResolvePackageAsync(
            NpmInstallDetection.ExpectedPackageName,
            "latest",
            TestContext.Current.CancellationToken);

        Assert.NotNull(package);
        Assert.Equal("13.4.6", package.Version.ToString());
        Assert.Equal(
            [
                "view",
                "@microsoft/aspire-cli@latest",
                "version",
                "--registry",
                "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"
            ],
            await File.ReadAllLinesAsync(
                argumentsPath,
                TestContext.Current.CancellationToken));
    }
    finally
    {
        tempDirectory.Delete(recursive: true);
    }
}
```

- [ ] **Step 13: Run the focused CLI test classes**

Run:

```bash
dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-launch-profile -- \
  --filter-class "*.CliUpdateNotificationServiceTests" \
  --filter-class "*.NpmRunnerTests" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: PASS. Existing platform-specific tests may remain skipped.

- [ ] **Step 14: Commit the CLI behavior**

```bash
git add \
  src/Aspire.Cli/Utils/CliUpdateNotifier.cs \
  tests/Aspire.Cli.Tests/Utils/CliUpdateNotificationServiceTests.cs \
  tests/Aspire.Cli.Tests/TestServices/FakePlaywrightServices.cs \
  tests/Aspire.Cli.Tests/Npm/NpmRunnerTests.cs
git commit -m "Use npm metadata for CLI update checks" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 86c62423-1a61-4829-a270-df0da61481b3"
```

### Task 2: Seed and verify the internal npm mirror during release

**Consumed by:** Tasks 3 and 4 — documentation and live validation depend on the final release gate

**Files:**
- Modify: `tests/Infrastructure.Tests/Pipelines/ReleasePublishNugetPipelineTests.cs:275-330`
- Modify: `eng/pipelines/release-publish-nuget.yml:1120-2000`

- [ ] **Step 1: Add a failing mirror-ordering test**

Add:

```csharp
[Fact]
public async Task SeedsAndAnonymouslyValidatesNpmInternalMirrorBeforePromotion()
{
    var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

    var publicValidationIndex = FindRequiredText(
        pipeline,
        "displayName: 'Validate Published npm Package from Registry'");
    var prepareAuthenticationIndex = FindRequiredText(
        pipeline,
        "displayName: 'Prepare npm Internal Mirror Authentication'");
    var authenticateIndex = FindRequiredText(
        pipeline,
        "displayName: 'Authenticate to npm Internal Mirror'");
    var seedIndex = FindRequiredText(
        pipeline,
        "displayName: 'Seed and Validate npm Internal Mirror'");
    var promotionIndex = FindRequiredText(
        pipeline,
        "# ===== PROMOTE TO CHANNEL =====");

    Assert.True(publicValidationIndex < prepareAuthenticationIndex);
    Assert.True(prepareAuthenticationIndex < authenticateIndex);
    Assert.True(authenticateIndex < seedIndex);
    Assert.True(seedIndex < promotionIndex);

    Assert.Contains("task: npmAuthenticate@0", pipeline, StringComparison.Ordinal);
    Assert.Contains(
        "workingFile: '$(Agent.TempDirectory)\\aspire-cli-internal-mirror.npmrc'",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains(
        "npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains(
        "$env:NPM_CONFIG_USERCONFIG = $anonymousNpmrc",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains(
        "$env:npm_config_cache = $anonymousCache",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains(
        "npm view \"$packageName@latest\" version",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains(
        "[version]$mirroredVersion -ge [version]$packageVersion",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains("$maxAttempts = 10", pipeline, StringComparison.Ordinal);
    Assert.Contains("Start-Sleep -Seconds 30", pipeline, StringComparison.Ordinal);
}
```

- [ ] **Step 2: Add a failing publish-skipped rerun test**

Add:

```csharp
[Fact]
public async Task NpmRegistryValidationRunsWhenBothNpmPublishFlagsAreSkipped()
{
    var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

    var nodeSetupGate =
        "- ${{ if or(eq(parameters.SkipNpmRidPublish, false), eq(parameters.SkipNpmPointerPublish, false), and(eq(parameters.DryRun, false), eq(parameters.IsPrerelease, false))) }}:";
    var stableRealGate =
        "- ${{ if and(eq(parameters.DryRun, false), eq(parameters.IsPrerelease, false)) }}:";
    var bothSkippedMessageIndex = FindRequiredText(
        pipeline,
        "displayName: 'Skip npm Packages (flagged)'");
    var nodeSetupGateIndex = FindRequiredText(pipeline, nodeSetupGate);
    var stableRealGateIndex = FindRequiredText(pipeline, stableRealGate);
    var publicValidationIndex = FindRequiredText(
        pipeline,
        "displayName: 'Validate Published npm Package from Registry'");
    var mirrorValidationIndex = FindRequiredText(
        pipeline,
        "displayName: 'Seed and Validate npm Internal Mirror'");

    Assert.True(nodeSetupGateIndex < bothSkippedMessageIndex);
    Assert.True(bothSkippedMessageIndex < stableRealGateIndex);
    Assert.True(stableRealGateIndex < publicValidationIndex);
    Assert.True(publicValidationIndex < mirrorValidationIndex);
    Assert.Contains(
        "##vso[task.setvariable variable=NpmPublishedPointerVersion]$packageVersion",
        pipeline,
        StringComparison.Ordinal);
    Assert.Contains(
        "$packageVersion = \"$(NpmPublishedPointerVersion)\"",
        pipeline,
        StringComparison.Ordinal);

    var obsoleteGate =
        "and(eq(parameters.DryRun, false), or(eq(parameters.SkipNpmRidPublish, false), eq(parameters.SkipNpmPointerPublish, false)), eq(parameters.IsPrerelease, false))";
    Assert.Equal(-1, pipeline.IndexOf(obsoleteGate, StringComparison.Ordinal));
}
```

- [ ] **Step 3: Run the focused infrastructure tests and observe the failure**

Run:

```bash
dotnet test --project tests/Infrastructure.Tests/Infrastructure.Tests.csproj --no-launch-profile -- \
  --filter-method "*.SeedsAndAnonymouslyValidatesNpmInternalMirrorBeforePromotion" \
  --filter-method "*.NpmRegistryValidationRunsWhenBothNpmPublishFlagsAreSkipped" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: FAIL because the rerun gate excludes both-skipped npm publication and no mirror steps exist.

- [ ] **Step 4: Stage npm artifacts and install Node.js for stable real reruns**

Replace the compile-time condition around each of these prepare/release blocks:

- `Download npm packages from Source Build`
- `Prepare npm Artifacts for Publishing`
- `Verify Staged npm Package Versions`
- `Install Node.js for npm Validation`

Use:

```yaml
              - ${{ if or(eq(parameters.SkipNpmRidPublish, false), eq(parameters.SkipNpmPointerPublish, false), and(eq(parameters.DryRun, false), eq(parameters.IsPrerelease, false))) }}:
```

Change `Prepare Empty npm Artifact Placeholders` to the inverse condition:

```yaml
              - ${{ if and(eq(parameters.SkipNpmRidPublish, true), eq(parameters.SkipNpmPointerPublish, true), not(and(eq(parameters.DryRun, false), eq(parameters.IsPrerelease, false)))) }}:
```

A stable mirror-only rerun does not submit npm packages, but it still needs
the selected source build's pointer tarball and validation summaries. The
public smoke derives the exact version from that staged pointer package, and
the staged-version check keeps the rerun on the same validated artifact path
as a normal release.

- [ ] **Step 5: Move the both-skipped message and broaden only the stable real block**

Move this existing block from below the public smoke test to immediately above the stable real block:

```yaml
              - ${{ if and(eq(parameters.SkipNpmRidPublish, true), eq(parameters.SkipNpmPointerPublish, true)) }}:
                - powershell: |
                    Write-Host "=== Skipping npm Publishing (SkipNpmRidPublish=true and SkipNpmPointerPublish=true) ==="
                  displayName: 'Skip npm Packages (flagged)'
```

Replace the stable block condition:

```yaml
              - ${{ if and(eq(parameters.DryRun, false), or(eq(parameters.SkipNpmRidPublish, false), eq(parameters.SkipNpmPointerPublish, false)), eq(parameters.IsPrerelease, false)) }}:
```

with:

```yaml
              - ${{ if and(eq(parameters.DryRun, false), eq(parameters.IsPrerelease, false)) }}:
```

Keep the existing nested publication templates controlled by `SkipNpmRidPublish` and `SkipNpmPointerPublish`. When both are true, the preflight reports that no packages are scheduled, public validation checks the already-published pointer package, and no public write occurs.

Change the RID-skip message inside the stable block to:

```powershell
Write-Host "Skipping npm RID packages. Pointer package handling follows SkipNpmPointerPublish."
```

- [ ] **Step 6: Export the exact version proven by the public smoke test**

Immediately after:

```powershell
Write-Host "aspire --version output matched the published npm package version: $versionLine"
```

add:

```powershell
Write-Host "##vso[task.setvariable variable=NpmPublishedPointerVersion]$packageVersion"
```

This variable is created only after public npm metadata, installation, and `aspire --version` all succeed.

- [ ] **Step 7: Prepare and authenticate a temporary internal-feed npm configuration**

Immediately after `Validate Published npm Package from Registry`, add:

```yaml
                - pwsh: |
                    $npmrcPath = "$(Agent.TempDirectory)\aspire-cli-internal-mirror.npmrc"
                    "registry=$(NPM_REGISTRY)" |
                      Set-Content -LiteralPath $npmrcPath -Encoding utf8NoBOM
                  displayName: 'Prepare npm Internal Mirror Authentication'

                - task: npmAuthenticate@0
                  displayName: 'Authenticate to npm Internal Mirror'
                  inputs:
                    workingFile: '$(Agent.TempDirectory)\aspire-cli-internal-mirror.npmrc'
```

`npmAuthenticate@0` uses the release build identity and removes its injected credentials during task cleanup. Do not print the file or delete it before that cleanup.

- [ ] **Step 8: Seed the exact package and anonymously verify `@latest`**

Add immediately after authentication:

```yaml
                - pwsh: |
                    $ErrorActionPreference = 'Stop'

                    $packageName = '@microsoft/aspire-cli'
                    $packageVersion = "$(NpmPublishedPointerVersion)"
                    $internalRegistry = "$(NPM_REGISTRY)"
                    $authenticatedNpmrc = "$(Agent.TempDirectory)\aspire-cli-internal-mirror.npmrc"

                    if ([string]::IsNullOrWhiteSpace($packageVersion) -or $packageVersion -like '$(*)') {
                      throw "NpmPublishedPointerVersion was not set by the public npm smoke test."
                    }

                    if ($packageVersion -notmatch '^\d+\.\d+\.\d+$') {
                      throw "Expected a stable npm package version, but received '$packageVersion'."
                    }

                    if ([string]::IsNullOrWhiteSpace($internalRegistry) -or $internalRegistry -like '$(*)') {
                      throw "NPM_REGISTRY was not provided."
                    }

                    $workRoot = Join-Path "$(Agent.TempDirectory)" 'aspire-cli-npm-mirror'
                    $seedDirectory = Join-Path $workRoot 'seed'
                    $authenticatedCache = Join-Path $workRoot 'authenticated-cache'
                    $anonymousCache = Join-Path $workRoot 'anonymous-cache'
                    $anonymousDirectory = Join-Path $workRoot 'anonymous'
                    $anonymousNpmrc = Join-Path $workRoot 'anonymous.npmrc'
                    $anonymousGlobalNpmrc = Join-Path $workRoot 'anonymous-global.npmrc'
                    $packageSpec = "$packageName@$packageVersion"

                    try {
                      if (Test-Path -LiteralPath $workRoot) {
                        Remove-Item -LiteralPath $workRoot -Recurse -Force
                      }

                      New-Item -ItemType Directory -Path $seedDirectory -Force | Out-Null
                      New-Item -ItemType Directory -Path $authenticatedCache -Force | Out-Null
                      New-Item -ItemType Directory -Path $anonymousCache -Force | Out-Null
                      New-Item -ItemType Directory -Path $anonymousDirectory -Force | Out-Null
                      "registry=$internalRegistry" |
                        Set-Content -LiteralPath $anonymousNpmrc -Encoding utf8NoBOM
                      New-Item -ItemType File -Path $anonymousGlobalNpmrc -Force | Out-Null

                      Write-Host "Seeding $packageSpec into $internalRegistry through its configured upstream."
                      $env:NPM_CONFIG_USERCONFIG = $authenticatedNpmrc
                      $env:npm_config_cache = $authenticatedCache

                      Push-Location $seedDirectory
                      try {
                        $seedOutput = npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false --loglevel=warn --registry=$internalRegistry $packageSpec 2>&1
                        $seedExitCode = $LASTEXITCODE
                      }
                      finally {
                        Pop-Location
                      }

                      $seedOutput | ForEach-Object { Write-Host $_ }
                      if ($seedExitCode -ne 0) {
                        throw "Failed to install $packageSpec through the internal npm mirror (exit code $seedExitCode)."
                      }

                      # Use a credential-free npmrc and a separate empty cache so this
                      # proves anonymous visibility instead of cached authenticated data.
                      $env:NPM_CONFIG_USERCONFIG = $anonymousNpmrc
                      $env:NPM_CONFIG_GLOBALCONFIG = $anonymousGlobalNpmrc
                      $env:npm_config_cache = $anonymousCache

                      Push-Location $anonymousDirectory
                      try {
                        $maxAttempts = 10
                        for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
                          Write-Host "Anonymous mirror verification attempt $attempt of $maxAttempts."
                          $viewOutput = npm view "$packageName@latest" version --prefer-online --registry=$internalRegistry --loglevel=warn 2>&1
                          $viewExitCode = $LASTEXITCODE
                          $viewOutput | ForEach-Object { Write-Host $_ }

                          $mirroredVersion = $viewOutput |
                            ForEach-Object { "$_".Trim() } |
                            Where-Object { $_ -match '^\d+\.\d+\.\d+$' } |
                            Select-Object -First 1

                          if ($viewExitCode -eq 0 -and
                              $mirroredVersion -and
                              [version]$mirroredVersion -ge [version]$packageVersion) {
                            Write-Host "Anonymous internal npm latest is $mirroredVersion, satisfying released version $packageVersion."
                            break
                          }

                          if ($attempt -eq $maxAttempts) {
                            throw "Internal npm mirror did not anonymously expose $packageName@latest at or above $packageVersion after $maxAttempts attempts."
                          }

                          Start-Sleep -Seconds 30
                        }
                      }
                      finally {
                        Pop-Location
                      }
                    }
                    finally {
                      Remove-Item Env:NPM_CONFIG_USERCONFIG -ErrorAction SilentlyContinue
                      Remove-Item Env:NPM_CONFIG_GLOBALCONFIG -ErrorAction SilentlyContinue
                      Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue

                      if (Test-Path -LiteralPath $workRoot) {
                        try {
                          Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop
                        } catch {
                          Write-Warning "Best-effort cleanup of '$workRoot' failed: $($_.Exception.Message)"
                        }
                      }
                    }
                  displayName: 'Seed and Validate npm Internal Mirror'
```

The authenticated install triggers upstream ingestion without adding another publication destination. The anonymous phase uses a fresh working directory, credential-free user and global configs, a separate empty cache, and online metadata preference. The at-or-above comparison permits a later stable release already mirrored on a safe rerun, and cleanup cannot mask a successful validation.

- [ ] **Step 9: Run the release pipeline tests**

Run:

```bash
dotnet test --project tests/Infrastructure.Tests/Infrastructure.Tests.csproj --no-launch-profile -- \
  --filter-class "*.ReleasePublishNugetPipelineTests" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: PASS.

- [ ] **Step 10: Inspect the release-gate diff**

Run:

```bash
git --no-pager diff -- \
  eng/pipelines/release-publish-nuget.yml \
  tests/Infrastructure.Tests/Pipelines/ReleasePublishNugetPipelineTests.cs
```

Confirm:

1. Dry runs and prereleases cannot reach mirror authentication, seeding, or anonymous verification.
2. Stable real runs install Node even when both npm publication flags are true.
3. Both publication templates retain their individual skip gates.
4. Public validation precedes mirror seeding, which precedes channel promotion.
5. No credentials or `.npmrc` contents are logged.

- [ ] **Step 11: Commit the release gate**

```bash
git add \
  eng/pipelines/release-publish-nuget.yml \
  tests/Infrastructure.Tests/Pipelines/ReleasePublishNugetPipelineTests.cs
git commit -m "Seed npm CLI package into internal mirror" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 86c62423-1a61-4829-a270-df0da61481b3"
```

### Task 3: Document mirrored update discovery and release recovery

**Consumed by:** Task 4 — final validation checks the documented behavior against the implementation

**Files:**
- Modify: `docs/specs/npm-cli-package.md:34-135`
- Modify: `docs/release-process.md:100-180`

- [ ] **Step 1: Document the update source and release seeding contract**

In `docs/specs/npm-cli-package.md`, add after the publication-destination paragraph:

```markdown
The package is still published only to the public npm registry. npm-installed CLI update checks resolve `@microsoft/aspire-cli@latest` through the anonymously readable `dotnet-public-npm` Azure Artifacts feed. Stable releases authenticate to that feed after the public npm smoke test, install the exact released pointer package to trigger upstream ingestion, then switch to a credential-free npm configuration and cache to verify that anonymous `@latest` resolution is at or above the released version before channel promotion.
```

Replace the update-notification paragraph with:

```markdown
The CLI checks how it was installed before selecting an update source. NuGet-installed or standalone launches retain the existing NuGet package lookup. npm-installed launches skip NuGet entirely and use the existing npm resolver for `@microsoft/aspire-cli@latest` from `dotnet-public-npm`; when that concrete version is newer than the running CLI, the notification shows `npm install -g @microsoft/aspire-cli@latest`. Routine commands suppress lookup failures, while `aspire doctor` reports the update-check warning and retries a failed lookup. Explicit `aspire update --self` behavior is unchanged.
```

- [ ] **Step 2: Document safe publish-skipped reruns**

In `docs/release-process.md`, add immediately after `### npm publish fails`:

````markdown
### npm internal mirror seeding or anonymous validation fails

The release pipeline seeds `@microsoft/aspire-cli` into `dotnet-public-npm` only after the public npm package smoke test succeeds. It then verifies `@microsoft/aspire-cli@latest` with a credential-free npm configuration and cache before channel promotion.

If public npm publication already succeeded, rerun the release with both `SkipNpmRidPublish=true` and `SkipNpmPointerPublish=true`. Keep `DryRun=false` so the public-registry smoke test and internal-mirror gate run, and set `SkipChannelPromotion=true` when validating a pipeline change or retrying the mirror independently. The rerun does not republish npm packages; it validates the existing public package, triggers authenticated upstream ingestion, and repeats anonymous verification.

If the authenticated install fails, verify that the release build identity still has contributor access to `dotnet-public-npm` and that the feed's npm.org upstream is enabled. If anonymous verification exhausts its retries, check the package version directly with a credential-free npm configuration:

```bash
NPM_CONFIG_USERCONFIG=/dev/null npm view @microsoft/aspire-cli@latest version \
  --registry https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/
```
````

- [ ] **Step 3: Review documentation formatting and claims**

Run:

```bash
git --no-pager diff --check
git --no-pager diff -- docs/specs/npm-cli-package.md docs/release-process.md
```

Expected: no whitespace errors. Confirm the docs do not claim direct publication to Azure Artifacts and do not imply `aspire update --self` changed.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/specs/npm-cli-package.md docs/release-process.md
git commit -m "Document npm CLI mirror validation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 86c62423-1a61-4829-a270-df0da61481b3"
```

### Task 4: Validate locally and prove the release path in Azure DevOps

**Consumed by:** nothing

**Files:**
- Verify: `src/Aspire.Cli/Utils/CliUpdateNotifier.cs`
- Verify: `tests/Aspire.Cli.Tests/Utils/CliUpdateNotificationServiceTests.cs`
- Verify: `eng/pipelines/release-publish-nuget.yml`
- Verify: `tests/Infrastructure.Tests/Pipelines/ReleasePublishNugetPipelineTests.cs`
- Verify: `docs/specs/npm-cli-package.md`
- Verify: `docs/release-process.md`

- [ ] **Step 1: Run all affected test classes**

Run:

```bash
dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-launch-profile -- \
  --filter-class "*.CliUpdateNotificationServiceTests" \
  --filter-class "*.NpmRunnerTests" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"

dotnet test --project tests/Infrastructure.Tests/Infrastructure.Tests.csproj --no-launch-profile -- \
  --filter-class "*.ReleasePublishNugetPipelineTests" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: all selected tests pass; existing platform-specific skips may remain.

- [ ] **Step 2: Build the repository without native AOT**

Run:

```bash
./build.sh --build /p:SkipNativeBuild=true
```

Expected: build succeeds with no new warnings.

- [ ] **Step 3: Run repository hygiene checks**

Run:

```bash
git --no-pager diff --check
git status --short
```

Expected: no whitespace errors and no uncommitted implementation changes.

- [ ] **Step 4: Invoke the internal Azure DevOps workflow**

Invoke the `azdo-internal` skill before interacting with `dnceng/internal`.

Trigger the Aspire internal release pipeline
(`microsoft-aspire-Release-To-NuGet`, definition `1600`) from this branch or
its internal mirror commit. Pin its `aspire-build` resource to a source run
from `microsoft-aspire` (definition `1602`) whose stable
`@microsoft/aspire-cli` pointer package already exists on public npm. Use:

```text
DryRun=false
IsPrerelease=false
SkipNuGetPublish=true
SkipNpmRidPublish=true
SkipNpmPointerPublish=true
SkipChannelPromotion=true
SkipWinGetPublish=true
SkipGitHubTasks=true
SkipReleaseAssets=true
SkipHomebrewValidation=true
SkipNixPackageUpdate=true
SkipVSCodeExtensionPublish=true
```

Expected: no public publication or channel promotion occurs. `Validate Published npm Package from Registry`, `Authenticate to npm Internal Mirror`, and `Seed and Validate npm Internal Mirror` run and pass.

- [ ] **Step 5: Independently verify anonymous resolution**

Run from a fresh directory with empty user/global configs and cache:

```bash
anonymous_root="$(mktemp -d)"
trap 'rm -rf "$anonymous_root"' EXIT
cd "$anonymous_root"

anonymous_npmrc="$PWD/user.npmrc"
anonymous_global_npmrc="$PWD/global.npmrc"
anonymous_cache="$PWD/cache"

printf '%s\n' \
  'registry=https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/' \
  > "$anonymous_npmrc"
touch "$anonymous_global_npmrc"
mkdir "$anonymous_cache"

NPM_CONFIG_USERCONFIG="$anonymous_npmrc" \
NPM_CONFIG_GLOBALCONFIG="$anonymous_global_npmrc" \
NPM_CONFIG_CACHE="$anonymous_cache" \
  npm view @microsoft/aspire-cli@latest version \
  --prefer-online \
  --registry https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/
```

Expected: npm prints a stable version at or above the public smoke test's `NpmPublishedPointerVersion` without authentication or `E401`.

- [ ] **Step 6: Correct any live-only failure under TDD and rerun**

For any correction:

1. Add or tighten an infrastructure test that reproduces the failure.
2. Run that test and observe the failure.
3. Make the smallest pipeline change that fixes it.
4. Run both affected test classes and `./build.sh --build /p:SkipNativeBuild=true`.
5. Commit with the required trailers.
6. Trigger the same safe Azure DevOps parameter set and require a successful terminal result.

Do not weaken the anonymous config/cache isolation, at-or-above version gate, stable non-dry gate, or pre-promotion ordering.
