// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;

namespace Aspire.Cli.Utils.EnvironmentChecker;

/// <summary>
/// Checks if running in WSL environment and detects potential issues.
/// </summary>
internal sealed partial class WslEnvironmentCheck : IEnvironmentCheck
{
    internal const string CheckName = "wsl";

    private const string ProcVersionPath = "/proc/version";
    private const string WslDistroNameVariable = "WSL_DISTRO_NAME";

    private readonly IEnvironment _environment;
    private readonly Func<string?> _readProcVersion;

    public WslEnvironmentCheck(IEnvironment environment)
        : this(environment, TryReadProcVersion)
    {
    }

    // Lets tests supply a kernel banner without depending on the host actually being WSL.
    internal WslEnvironmentCheck(IEnvironment environment, Func<string?> readProcVersion)
    {
        _environment = environment;
        _readProcVersion = readProcVersion;
    }

    public int Order => 20; // Fast check - file system reads

    public Task<IReadOnlyList<EnvironmentCheckResult>> CheckAsync(CancellationToken cancellationToken = default)
    {
        // WSL detection only relevant on Linux
        if (!_environment.IsLinux())
        {
            // Not running on Linux, nothing to check
            return Task.FromResult<IReadOnlyList<EnvironmentCheckResult>>([]);
        }

        // Read the kernel banner once and reuse it for both detection and version classification so
        // the two decisions cannot disagree about what the file said.
        var procVersion = _readProcVersion();

        if (!IsRunningInWsl(procVersion))
        {
            // Running on native Linux, nothing to check
            return Task.FromResult<IReadOnlyList<EnvironmentCheckResult>>([]);
        }

        return Task.FromResult<IReadOnlyList<EnvironmentCheckResult>>([CreateResult(DetermineWslVersion(procVersion))]);
    }

    /// <summary>
    /// Builds the reported row for a classified WSL environment. An undetermined version reports a
    /// warning rather than a pass: doctor must not assert an environment it was unable to observe.
    /// </summary>
    internal static EnvironmentCheckResult CreateResult(WslVersion wslVersion) => wslVersion switch
    {
        WslVersion.Wsl1 => new EnvironmentCheckResult
        {
            Category = EnvironmentCheckCategories.Environment,
            Name = CheckName,
            Status = EnvironmentCheckStatus.Warning,
            Message = "WSL1 detected - limited container support",
            Fix = "Upgrade to WSL2 for best experience: wsl --set-version <distro> 2",
            Link = "https://aka.ms/aspire-prerequisites#wsl-setup"
        },
        WslVersion.Wsl2 => new EnvironmentCheckResult
        {
            Category = EnvironmentCheckCategories.Environment,
            Name = CheckName,
            Status = EnvironmentCheckStatus.Pass,
            Message = "WSL2 environment detected",
            Details = "If you experience container connectivity issues, ensure Docker Desktop WSL integration is enabled."
        },
        _ => new EnvironmentCheckResult
        {
            Category = EnvironmentCheckCategories.Environment,
            Name = CheckName,
            Status = EnvironmentCheckStatus.Warning,
            Message = "WSL detected but the version could not be determined",
            Details = $"Could not classify the WSL version from {ProcVersionPath}. WSL1 has limited container support, so this environment may not be able to run containers.",
            // The upgrade is stated conditionally because a custom WSL 2 kernel also lands here. Telling
            // an unclassified environment to upgrade would reintroduce the unconditional "upgrade to WSL2"
            // advice this check exists to stop giving to users who are already on WSL 2.
            Fix = "Run 'wsl --list --verbose' from Windows to check the version. If it reports 1, upgrade with: wsl --set-version <distro> 2",
            Link = "https://aka.ms/aspire-prerequisites#wsl-setup"
        }
    };

    /// <summary>
    /// Determines whether the current Linux environment is WSL, using the kernel banner when it is
    /// readable and falling back to the variable WSL injects into every distribution shell.
    /// </summary>
    private bool IsRunningInWsl(string? procVersion)
    {
        // Only the kernel release identifies WSL. The rest of the banner is build and compiler identity,
        // which legitimately contains these markers on machines that are not WSL:
        //   Linux version 6.8.0-64-generic (Microsoft@builder) (x86_64-linux-gnu-gcc-13 ...) #67 SMP ...
        // Scanning the whole banner reported that kernel as WSL and warned a user who has no WSL at all.
        // Likewise, only the complete observed Microsoft release shapes identify WSL here:
        //   4.4.0-19041-Microsoft
        //   4.19.121-microsoft-WSL2-standard
        //   4.19.84-microsoft-standard
        //   5.15.90.1-microsoft-standard-WSL2
        // Custom releases such as "6.1.0-custom-WSL2", "6.1.0-microsoft-standard-custom",
        // "6.1.0-custom-microsoft-standard", or "6.1.0-custom-microsoft-standard-WSL2" are not
        // official kernels and must fall back to the distro-name check instead of being treated as WSL.
        var kernelRelease = GetKernelRelease(procVersion);
        if (kernelRelease is not null && IsOfficialWslKernelRelease(kernelRelease))
        {
            return true;
        }

        return !string.IsNullOrWhiteSpace(_environment.GetEnvironmentVariable(WslDistroNameVariable));
    }

