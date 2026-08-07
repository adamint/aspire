// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Configuration;
using Aspire.Cli.Resources;
using Microsoft.Extensions.Logging;
using Semver;

namespace Aspire.Cli.Utils.EnvironmentChecker;

/// <summary>
/// Checks whether the Aspire VS Code extension is installed and current.
/// </summary>
/// <remarks>
/// The check is intentionally silent when VS Code is not detected. The installed version is taken
/// from the environment variable the extension itself contributes, so the Marketplace comparison only
/// runs when the active installation identified itself; otherwise the check falls back to reporting
/// whether the extension is installed at all.
/// </remarks>
internal sealed class VsCodeExtensionCheck : IEnvironmentCheck
{
    internal const string CheckName = "vscode-extension";

    /// <summary>
    /// The unique identifier of the Aspire VS Code extension (<c>&lt;publisher&gt;.&lt;name&gt;</c>).
    /// </summary>
    internal const string ExtensionId = "microsoft-aspire.aspire-vscode";

    /// <summary>
    /// The marketplace URL used as the fix link when the extension is missing. This is an aka.ms
    /// redirect so the ultimate destination can be updated without shipping a new CLI build.
    /// </summary>
    internal const string MarketplaceUrl = "https://aka.ms/aspire/vscode-extension";

    /// <summary>
    /// The environment variable the Aspire VS Code extension contributes to every terminal, task, and
    /// debug process it creates, carrying the version of the extension instance that is actually
    /// running. See <c>extension/src/utils/cliPathEnvironment.ts</c>.
    /// </summary>
    internal const string ExtensionVersionEnvironmentVariable = "ASPIRE_VSCODE_EXTENSION_VERSION";

    private const string StableChannel = "stable";
    private const string PreReleaseChannel = "pre-release";

    private readonly IEnvironment _environment;
    private readonly CliExecutionContext _executionContext;
    private readonly IVsCodeExtensionMarketplaceClient _marketplaceClient;
    private readonly IFeatures? _features;
    private readonly ILogger<VsCodeExtensionCheck> _logger;
    private readonly Func<string, string?> _commandResolver;

    public VsCodeExtensionCheck(
        IEnvironment environment,
        CliExecutionContext executionContext,
        IVsCodeExtensionMarketplaceClient marketplaceClient,
        IFeatures features,
        ILogger<VsCodeExtensionCheck> logger)
        : this(
            environment,
            executionContext,
            marketplaceClient,
            features,
            logger,
            PathLookupHelper.FindFullPathFromPath)
    {
    }

    internal VsCodeExtensionCheck(
        IEnvironment environment,
        CliExecutionContext executionContext,
        IVsCodeExtensionMarketplaceClient marketplaceClient,
        ILogger<VsCodeExtensionCheck> logger,
        Func<string, string?> commandResolver)
        : this(environment, executionContext, marketplaceClient, features: null, logger, commandResolver)
    {
    }

    internal VsCodeExtensionCheck(
        IEnvironment environment,
        CliExecutionContext executionContext,
        IVsCodeExtensionMarketplaceClient marketplaceClient,
        IFeatures? features,
        ILogger<VsCodeExtensionCheck> logger,
        Func<string, string?> commandResolver)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(executionContext);
        ArgumentNullException.ThrowIfNull(marketplaceClient);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(commandResolver);

