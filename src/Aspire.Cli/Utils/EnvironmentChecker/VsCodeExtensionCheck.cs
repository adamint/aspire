// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Resources;
using Microsoft.Extensions.Logging;
using Semver;

namespace Aspire.Cli.Utils.EnvironmentChecker;

/// <summary>
/// Reports whether the Aspire VS Code extension is installed and current.
/// </summary>
internal sealed class VsCodeExtensionCheck : IEnvironmentCheck
{
    internal const string CheckName = "vscode-extension";
    internal const string ExtensionId = "microsoft-aspire.aspire-vscode";
    internal const string MarketplaceUrl = "https://aka.ms/aspire/vscode-extension";
    internal const string ExtensionVersionEnvironmentVariable = "ASPIRE_VSCODE_EXTENSION_VERSION";
    internal const string ExtensionChannelEnvironmentVariable = "ASPIRE_VSCODE_EXTENSION_CHANNEL";

    private readonly IEnvironment _environment;
    private readonly CliExecutionContext _executionContext;
    private readonly IVsCodeExtensionMarketplaceClient _marketplaceClient;
    private readonly ILogger<VsCodeExtensionCheck> _logger;
    private readonly Func<string, string?> _commandResolver;

    public VsCodeExtensionCheck(
        IEnvironment environment,
        CliExecutionContext executionContext,
        IVsCodeExtensionMarketplaceClient marketplaceClient,
        ILogger<VsCodeExtensionCheck> logger)
        : this(environment, executionContext, marketplaceClient, logger, PathLookupHelper.FindFullPathFromPath)
    {
    }

    internal VsCodeExtensionCheck(
        IEnvironment environment,
        CliExecutionContext executionContext,
        IVsCodeExtensionMarketplaceClient marketplaceClient,
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
        _logger = logger;
        _commandResolver = commandResolver;
    }

    public int Order => 60;

    public async Task<IReadOnlyList<EnvironmentCheckResult>> CheckAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var detection = Detect(_environment, _executionContext.HomeDirectory, _commandResolver);
        if (!detection.VsCodeInstalled)
        {
            return [];
        }

        var metadata = BuildMetadata(detection);
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

        if (!SemVersion.TryParse(detection.ExtensionVersion, SemVersionStyles.Strict, out var installedVersion))
        {
            return [CreateInstalledResult(metadata)];
        }

        try
        {
            var versions = await _marketplaceClient.GetLatestVersionsAsync(cancellationToken);
            var (latestVersion, channel) = GetLatestVersion(detection.ReleaseChannel, versions);
            if (latestVersion is null)
            {
                return [CreateMarketplaceUnavailableResult(metadata)];
            }

            var updateAvailable = SemVersion.ComparePrecedence(installedVersion, latestVersion) < 0;
            metadata["latestVersion"] = latestVersion.ToString();
            metadata["latestVersionChannel"] = channel;
            metadata["updateAvailable"] = updateAvailable;

            if (!updateAvailable)
            {
                return [CreateInstalledResult(metadata)];
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
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is OperationCanceledException or HttpRequestException or IOException or JsonException or InvalidDataException)
        {
            _logger.LogDebug(exception, "The VS Code Marketplace version check was unavailable.");
            return [CreateMarketplaceUnavailableResult(metadata)];
        }
    }

    private static (SemVersion? Version, string Channel) GetLatestVersion(
        VsCodeExtensionReleaseChannel installedChannel,
        VsCodeExtensionMarketplaceVersions versions)
    {
        if (installedChannel == VsCodeExtensionReleaseChannel.Stable ||
            versions.PreReleaseVersion is null ||
            versions.StableVersion is not null &&
            SemVersion.ComparePrecedence(versions.StableVersion, versions.PreReleaseVersion) >= 0)
        {
            return (versions.StableVersion, "stable");
        }

        return (versions.PreReleaseVersion, "pre-release");
    }

    internal static VsCodeExtensionDetection Detect(IEnvironment environment, DirectoryInfo homeDirectory)
        => Detect(environment, homeDirectory, PathLookupHelper.FindFullPathFromPath);

    internal static VsCodeExtensionDetection Detect(
        IEnvironment environment,
        DirectoryInfo homeDirectory,
        Func<string, string?> commandResolver)
    {
        var vsCodeInstalled = IsVsCodeInstalled(environment, commandResolver);
        if (!vsCodeInstalled)
        {
            return new VsCodeExtensionDetection(false, false);
        }

        var reportedVersion = environment.GetEnvironmentVariable(ExtensionVersionEnvironmentVariable)?.Trim();
        if (!string.IsNullOrEmpty(reportedVersion))
        {
            return new VsCodeExtensionDetection(
                true,
                true,
                reportedVersion,
                ParseReleaseChannel(environment.GetEnvironmentVariable(ExtensionChannelEnvironmentVariable)));
        }

        var extension = FindExtension(environment, homeDirectory);
        return new VsCodeExtensionDetection(
            true,
            extension.Found,
            extension.Version,
            VsCodeExtensionReleaseChannel.Stable);
    }