    /// <summary>
    /// Classifies the WSL version from the contents of <c>/proc/version</c>, returning
    /// <see cref="WslVersion.Unknown"/> when the contents do not identify a version.
    /// </summary>
    internal static WslVersion DetermineWslVersion(string? procVersion)
    {
        var kernelRelease = GetKernelRelease(procVersion);
        if (kernelRelease is null)
        {
            return WslVersion.Unknown;
        }

        // WSL 1 has no real kernel. It reports a fixed 4.4.0 compatibility banner with a "-Microsoft"
        // suffix, kept only so tools that parse a kernel version keep working:
        //   Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) ...
        // Because 4.4.0 is a constant rather than a real release, it must not be compared ordinally
        // against WSL 2 kernels; early WSL 2 shipped 4.19, so any "major >= 4" test classifies real
        // WSL 1 systems as WSL 2. See https://learn.microsoft.com/windows/wsl/compare-versions
        //
        // The complete release is matched, not just the "4.4." prefix: a custom kernel such as
        //   Linux version 4.4.1-custom (Microsoft@builder) ...
        // is not WSL 1, and reporting it as WSL 1 would tell that user to perform an upgrade they
        // cannot perform. An unrecognized release falls through to Unknown, which is the state this
        // check exists to report.
        if (Wsl1KernelRelease().IsMatch(kernelRelease))
        {
            return WslVersion.Wsl1;
        }

        // Official WSL 2 kernels identify themselves only by these complete release shapes:
        //   Linux version 4.19.121-microsoft-WSL2-standard (oe-user@oe-host) (...) #1 SMP ...
        //   Linux version 4.19.84-microsoft-standard (oe-user@oe-host) (...) #1 SMP ...
        //   Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host) (...) #1 SMP ...
        // Match the complete release case-insensitively and culture-invariantly so custom releases such as
        //   Linux version 6.1.0-custom-WSL2 (builder@host) ...
        //   Linux version 6.1.0-microsoft-standard-custom (builder@host) ...
        //   Linux version 6.1.0-custom-microsoft-standard (builder@host) ...
        //   Linux version 6.1.0-custom-microsoft-standard-WSL2 (builder@host) ...
        // fall through to Unknown instead of being reported as supported WSL 2 kernels.
        // See https://learn.microsoft.com/windows/wsl/kernel-release-notes
        if (Wsl2KernelRelease().IsMatch(kernelRelease))
        {
            return WslVersion.Wsl2;
        }

        // A custom WSL 2 kernel configured through .wslconfig can omit both markers. Report the
        // version as undetermined instead of guessing, because either guess is confidently wrong:
        // claiming WSL 2 hides the container limitations this check exists to surface, and claiming
        // WSL 1 tells a WSL 2 user to perform an upgrade they do not need.
        return WslVersion.Unknown;
    }

    /// <summary>
    /// Extracts the kernel release token from a <c>/proc/version</c> banner, or <see langword="null"/>
    /// when there is no banner to read or it does not carry a recognizable release.
    /// </summary>
    private static string? GetKernelRelease(string? procVersion)
    {
        if (string.IsNullOrWhiteSpace(procVersion))
        {
            return null;
        }

        // The banner is "Linux version <release> (<build identity>) (<compiler>) #<build> <date>":
        //   Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host) (x86_64-msft-linux-gcc (GCC) 9.3.0) #1 SMP ...
        // Only <release> names the kernel. Every marker this class looks for is matched against the
        // release alone so that a build identity such as "(microsoft-standard@builder)" or "(wsl2@builder)"
        // on an otherwise ordinary kernel cannot be read as evidence of WSL.
        var match = KernelRelease().Match(procVersion);

        return match.Success ? match.Groups["release"].Value : null;
    }

    private static string? TryReadProcVersion()
    {
        try
        {
            return File.Exists(ProcVersionPath) ? File.ReadAllText(ProcVersionPath) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // An unreadable banner must degrade to "unknown" so the caller reports a warning rather
            // than silently assuming a version.
            return null;
        }
    }

    private static bool IsOfficialWslKernelRelease(string kernelRelease) =>
        Wsl1KernelRelease().IsMatch(kernelRelease) || Wsl2KernelRelease().IsMatch(kernelRelease);

    // Matches the complete WSL 1 compatibility release, "4.4.0-<build>-Microsoft". The build number is
    // the Windows build the distribution runs on (for example 19041). Anchored so that a real kernel
    // whose release merely starts with 4.4.0 is not mistaken for the compatibility banner.
    [GeneratedRegex(@"^4\.4\.0-\d+-Microsoft$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Wsl1KernelRelease();

    // Matches the complete official WSL 2 release line. Older Microsoft-shipped 4.19 kernels used
    // "<numeric release>-microsoft-WSL2-standard" before the current
    // "<numeric release>-microsoft-standard[-WSL2]" naming. See:
    // - https://github.com/microsoft/WSL/issues/5437
    // - https://github.com/microsoft/WSL/issues/5439
    // - https://github.com/microsoft/WSL/issues/5476
    // Anchored so custom names that only start or end with the same tokens are not mistaken for
    // Microsoft-built kernels.
    [GeneratedRegex(@"^\d+(?:\.\d+)+-(?:microsoft-standard(?:-WSL2)?|microsoft-WSL2-standard)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Wsl2KernelRelease();

    // The kernel release is the first whitespace-delimited token after "Linux version".
    [GeneratedRegex(@"Linux\s+version\s+(?<release>\S+)", RegexOptions.IgnoreCase)]
    private static partial Regex KernelRelease();
}

/// <summary>
/// The WSL version detected for the current environment.
/// </summary>
internal enum WslVersion
{
    /// <summary>WSL 1, which emulates Linux system calls and has limited container support.</summary>
    Wsl1,

    /// <summary>WSL 2, which runs a real Linux kernel in a lightweight VM.</summary>
    Wsl2,

    /// <summary>WSL was detected but the version could not be determined.</summary>
    Unknown
}
