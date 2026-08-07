// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Utils.EnvironmentChecker;
using Aspire.Cli.Tests.Utils;

namespace Aspire.Cli.Tests.Commands;

public class WslEnvironmentCheckTests
{
    // Real banner from a WSL 1 distribution. WSL 1 has no kernel of its own and always reports this
    // fixed 4.4.0 compatibility version, which is why an ordinal "major >= 4" comparison misreads it
    // as WSL 2. See https://learn.microsoft.com/windows/wsl/compare-versions
    private const string Wsl1Banner =
        "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) #488-Microsoft Mon Sep 01 13:43:00 PST 2020";

    private const string Wsl2Banner =
        "Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host) (x86_64-msft-linux-gcc (GCC) 9.3.0) #1 SMP Fri Jan 27 02:56:13 UTC 2023";

    private const string NewerWsl2Banner =
        "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@builder) (gcc (GCC) 11.2.0) #1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025";

    [Fact]
    public void DetermineWslVersion_ReportsWsl1_ForRealWsl1Banner()
    {
        // Regression test: WSL 1 reports kernel 4.4.0, so classifying by "major version >= 4"
        // reported every real WSL 1 system as WSL 2 and suppressed the limited-container warning.
        Assert.Equal(WslVersion.Wsl1, WslEnvironmentCheck.DetermineWslVersion(Wsl1Banner));
    }

    [Fact]
    public void DetermineWslVersion_ReportsWsl2_ForRealWsl2Banner()
    {
        Assert.Equal(WslVersion.Wsl2, WslEnvironmentCheck.DetermineWslVersion(Wsl2Banner));
    }

    [Fact]
    public void DetermineWslVersion_ReportsWsl2_ForNewerWsl2Kernel()
    {
        Assert.Equal(WslVersion.Wsl2, WslEnvironmentCheck.DetermineWslVersion(NewerWsl2Banner));
    }

    [Fact]
    public void DetermineWslVersion_ReportsUnknown_WhenBannerIsUnavailable()
    {
        Assert.Equal(WslVersion.Unknown, WslEnvironmentCheck.DetermineWslVersion(null));
    }

    [Fact]
    public void DetermineWslVersion_ReportsUnknown_WhenBannerIsBlank()
    {
        Assert.Equal(WslVersion.Unknown, WslEnvironmentCheck.DetermineWslVersion("   "));
    }

    [Fact]
    public void DetermineWslVersion_ReportsUnknown_ForCustomKernelWithoutMarkers()
    {
        // A custom kernel configured through .wslconfig carries neither the WSL2 marker nor the
        // WSL 1 compatibility banner, so neither version can be claimed.
        Assert.Equal(
            WslVersion.Unknown,
            WslEnvironmentCheck.DetermineWslVersion("Linux version 6.1.0-custom (builder@host) #1 SMP Tue Jan 2 00:00:00 UTC 2024"));
    }

    [Fact]
    public void DetermineWslVersion_ReportsUnknown_WhenMicrosoftBannerHasNoRecognizableVersion()
    {
        // Regression test for the opposite failure: an unparseable Microsoft banner used to fall
        // through to WSL 1 and tell the user to upgrade to WSL 2 they may already be running.
        Assert.Equal(
            WslVersion.Unknown,
            WslEnvironmentCheck.DetermineWslVersion("Linux version unknown-microsoft (build@host)"));
    }

    [Fact]
    public void CreateResult_ReportsWarning_WhenVersionIsUnknown()
    {
        // The core three-state guarantee: an undetermined version must never be reported as healthy.
        var result = WslEnvironmentCheck.CreateResult(WslVersion.Unknown);

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("WSL detected but the version could not be determined", result.Message);
        Assert.Contains("/proc/version", result.Details);
        Assert.NotNull(result.Fix);
    }

    [Fact]
    public void CreateResult_ReportsWarning_ForWsl1()
    {
        var result = WslEnvironmentCheck.CreateResult(WslVersion.Wsl1);

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("WSL1 detected - limited container support", result.Message);
    }

    [Fact]
    public void CreateResult_ReportsPass_ForWsl2()
    {
        var result = WslEnvironmentCheck.CreateResult(WslVersion.Wsl2);

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("WSL2 environment detected", result.Message);
    }

    [Fact]
    public async Task CheckAsync_ReportsNothing_WhenNotLinux()
    {
        var check = new WslEnvironmentCheck(TestEnvironment.CreateMacOS(), () => Wsl1Banner);

        Assert.Empty(await check.CheckAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task CheckAsync_ReportsNothing_WhenLinuxIsNotWsl()
    {
        var check = new WslEnvironmentCheck(
            TestEnvironment.CreateLinux(),
            () => "Linux version 6.8.0-generic (buildd@lcy02) #1 SMP PREEMPT_DYNAMIC Ubuntu");

        Assert.Empty(await check.CheckAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task CheckAsync_ReportsWarning_ForWsl1()
    {
        var check = new WslEnvironmentCheck(TestEnvironment.CreateLinux(), () => Wsl1Banner);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("WSL1 detected - limited container support", result.Message);
    }

    [Fact]
    public async Task CheckAsync_ReportsWarning_WhenBannerIsUnreadableButDistroNameIsSet()
    {
        // WSL injects WSL_DISTRO_NAME into every distribution shell, so the environment is known to
        // be WSL even when the kernel banner cannot be read. That combination must warn, not pass.
        var check = new WslEnvironmentCheck(
            TestEnvironment.CreateLinux(new Dictionary<string, string?> { ["WSL_DISTRO_NAME"] = "Ubuntu-22.04" }),
            () => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("WSL detected but the version could not be determined", result.Message);
    }

    [Fact]
    public async Task CheckAsync_ReportsPass_ForWsl2()
    {
        var check = new WslEnvironmentCheck(TestEnvironment.CreateLinux(), () => Wsl2Banner);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("WSL2 environment detected", result.Message);
    }
}