    private static bool IsVsCodeInstalled(IEnvironment environment, Func<string, string?> commandResolver)
    {
        if (string.Equals(environment.GetEnvironmentVariable("TERM_PROGRAM"), "vscode", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return commandResolver("code") is not null ||
            commandResolver("code-insiders") is not null;
    }

    private static (bool Found, string? Version, SemVersion? ParsedVersion) FindExtension(
        IEnvironment environment,
        DirectoryInfo homeDirectory)
    {
        var selected = (Found: false, Version: (string?)null, ParsedVersion: (SemVersion?)null);
        foreach (var extensionsDirectory in GetExtensionDirectories(environment, homeDirectory))
        {
            var candidate = FindExtension(extensionsDirectory);
            if (candidate.Found &&
                (!selected.Found ||
                    candidate.ParsedVersion is not null &&
                    (selected.ParsedVersion is null ||
                        SemVersion.ComparePrecedence(candidate.ParsedVersion, selected.ParsedVersion) > 0)))
            {
                selected = candidate;
            }
        }

        return selected;
    }

    private static IEnumerable<string> GetExtensionDirectories(IEnvironment environment, DirectoryInfo homeDirectory)
    {
        var overrideDirectory = environment.GetEnvironmentVariable("VSCODE_EXTENSIONS");
        if (!string.IsNullOrWhiteSpace(overrideDirectory))
        {
            yield return overrideDirectory;
            yield break;
        }

        var home = homeDirectory.FullName;
        yield return Path.Combine(home, ".vscode", "extensions");
        yield return Path.Combine(home, ".vscode-insiders", "extensions");
        yield return Path.Combine(home, ".vscode-server", "extensions");
        yield return Path.Combine(home, ".vscode-server-insiders", "extensions");
    }

    private static (bool Found, string? Version, SemVersion? ParsedVersion) FindExtension(string extensionsDirectory)
    {
        if (!Directory.Exists(extensionsDirectory))
        {
            return (false, null, null);
        }

        try
        {
            var selected = (Found: false, Version: (string?)null, ParsedVersion: (SemVersion?)null);
            var enumerationOptions = new EnumerationOptions
            {
                IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.None
            };

            foreach (var directory in Directory.EnumerateDirectories(extensionsDirectory, "*", enumerationOptions))
            {
                var folderName = Path.GetFileName(directory);
                if (!IsVersionedExtensionFolder(folderName))
                {
                    continue;
                }

                var version = ReadExtensionVersion(directory);
                SemVersion.TryParse(version, SemVersionStyles.Strict, out var parsedVersion);
                if (!selected.Found ||
                    parsedVersion is not null &&
                    (selected.ParsedVersion is null ||
                        SemVersion.ComparePrecedence(parsedVersion, selected.ParsedVersion) > 0))
                {
                    selected = (true, version, parsedVersion);
                }
            }

            return selected;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return (false, null, null);
        }
    }

    private static string? ReadExtensionVersion(string extensionDirectory)
    {
        try
        {
            var manifestPath = Path.Combine(extensionDirectory, "package.json");
            if (File.Exists(manifestPath))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
                if (document.RootElement.TryGetProperty("version", out var version) &&
                    version.ValueKind == JsonValueKind.String &&
                    SemVersion.TryParse(version.GetString(), SemVersionStyles.Strict, out _))
                {
                    return version.GetString();
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            // Fall back to the version encoded in the extension directory.
        }

        const string prefix = ExtensionId + "-";
        var folderVersion = Path.GetFileName(extensionDirectory)[prefix.Length..];
        return SemVersion.TryParse(folderVersion, SemVersionStyles.Strict, out _)
            ? folderVersion
            : null;
    }

    private static bool IsVersionedExtensionFolder(string folderName)
    {
        const string prefix = ExtensionId + "-";
        return folderName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
            folderName.Length > prefix.Length &&
            char.IsAsciiDigit(folderName[prefix.Length]);
    }

    private static VsCodeExtensionReleaseChannel ParseReleaseChannel(string? channel)
        => string.Equals(channel?.Trim(), "pre-release", StringComparison.OrdinalIgnoreCase)
            ? VsCodeExtensionReleaseChannel.PreRelease
            : VsCodeExtensionReleaseChannel.Stable;

    private static EnvironmentCheckResult CreateInstalledResult(JsonObject metadata)
        => new()
        {
            Category = EnvironmentCheckCategories.DevelopmentTools,
            Name = CheckName,
            Status = EnvironmentCheckStatus.Pass,
            Message = DoctorCommandStrings.VsCodeExtensionInstalledMessage,
            Metadata = metadata
        };

    private static EnvironmentCheckResult CreateMarketplaceUnavailableResult(JsonObject metadata)
        => new()
        {
            Category = EnvironmentCheckCategories.DevelopmentTools,
            Name = CheckName,
            Status = EnvironmentCheckStatus.Warning,
            Message = DoctorCommandStrings.VsCodeExtensionInstalledMessage,
            Details = DoctorCommandStrings.VsCodeExtensionLatestVersionCheckUnavailableDetails,
            Metadata = metadata
        };

    private static JsonObject BuildMetadata(VsCodeExtensionDetection detection)
    {
        var metadata = new JsonObject
        {
            ["vsCodeInstalled"] = detection.VsCodeInstalled,
            ["extensionInstalled"] = detection.ExtensionInstalled,
            ["extensionId"] = ExtensionId
        };

        if (detection.ExtensionVersion is not null)
        {
            metadata["extensionVersion"] = detection.ExtensionVersion;
            metadata["extensionChannel"] = detection.ReleaseChannel == VsCodeExtensionReleaseChannel.PreRelease
                ? "pre-release"
                : "stable";
        }

        return metadata;
    }
}

/// <summary>
/// The Marketplace release channel tracked by an Aspire VS Code extension installation.
/// </summary>
internal enum VsCodeExtensionReleaseChannel
{
    Stable,
    PreRelease
}

/// <summary>
/// The detected VS Code and Aspire extension state.
/// </summary>
internal sealed record VsCodeExtensionDetection(
    bool VsCodeInstalled,
    bool ExtensionInstalled,
    string? ExtensionVersion = null,
    VsCodeExtensionReleaseChannel ReleaseChannel = VsCodeExtensionReleaseChannel.Stable);