        _environment = environment;
        _executionContext = executionContext;
        _marketplaceClient = marketplaceClient;
        _features = features;
        _logger = logger;
        _commandResolver = commandResolver;
    }

    // Runs after the fast environment and OS checks. The Marketplace lookup carries its own
    // timeout so a slow network cannot hold the whole doctor run open.
    public int Order => 60;

    public async Task<IReadOnlyList<EnvironmentCheckResult>> CheckAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var detection = Detect(_environment, _executionContext.HomeDirectory, _commandResolver);
        if (!detection.VsCodeInstalled)
        {
            return [];
        }

        var updateCheckEnabled =
            _features?.IsFeatureEnabled(KnownFeatures.UpdateNotificationsEnabled, defaultValue: true)
            ?? true;
        var metadata = BuildMetadata(detection, updateCheckEnabled);

        if (!detection.ExtensionInstalled)
        {
            return
            [
                new EnvironmentCheckResult
                {
                    Category = EnvironmentCheckCategories.DevelopmentTools,
                    Name = CheckName,
                    Status = EnvironmentCheckStatus.Warning,
                    Message = DoctorCommandStrings.VsCodeExtensionMissingMessage,
                    Fix = DoctorCommandStrings.VsCodeExtensionMissingFix,
                    Link = MarketplaceUrl,
                    Metadata = metadata
                }
            ];
        }

        // Without a version the extension reported for itself there is nothing to compare, so the
        // check answers the same question it did before the update comparison existed: is the
        // extension installed at all. Guessing a version off disk cannot identify which of several
        // installations the running window loaded.
        if (!updateCheckEnabled ||
            !SemVersion.TryParse(detection.ExtensionVersion, SemVersionStyles.Strict, out var installedVersion))
        {
            return [CreateInstalledResult(metadata, EnvironmentCheckStatus.Pass)];
        }

        VsCodeExtensionMarketplaceVersions versions;
        try
        {
            versions = await _marketplaceClient.GetLatestVersionsAsync(cancellationToken);
        }
        catch (TimeoutException exception)
        {
            _logger.LogDebug(exception, "The VS Code Marketplace version check timed out.");
            metadata["latestVersionError"] = "timeout";

            return
            [
                CreateInstalledResult(
                    metadata,
                    EnvironmentCheckStatus.Warning,
                    DoctorCommandStrings.VsCodeExtensionLatestVersionCheckTimedOutDetails)
            ];
        }
        catch (HttpRequestException exception)
        {
            return [CreateMarketplaceUnavailableResult(metadata, exception)];
        }
        catch (IOException exception)
        {
            return [CreateMarketplaceUnavailableResult(metadata, exception)];
        }
        catch (JsonException exception)
        {
            return [CreateMarketplaceUnavailableResult(metadata, exception)];
        }

        // The extension host API exposes the manifest version but not the gallery's pre-release flag,
        // so the channel is inferred from the version itself. Daily and PR builds carry a semver
        // pre-release tag and compare against the pre-release feed. A gallery pre-release install
        // published without such a tag compares against stable, which is safe: the gallery requires a
        // pre-release version to sort above the stable one, so the comparison passes instead of
        // nagging.
        var channel = installedVersion.IsPrerelease ? PreReleaseChannel : StableChannel;
        var latestVersion = installedVersion.IsPrerelease ? versions.PreReleaseVersion : versions.StableVersion;
        if (latestVersion is null)
        {
            // Comparing a pre-release install against the stable feed (or vice versa) would produce a
            // meaningless verdict, so report the lookup as unavailable rather than guessing.
            return [CreateMarketplaceUnavailableResult(metadata, $"The Marketplace response did not include a {channel} version.")];
        }

        var updateAvailable = SemVersion.ComparePrecedence(installedVersion, latestVersion) < 0;
        metadata["latestVersion"] = latestVersion.ToString();
        metadata["latestVersionChannel"] = channel;
        metadata["latestVersionKnown"] = true;
        metadata["updateAvailable"] = updateAvailable;

        if (!updateAvailable)
        {
            return [CreateInstalledResult(metadata, EnvironmentCheckStatus.Pass)];
        }

        return
        [
            new EnvironmentCheckResult
            {
                Category = EnvironmentCheckCategories.DevelopmentTools,
                Name = CheckName,
                Status = EnvironmentCheckStatus.Warning,
                Message = string.Format(
                    CultureInfo.CurrentCulture,
                    DoctorCommandStrings.VsCodeExtensionOutOfDateMessageFormat,
                    detection.ExtensionVersion,
                    latestVersion),
                Fix = DoctorCommandStrings.VsCodeExtensionOutOfDateFix,
                Link = MarketplaceUrl,
                Metadata = metadata
            }
        ];
    }

    internal static VsCodeExtensionDetection Detect(IEnvironment environment, DirectoryInfo homeDirectory)
        => Detect(environment, homeDirectory, PathLookupHelper.FindFullPathFromPath);

    // The command resolver is injected so tests can exercise the PATH-based detection fallback
    // deterministically; PathLookupHelper.FindFullPathFromPath reads the real process PATH, which
    // cannot be mocked via IEnvironment and would otherwise leave that branch untested (and flaky
    // on machines that happen to have "code" on PATH).
    internal static VsCodeExtensionDetection Detect(
        IEnvironment environment,
        DirectoryInfo homeDirectory,
        Func<string, string?> commandResolver)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(homeDirectory);
        ArgumentNullException.ThrowIfNull(commandResolver);

        if (!IsVsCodeInstalled(environment, commandResolver))
        {
            return new VsCodeExtensionDetection(VsCodeInstalled: false, ExtensionInstalled: false);
        }

        // The extension contributes its own version to every terminal, task, and debug process VS Code
        // creates for it, so this is the version of the instance that is actually running. Nothing on
        // disk can answer that: several extension roots can hold the extension at once (desktop plus
        // .vscode-server for Remote/WSL/devcontainers), --extensions-dir is invisible to a child
        // process, and portable mode relocates the whole root.
        var reportedVersion = environment.GetEnvironmentVariable(ExtensionVersionEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(reportedVersion))
        {
            return new VsCodeExtensionDetection(
                VsCodeInstalled: true,
                ExtensionInstalled: true,
                ExtensionVersion: reportedVersion.Trim());
        }

        // Outside a VS Code-created process there is no signal, so fall back to answering only whether
        // the extension is installed somewhere.
        return new VsCodeExtensionDetection(
            VsCodeInstalled: true,
            ExtensionInstalled: IsExtensionInstalled(environment, homeDirectory));
    }

    private EnvironmentCheckResult CreateMarketplaceUnavailableResult(JsonObject metadata, Exception exception)
    {
        _logger.LogDebug(exception, "The VS Code Marketplace version check was unavailable.");

        return CreateMarketplaceUnavailableResult(metadata);
    }

    private EnvironmentCheckResult CreateMarketplaceUnavailableResult(JsonObject metadata, string reason)
    {
        _logger.LogDebug("The VS Code Marketplace version check was unavailable. {Reason}", reason);

        return CreateMarketplaceUnavailableResult(metadata);
    }

    private static EnvironmentCheckResult CreateMarketplaceUnavailableResult(JsonObject metadata)
    {
        metadata["latestVersionError"] = "unavailable";

        return CreateInstalledResult(
            metadata,
            EnvironmentCheckStatus.Warning,
            DoctorCommandStrings.VsCodeExtensionLatestVersionCheckUnavailableDetails);
    }

    private static EnvironmentCheckResult CreateInstalledResult(
        JsonObject metadata,
        EnvironmentCheckStatus status,
        string? details = null)
        => new()
        {
            Category = EnvironmentCheckCategories.DevelopmentTools,
            Name = CheckName,
            Status = status,
            Message = DoctorCommandStrings.VsCodeExtensionInstalledMessage,
            Details = details,
            Metadata = metadata
        };

    private static JsonObject BuildMetadata(
        VsCodeExtensionDetection detection,
        bool updateCheckEnabled)
    {
        var metadata = new JsonObject
        {
            ["vsCodeInstalled"] = detection.VsCodeInstalled,
            ["extensionInstalled"] = detection.ExtensionInstalled,
            ["extensionId"] = ExtensionId
        };

        if (!detection.ExtensionInstalled)
        {
            return metadata;
        }

        metadata["updateCheckEnabled"] = updateCheckEnabled;
        metadata["latestVersionKnown"] = false;
        if (detection.ExtensionVersion is not null)
        {
            metadata["extensionVersion"] = detection.ExtensionVersion;
        }

        return metadata;
    }

    private static bool IsVsCodeInstalled(
        IEnvironment environment,
        Func<string, string?> commandResolver)
    {
        // VS Code sets TERM_PROGRAM for integrated terminals. Outside an integrated terminal,
        // probe the stable and Insiders launchers without spawning either process.
        // See https://code.visualstudio.com/docs/terminal/shell-integration.
        return string.Equals(
                environment.GetEnvironmentVariable("TERM_PROGRAM"),
                "vscode",
                StringComparison.OrdinalIgnoreCase)
            || commandResolver("code") is not null
            || commandResolver("code-insiders") is not null;
    }

    private static bool IsExtensionInstalled(IEnvironment environment, DirectoryInfo homeDirectory)
    {
        foreach (var extensionsDirectory in VsCodeInstallLayout.GetExtensionRootPaths(environment, homeDirectory))
        {
            if (DirectoryContainsExtension(extensionsDirectory))
            {
                return true;
            }
        }

        return false;
    }

    private static bool DirectoryContainsExtension(string extensionsDirectory)
    {
        if (!Directory.Exists(extensionsDirectory))
        {
            return false;
        }

        try
        {
            // IgnoreInaccessible lets the probe skip an unreadable extension folder and keep scanning
            // the rest, instead of throwing and reporting the whole extensions root as "not found" (a
            // false warning even when the Aspire extension is installed alongside an inaccessible one).
            // The parameterless EnumerateDirectories overload uses legacy behavior that throws instead.
            // AttributesToSkip is reset to None (the default EnumerationOptions skips Hidden/System) so an
            // extension folder is never silently ignored because of an unexpected attribute.
            var enumerationOptions = new EnumerationOptions
            {
                IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.None
            };

            foreach (var directory in Directory.EnumerateDirectories(extensionsDirectory, "*", enumerationOptions))
            {
                if (IsVersionedExtensionFolder(Path.GetFileName(directory)))
                {
                    return true;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Treat an unreadable extensions directory as "not found" rather than failing the whole doctor run.
            return false;
        }

        return false;
    }

    // Matches an extension folder name against the Aspire extension id. A case-insensitive prefix match
    // tolerates any installed version without spawning the VS Code CLI. Requiring a digit immediately
    // after the trailing '-' pins the match to the version segment so a different extension whose id
    // starts with ours (e.g. "microsoft-aspire.aspire-vscode-extras-1.0.0") is not treated as a match.
    private static bool IsVersionedExtensionFolder(string folderName)
    {
        const string prefix = ExtensionId + "-";

        return folderName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
            folderName.Length > prefix.Length &&
            char.IsAsciiDigit(folderName[prefix.Length]);
    }
}

/// <summary>
/// Captures whether VS Code and the Aspire VS Code extension were detected, and the version the
/// running extension reported for itself when it was available.
/// </summary>
internal sealed record VsCodeExtensionDetection(
    bool VsCodeInstalled,
    bool ExtensionInstalled,
    string? ExtensionVersion = null);
