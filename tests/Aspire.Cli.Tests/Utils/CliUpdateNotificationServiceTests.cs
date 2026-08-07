// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Interaction;
using Aspire.Cli.Npm;
using Aspire.Cli.NuGet;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Utils;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Semver;
using NuGetPackage = Aspire.Shared.NuGetPackageCli;
using Microsoft.AspNetCore.InternalTesting;

namespace Aspire.Cli.Tests.Utils;

public class CliUpdateNotificationServiceTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task PrereleaseWillRecommendUpgradeToPrereleaseOnSameVersionFamily()
    {
        var currentVersion = VersionHelper.GetDefaultTemplateVersion();
        TaskCompletionSource<string> suggestedVersionTcs = new();

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NuGetPackageCacheFactory = (sp) =>
            {
                var cache = new FakeNuGetPackageCache { GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    // Should be ignored because it's lower than current prerelease version.
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.3.1", Source = "nuget.org" },

                    // Should be selected because it is higher than 9.4.0-dev (dev and preview sort using alphabetical sort).
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.4.0-preview", Source = "nuget.org" }, 

                    // Should be ignored because it is lower than 9.4.0-dev (dev and preview sort using alpha).
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.4.0-beta", Source = "nuget.org" }
                ]) }; return cache;
            };

            configure.InteractionServiceFactory = (sp) =>
            {
                var interactionService = new TestInteractionService();
                interactionService.DisplayVersionUpdateNotificationCallback = (newerVersion) =>
                {
                    suggestedVersionTcs.SetResult(newerVersion);
                };

                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0-dev");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();
        var suggestedVersion = await suggestedVersionTcs.Task.DefaultTimeout();

        Assert.Equal("9.4.0-preview", suggestedVersion);
    }

    [Fact]
    public async Task PrereleaseWillRecommendUpgradeToStableInCurrentVersionFamily()
    {
        var currentVersion = VersionHelper.GetDefaultTemplateVersion();
        TaskCompletionSource<string> suggestedVersionTcs = new();

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NuGetPackageCacheFactory = (sp) =>
            {
                var cache = new FakeNuGetPackageCache { GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    // Should be selected because stable sorts higher than preview.
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.4.0", Source = "nuget.org" },

                    // Should be ignored because its prerelease but in a higher version family.
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.5.0-preview", Source = "nuget.org" },
                ]) }; return cache;
            };

            configure.InteractionServiceFactory = (sp) =>
            {
                var interactionService = new TestInteractionService();
                interactionService.DisplayVersionUpdateNotificationCallback = (newerVersion) =>
                {
                    suggestedVersionTcs.SetResult(newerVersion);
                };

                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0-dev");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();
        var suggestedVersion = await suggestedVersionTcs.Task.DefaultTimeout();

        Assert.Equal("9.4.0", suggestedVersion);
    }

    [Fact]
    public async Task StableWillOnlyRecommendGoingToNewerStable()
    {
        var currentVersion = VersionHelper.GetDefaultTemplateVersion();
        TaskCompletionSource<string> suggestedVersionTcs = new();

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NuGetPackageCacheFactory = (sp) =>
            {
                var cache = new FakeNuGetPackageCache { GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    // Should be ignored because its stable in a higher version family.
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.5.0", Source = "nuget.org" }, 

                    // Should be ignored because its prerelease but in a (even) higher version family.
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.6.0-preview", Source = "nuget.org" },
                ]) }; return cache;
            };

            configure.InteractionServiceFactory = (sp) =>
            {
                var interactionService = new TestInteractionService();
                interactionService.DisplayVersionUpdateNotificationCallback = (newerVersion) =>
                {
                    suggestedVersionTcs.SetResult(newerVersion);
                };

                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();
        var suggestedVersion = await suggestedVersionTcs.Task.DefaultTimeout();

        Assert.Equal("9.5.0", suggestedVersion);
    }

    [Fact]
    public void NotifyIfUpdateAvailable_WithoutCachedPackages_DoesNotNotify()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.InteractionServiceFactory = sp =>
            {
                var interactionService = new TestInteractionService();
                interactionService.DisplayVersionUpdateNotificationCallback = _ =>
                {
                    Assert.Fail("Should not notify before package metadata has been cached.");
                };

                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        notifier.NotifyIfUpdateAvailable();
    }

    [Fact]
    public async Task NotifyIfUpdateAvailable_UsesDotnetToolCommandForNativeAotToolStorePath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        TestInteractionService? interactionService = null;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            UseProcessPath(configure, "/home/test/.dotnet/tools/.store/aspire.cli/9.4.0/aspire.cli.linux-x64/9.4.0/tools/any/linux-x64/aspire");

            configure.NuGetPackageCacheFactory = _ => new FakeNuGetPackageCache
            {
                GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.5.0", Source = "nuget.org" }
                ])
            };

            configure.InteractionServiceFactory = _ =>
            {
                interactionService = new TestInteractionService();
                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();

        Assert.NotNull(interactionService);
        Assert.Equal("dotnet tool update -g Aspire.Cli", interactionService.LastVersionUpdateCommand);
    }

    [Fact]
    public async Task NotifyIfUpdateAvailable_UsesToolPathCommandForCustomToolPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var toolPath = Path.Combine(workspace.CreateDirectory("install").FullName, "custom tool path");
        var processPath = CreateCustomToolPathInstall(toolPath);
        TestInteractionService? interactionService = null;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            UseProcessPath(configure, processPath);

            configure.NuGetPackageCacheFactory = _ => new FakeNuGetPackageCache
            {
                GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.5.0", Source = "nuget.org" }
                ])
            };

            configure.InteractionServiceFactory = _ =>
            {
                interactionService = new TestInteractionService();
                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();

        Assert.NotNull(interactionService);
        Assert.Equal($"dotnet tool update --tool-path \"{toolPath}\" Aspire.Cli", interactionService.LastVersionUpdateCommand);
    }

    [Fact]
    public async Task NotifyIfUpdateAvailable_UsesAspireUpdateCommandForStandaloneArchivePath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        TestInteractionService? interactionService = null;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            UseProcessPath(configure, "/home/test/.aspire/bin/aspire");

            configure.NuGetPackageCacheFactory = _ => new FakeNuGetPackageCache
            {
                GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.5.0", Source = "nuget.org" }
                ])
            };

            configure.InteractionServiceFactory = _ =>
            {
                interactionService = new TestInteractionService();
                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();

        Assert.NotNull(interactionService);
        Assert.Equal("aspire update", interactionService.LastVersionUpdateCommand);
    }

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

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();

        Assert.NotNull(interactionService);
        Assert.Equal(0, nuGetCallCount);
        Assert.Equal("npm install -g @microsoft/aspire-cli@latest", interactionService.LastVersionUpdateCommand);
        Assert.True(notifier.IsUpdateAvailable());
    }

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

    [Fact]
    public async Task GetVersionStatusAsync_WhenNpmIsUnavailableReturnsSpecificErrorWithoutResolving()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        var resolveCallCount = 0;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                IsAvailable = false,
                ResolvePackageAsyncCallback = (_, _, _) =>
                {
                    Interlocked.Increment(ref resolveCallCount);
                    return Task.FromResult<NpmPackageInfo?>(null);
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        var status = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        Assert.Equal(0, Volatile.Read(ref resolveCallCount));
        Assert.Equal(
            "Unable to check for Aspire CLI updates because npm was not found on PATH.",
            status.UpdateCheckError);
    }

    [Fact]
    public async Task GetVersionStatusAsync_NpmResolutionTimeoutReturnsErrorAndCanRetry()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        var timeProvider = new FakeTimeProvider();
        var resolutionStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var resolveCallCount = 0;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.TimeProvider = timeProvider;
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                ResolvePackageAsyncCallback = async (_, _, cancellationToken) =>
                {
                    if (Interlocked.Increment(ref resolveCallCount) == 1)
                    {
                        resolutionStarted.TrySetResult();
                        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                    }

                    return CreateNpmPackageInfo("9.5.0");
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        var failedStatusTask = notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None);
        await resolutionStarted.Task.DefaultTimeout();
        timeProvider.Advance(CliUpdateNotifier.NpmResolutionTimeout);
        var failedStatus = await failedStatusTask.DefaultTimeout();

        var retryStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        Assert.Equal(2, Volatile.Read(ref resolveCallCount));
        Assert.Equal(
            "Timed out after 10 seconds while resolving @microsoft/aspire-cli@latest from the internal npm registry.",
            failedStatus.UpdateCheckError);
        Assert.Null(failedStatus.LatestVersion);
        Assert.Null(retryStatus.UpdateCheckError);
        Assert.Equal("9.5.0", retryStatus.LatestVersion);
    }

    [Fact]
    public async Task GetVersionStatusAsync_ThrownNpmResolutionFailureReturnsErrorAndCanRetry()
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
                    if (Interlocked.Increment(ref resolveCallCount) == 1)
                    {
                        throw new InvalidOperationException("The npm registry is unavailable.");
                    }

                    return Task.FromResult<NpmPackageInfo?>(CreateNpmPackageInfo("9.5.0"));
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        var failedStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();
        var retryStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        Assert.Equal(2, Volatile.Read(ref resolveCallCount));
        Assert.Equal("The npm registry is unavailable.", failedStatus.UpdateCheckError);
        Assert.Null(failedStatus.LatestVersion);
        Assert.Null(retryStatus.UpdateCheckError);
        Assert.Equal("9.5.0", retryStatus.LatestVersion);
    }

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

    [Fact]
    public async Task NpmResolution_WhenLaterCallerIsCanceled_OnlyLaterCallerThrowsWhileSharedResolutionSucceeds()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        using var cancellationTokenSource = new CancellationTokenSource();

        var resolveCallCount = 0;
        var resolutionStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var resolution = new TaskCompletionSource<NpmPackageInfo?>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                ResolvePackageAsyncCallback = (_, _, cancellationToken) =>
                {
                    Interlocked.Increment(ref resolveCallCount);
                    resolutionStarted.TrySetResult();
                    return resolution.Task.WaitAsync(cancellationToken);
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        var successfulWaiter = notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None);
        await resolutionStarted.Task.DefaultTimeout();

        var canceledWaiter = notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            cancellationTokenSource.Token);
        Assert.Equal(1, Volatile.Read(ref resolveCallCount));

        await cancellationTokenSource.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => canceledWaiter).DefaultTimeout();
        Assert.False(successfulWaiter.IsCompleted);

        resolution.SetResult(CreateNpmPackageInfo("9.5.0"));
        var successfulStatus = await successfulWaiter.DefaultTimeout();
        var laterStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        Assert.Equal(1, Volatile.Read(ref resolveCallCount));
        Assert.Equal("9.5.0", successfulStatus.LatestVersion);
        Assert.Equal("9.5.0", laterStatus.LatestVersion);
    }

    [Fact]
    public async Task NpmResolution_WhenFirstCallerIsCanceled_OnlyFirstCallerThrowsWhileSharedResolutionSucceeds()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        using var cancellationTokenSource = new CancellationTokenSource();

        var resolveCallCount = 0;
        var resolutionStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var resolution = new TaskCompletionSource<NpmPackageInfo?>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                ResolvePackageAsyncCallback = (_, _, cancellationToken) =>
                {
                    Interlocked.Increment(ref resolveCallCount);
                    resolutionStarted.TrySetResult();
                    return resolution.Task.WaitAsync(cancellationToken);
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        var canceledWaiter = notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            cancellationTokenSource.Token);
        await resolutionStarted.Task.DefaultTimeout();

        var successfulWaiter = notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None);
        Assert.Equal(1, Volatile.Read(ref resolveCallCount));

        await cancellationTokenSource.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => canceledWaiter).DefaultTimeout();
        Assert.False(successfulWaiter.IsCompleted);

        resolution.SetResult(CreateNpmPackageInfo("9.5.0"));
        var successfulStatus = await successfulWaiter.DefaultTimeout();
        var laterStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        Assert.Equal(1, Volatile.Read(ref resolveCallCount));
        Assert.Equal("9.5.0", successfulStatus.LatestVersion);
        Assert.Equal("9.5.0", laterStatus.LatestVersion);
    }

    [Fact]
    public async Task GetVersionStatusAsync_PreCanceledTokenIsObservedAfterNpmResolutionIsCached()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        using var cancellationTokenSource = new CancellationTokenSource();
        var resolveCallCount = 0;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                ResolvePackageAsyncCallback = (_, _, _) =>
                {
                    Interlocked.Increment(ref resolveCallCount);
                    return Task.FromResult<NpmPackageInfo?>(CreateNpmPackageInfo("9.5.0"));
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        var initialStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        await cancellationTokenSource.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => notifier.GetVersionStatusAsync(
                workspace.WorkspaceRoot,
                cancellationTokenSource.Token)).DefaultTimeout();

        var laterStatus = await notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None).DefaultTimeout();

        Assert.Equal(1, Volatile.Read(ref resolveCallCount));
        Assert.Equal("9.5.0", initialStatus.LatestVersion);
        Assert.Equal("9.5.0", laterStatus.LatestVersion);
    }

    [Fact]
    public async Task NpmResolutionIsCanceledWhenNotifierIsDisposed()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        var resolutionStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationObserved = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var allowCancellationToComplete = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var resolutionToken = CancellationToken.None;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                ResolvePackageAsyncCallback = async (_, _, cancellationToken) =>
                {
                    resolutionToken = cancellationToken;
                    resolutionStarted.TrySetResult();
                    try
                    {
                        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                        return null;
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        cancellationObserved.TrySetResult();
                        await allowCancellationToComplete.Task;
                        throw;
                    }
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        var provider = services.BuildServiceProvider();
        Task<CliVersionStatus>? statusTask = null;
        Task? disposeTask = null;

        try
        {
            var notifier = provider.GetRequiredService<ICliUpdateNotifier>();
            statusTask = notifier.GetVersionStatusAsync(
                workspace.WorkspaceRoot,
                CancellationToken.None);
            await resolutionStarted.Task.DefaultTimeout();

            Assert.True(resolutionToken.CanBeCanceled);

            disposeTask = Task.Run(provider.Dispose);
            await cancellationObserved.Task.DefaultTimeout();

            Assert.True(resolutionToken.IsCancellationRequested);
            Assert.False(disposeTask.IsCompleted);

            allowCancellationToComplete.TrySetResult();
            await disposeTask.DefaultTimeout();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => statusTask!).DefaultTimeout();
        }
        finally
        {
            allowCancellationToComplete.TrySetResult();
            provider.Dispose();

            if (disposeTask is not null)
            {
                await disposeTask.DefaultTimeout();
            }

            if (statusTask is not null)
            {
                try
                {
                    await statusTask.DefaultTimeout();
                }
                catch (OperationCanceledException)
                {
                }
            }
        }
    }

    [Fact]
    public async Task Dispose_ReturnsWhenNpmResolutionDoesNotStopWithinBudget()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        var timeProvider = new FakeTimeProvider();
        var disposeTimerObserver = new TimerObservingTimeProvider(
            timeProvider,
            CliUpdateNotifier.NpmResolutionDisposeTimeout);
        var resolutionStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var resolution = new TaskCompletionSource<NpmPackageInfo?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var resolutionToken = CancellationToken.None;

        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.TimeProvider = disposeTimerObserver;
            configure.NpmRunnerFactory = _ => new FakeNpmRunner
            {
                ResolvePackageAsyncCallback = (_, _, cancellationToken) =>
                {
                    resolutionToken = cancellationToken;
                    resolutionStarted.TrySetResult();
                    return resolution.Task;
                }
            };
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();
        var statusTask = notifier.GetVersionStatusAsync(
            workspace.WorkspaceRoot,
            CancellationToken.None);
        await resolutionStarted.Task.DefaultTimeout();

        var disposeTask = Task.Run(provider.Dispose);

        try
        {
            // Dispose only becomes time-dependent once it registers its drain timer. Advancing
            // before that point would leave the timer permanently pending and block Dispose.
            await disposeTimerObserver.TimerCreated.DefaultTimeout();
            timeProvider.Advance(CliUpdateNotifier.NpmResolutionDisposeTimeout);

            await disposeTask.DefaultTimeout();
            Assert.False(statusTask.IsCompleted);
        }
        finally
        {
            // Release the fake resolution even if an assertion above fails, so a failing test
            // reports that failure instead of hanging the test host on a blocked Dispose.
            resolution.TrySetCanceled(resolutionToken);
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => statusTask).DefaultTimeout();
    }

    [Fact]
    public async Task CallsAfterDisposeThrowObjectDisposedException()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(CreateNpmInstallEnvironment());
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();
        provider.Dispose();

        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None));
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => notifier.GetVersionStatusAsync(workspace.WorkspaceRoot, CancellationToken.None));
        Assert.Throws<ObjectDisposedException>(notifier.NotifyIfUpdateAvailable);
        Assert.Throws<ObjectDisposedException>(() => notifier.IsUpdateAvailable());
    }

    [Fact]
    public async Task StableWillNotRecommendUpdatingToPreview()
    {
        var currentVersion = VersionHelper.GetDefaultTemplateVersion();

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
        {
            configure.NuGetPackageCacheFactory = (sp) =>
            {
                var cache = new FakeNuGetPackageCache { GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.4.0-preview", Source = "nuget.org" },
                    new NuGetPackage { Id = "Aspire.Cli", Version = "9.5.0-preview", Source = "nuget.org" },
                ]) }; return cache;
            };

            configure.InteractionServiceFactory = (sp) =>
            {
                var interactionService = new TestInteractionService();
                interactionService.DisplayVersionUpdateNotificationCallback = (newerVersion) =>
                {
                    Assert.Fail("Should not suggest a preview version when current version is stable.");
                };

                return interactionService;
            };

            configure.CliUpdateNotifierFactory = sp => CreateCliUpdateNotifier(sp, "9.4.0");
        });

        using var provider = services.BuildServiceProvider();
        var notifier = provider.GetRequiredService<ICliUpdateNotifier>();

        await notifier.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        notifier.NotifyIfUpdateAvailable();
    }

    [Fact]
    public async Task NotifyIfUpdateAvailableAsync_WithNewerStableVersion_DoesNotThrow()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);

        // Replace the NuGetPackageCache with our test implementation
        var nugetCache = new FakeNuGetPackageCache
        {
            GetCliPackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<NuGetPackage>>([
                new NuGetPackage { Id = "Aspire.Cli", Version = "9.0.0", Source = "nuget.org" }
            ])
        };
        services.AddSingleton<INuGetPackageCache>(nugetCache);
        services.AddSingleton<ICliUpdateNotifier, CliUpdateNotifier>();

        using var provider = services.BuildServiceProvider();
        var service = provider.GetRequiredService<ICliUpdateNotifier>();

        // Act & Assert (should not throw)
        await service.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        service.NotifyIfUpdateAvailable();
    }

    [Fact]
    public async Task NotifyIfUpdateAvailableAsync_WithEmptyPackages_DoesNotThrow()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);

        // Replace the NuGetPackageCache with our test implementation
        services.AddSingleton<INuGetPackageCache>(new FakeNuGetPackageCache());
        services.AddSingleton<ICliUpdateNotifier, CliUpdateNotifier>();

        using var provider = services.BuildServiceProvider();
        var service = provider.GetRequiredService<ICliUpdateNotifier>();

        // Act & Assert (should not throw)
        await service.CheckForCliUpdatesAsync(workspace.WorkspaceRoot, CancellationToken.None).DefaultTimeout();
        service.NotifyIfUpdateAvailable();
    }

    private static string CreateCustomToolPathInstall(string toolPath)
    {
        var processPath = Path.Combine(toolPath, GetAspireExecutableName());
        var storeExecutablePath = Path.Combine(
            toolPath,
            ".store",
            "aspire.cli",
            "9.4.0",
            "aspire.cli.linux-x64",
            "9.4.0",
            "tools",
            "net10.0",
            "linux-x64",
            GetAspireExecutableName());

        Directory.CreateDirectory(toolPath);
        Directory.CreateDirectory(Path.GetDirectoryName(storeExecutablePath)!);
        File.WriteAllText(processPath, string.Empty);
        File.WriteAllText(storeExecutablePath, string.Empty);

        return processPath;
    }

    private static string GetAspireExecutableName()
    {
        return OperatingSystem.IsWindows() ? "aspire.exe" : "aspire";
    }

    private static IReadOnlyDictionary<string, string?> CreateNpmInstallEnvironment()
    {
        return new Dictionary<string, string?>
        {
            [NpmInstallDetection.PackageEnvironmentVariableName] = NpmInstallDetection.ExpectedPackageName,
            [NpmInstallDetection.PackageVersionEnvironmentVariableName] = "9.4.0",
            [NpmInstallDetection.PackageRidEnvironmentVariableName] = "linux-x64"
        };
    }

    private static void UseProcessPath(CliServiceCollectionTestOptions options, string? processPath)
    {
        options.ProcessPathProviderFactory = _ => new TestProcessPathProvider(processPath);
    }

    private static CliUpdateNotifierWithPackageVersionOverride CreateCliUpdateNotifier(IServiceProvider serviceProvider, string currentVersion)
    {
        return new CliUpdateNotifierWithPackageVersionOverride(
            currentVersion,
            serviceProvider.GetRequiredService<ILogger<CliUpdateNotifier>>(),
            serviceProvider.GetRequiredService<INuGetPackageCache>(),
            serviceProvider.GetRequiredService<INpmRunner>(),
            serviceProvider.GetRequiredService<IInteractionService>(),
            serviceProvider.GetRequiredService<IProcessPathProvider>(),
            serviceProvider.GetRequiredService<CliExecutionContext>(),
            serviceProvider.GetRequiredService<TimeProvider>());
    }

    private static NpmPackageInfo CreateNpmPackageInfo(string version)
    {
        return new NpmPackageInfo
        {
            Version = SemVersion.Parse(version, SemVersionStyles.Strict)
        };
    }
}

internal sealed class CliUpdateNotifierWithPackageVersionOverride(
    string currentVersion,
    ILogger<CliUpdateNotifier> logger,
    INuGetPackageCache nuGetPackageCache,
    INpmRunner npmRunner,
    IInteractionService interactionService,
    IProcessPathProvider processPathProvider,
    CliExecutionContext executionContext,
    TimeProvider timeProvider)
    : CliUpdateNotifier(
        logger,
        nuGetPackageCache,
        npmRunner,
        interactionService,
        processPathProvider,
        executionContext,
        timeProvider)
{
    protected override SemVersion? GetCurrentVersion()
    {
        return SemVersion.Parse(currentVersion, SemVersionStyles.Strict);
    }
}