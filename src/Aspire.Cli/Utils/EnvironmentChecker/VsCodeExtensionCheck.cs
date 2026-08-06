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
/// Reports whether the Aspire VS Code extension is installed and whether a stable update is available.
/// </summary>
/// <remarks>
/// The check is intentionally silent when VS Code is not detected: there is nothing to recommend
/// outside of a VS Code environment, so it returns an empty result and no row is rendered.
/// </remarks>
internal sealed class VsCodeExtensionCheck : IEnvironmentCheck
{
    internal const string CheckName = "vscode-extension";

    /// <summary>
    /// The unique identifier of the Aspire VS Code extension (<c>&lt;publisher&gt;.&lt;name&gt;</c>).
    /// </summary>
    internal const string ExtensionId = VsCodeExtensionMarketplaceClient.ExtensionId;

    /// <summary>
    /// The marketplace URL used as the fix link when the extension is missing. This is an aka.ms
    /// redirect so the ultimate destination can be updated without shipping a new CLI build.
    /// </summary>
    internal const string MarketplaceUrl = "https://aka.ms/aspire/vscode-extension";

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

    // Defaults commandResolver to the real PATH lookup; the internal constructor lets tests inject a
    // deterministic resolver (see the Detect overload below for why the resolver is a seam).
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

    // Runs after the fast environment/OS checks. The Marketplace lookup is bounded separately so
    // an installed extension cannot hold the overall doctor check open for the full check timeout.
    public int Order => 60;

    public async Task<IReadOnlyList<EnvironmentCheckResult>> CheckAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var detection = Detect(_environment, _executionContext.HomeDirectory, _commandResolver);

        // Nothing to recommend when the user is not running VS Code.
        if (!detection.VsCodeInstalled)
        {
            return [];
        }

        var metadata = BuildMetadata(detection);

        if (detection.ExtensionInstalled)
        {
            if (SemVersion.TryParse(detection.ExtensionVersion, SemVersionStyles.Strict, out var installedVersion))
            {
                try
                {
                    var latestVersion = await _marketplaceClient.GetLatestStableVersionAsync(cancellationToken).ConfigureAwait(false);
                    var updateAvailable = SemVersion.ComparePrecedence(latestVersion, installedVersion) > 0;
                    metadata["latestVersion"] = latestVersion.ToString();
                    metadata["updateAvailable"] = updateAvailable;

                    if (updateAvailable)
                    {
                        var outOfDateWarning = new EnvironmentCheckResult
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
                        };

                        return [outOfDateWarning];
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Failed to check the latest Aspire VS Code extension version.");
                    metadata["latestVersionError"] = ex.Message;

                    var passWithDetails = new EnvironmentCheckResult
                    {
                        Category = EnvironmentCheckCategories.DevelopmentTools,
                        Name = CheckName,
                        Status = EnvironmentCheckStatus.Pass,
                        Message = DoctorCommandStrings.VsCodeExtensionInstalledMessage,
                        Details = $"{DoctorCommandStrings.VsCodeExtensionLatestVersionCheckFailedMessage}: {ex.Message}",
                        Metadata = metadata
                    };

                    return [passWithDetails];
                }
            }

            // The Aspire extension is installed and either current or not safely comparable.
            var pass = new EnvironmentCheckResult
            {
                Category = EnvironmentCheckCategories.DevelopmentTools,
                Name = CheckName,
                Status = EnvironmentCheckStatus.Pass,
                Message = DoctorCommandStrings.VsCodeExtensionInstalledMessage,
                Metadata = metadata
            };

            return [pass];
        }

        // VS Code is present but the extension is missing: warn and point at the marketplace.
        var warning = new EnvironmentCheckResult
        {
            Category = EnvironmentCheckCategories.DevelopmentTools,
            Name = CheckName,
            Status = EnvironmentCheckStatus.Warning,
            Message = DoctorCommandStrings.VsCodeExtensionMissingMessage,
            Fix = DoctorCommandStrings.VsCodeExtensionMissingFix,
            Link = MarketplaceUrl,
            Metadata = metadata
        };

        return [warning];
    }

    internal static VsCodeExtensionDetection Detect(IEnvironment environment, DirectoryInfo homeDirectory)
        => Detect(environment, homeDirectory, PathLookupHelper.FindFullPathFromPath);

    // The command resolver is injected so tests can exercise the PATH-based detection fallback
    // deterministically; PathLookupHelper.FindFullPathFromPath reads the real process PATH, which
    // cannot be mocked via IEnvironment and would otherwise leave that branch untested (and flaky
    // on machines that happen to have "code" on PATH).
    internal static VsCodeExtensionDetection Detect(IEnvironment environment, DirectoryInfo homeDirectory, Func<string, string?> commandResolver)
    {
        var vsCodeInstalled = IsVsCodeInstalled(environment, commandResolver);
        if (!vsCodeInstalled)
        {
            return new VsCodeExtensionDetection(VsCodeInstalled: false, ExtensionInstalled: false, ExtensionVersion: null);
        }

        var extension = FindExtension(environment, homeDirectory);
        return new VsCodeExtensionDetection(
            VsCodeInstalled: true,
            ExtensionInstalled: extension.Found,
            ExtensionVersion: extension.Version);
    }

    private static bool IsVsCodeInstalled(IEnvironment environment, Func<string, string?> commandResolver)
    {
        // When doctor is invoked from an integrated terminal, VS Code advertises itself via TERM_PROGRAM.
        // See https://code.visualstudio.com/docs/terminal/shell-integration.
        if (string.Equals(environment.GetEnvironmentVariable("TERM_PROGRAM"), "vscode", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // Otherwise fall back to probing for the CLI launchers on PATH (stable and Insiders).
        return commandResolver("code") is not null
            || commandResolver("code-insiders") is not null;
    }

    private static (bool Found, string? Version, SemVersion? ParsedVersion) FindExtension(IEnvironment environment, DirectoryInfo homeDirectory)
    {
        var selected = (Found: false, Version: (string?)null, ParsedVersion: (SemVersion?)null);

        foreach (var extensionsDirectory in GetExtensionDirectories(environment, homeDirectory))
        {
            var extension = FindExtension(extensionsDirectory);
            if (!extension.Found)
            {
                continue;
            }

            selected = SelectNewerExtension(selected, extension);
        }

        return selected;
    }

    private static IEnumerable<string> GetExtensionDirectories(IEnvironment environment, DirectoryInfo homeDirectory)
    {
        // VSCODE_EXTENSIONS overrides the default extensions location entirely: when it is set,
        // VS Code loads extensions only from that directory, so we must probe only it. Falling through
        // to the default roots here could report the Aspire extension as installed from ~/.vscode even
        // though the running VS Code instance (using the override) would not load it — a false "pass".
        var overrideDirectory = environment.GetEnvironmentVariable("VSCODE_EXTENSIONS");
        if (!string.IsNullOrWhiteSpace(overrideDirectory))
        {
            yield return overrideDirectory;
            yield break;
        }

        var home = homeDirectory.FullName;

        // Default extension roots for desktop (stable/Insiders) and remote/server installs.
        yield return Path.Combine(home, ".vscode", "extensions");
        yield return Path.Combine(home, ".vscode-insiders", "extensions");
        yield return Path.Combine(home, ".vscode-server", "extensions");
        yield return Path.Combine(home, ".vscode-server-insiders", "extensions");
    }

    private static (bool Found, string? Version, SemVersion? ParsedVersion) FindExtension(string extensionsDirectory)
    {
        if (!Directory.Exists(extensionsDirectory))
        {
            return (Found: false, Version: null, ParsedVersion: null);
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

            var selected = (Found: false, Version: (string?)null, ParsedVersion: (SemVersion?)null);
            var obsoleteExtensions = ReadObsoleteExtensions(extensionsDirectory);

            // Installed extensions live in per-version folders named "<publisher>.<name>-<version>",
            // lowercased by VS Code, for example "microsoft-aspire.aspire-vscode-1.2.3".
            foreach (var directory in Directory.EnumerateDirectories(extensionsDirectory, "*", enumerationOptions))
            {
                var folderName = Path.GetFileName(directory);
                if (IsVersionedExtensionFolder(folderName) && !obsoleteExtensions.Contains(folderName))
                {
                    var version = ReadExtensionVersion(directory);
                    SemVersion.TryParse(version, SemVersionStyles.Strict, out var parsedVersion);
                    selected = SelectNewerExtension(
                        selected,
                        (Found: true, Version: version, ParsedVersion: parsedVersion));
                }
            }

            return selected;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Treat an unreadable extensions directory as "not found" rather than failing the whole doctor run.
            return (Found: false, Version: null, ParsedVersion: null);
        }
    }

    private static (bool Found, string? Version, SemVersion? ParsedVersion) SelectNewerExtension(
        (bool Found, string? Version, SemVersion? ParsedVersion) current,
        (bool Found, string? Version, SemVersion? ParsedVersion) candidate)
    {
        if (!current.Found
            || (candidate.ParsedVersion is not null
                && (current.ParsedVersion is null
                    || SemVersion.ComparePrecedence(candidate.ParsedVersion, current.ParsedVersion) > 0)))
        {
            return candidate;
        }

        return current;
    }

    private static HashSet<string> ReadObsoleteExtensions(string extensionsDirectory)
    {
        var obsoleteExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var obsoletePath = Path.Combine(extensionsDirectory, ".obsolete");
            if (!File.Exists(obsoletePath))
            {
                return obsoleteExtensions;
            }

            // VS Code marks extension folders pending removal in a root-level map shaped as:
            //   { "microsoft-aspire.aspire-vscode-1.2.3": true }
            // See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/node/extensionManagementService.ts.
            using var obsoleteJson = JsonDocument.Parse(File.ReadAllText(obsoletePath));
            if (obsoleteJson.RootElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in obsoleteJson.RootElement.EnumerateObject())
                {
                    if (property.Value.ValueKind == JsonValueKind.True)
                    {
                        obsoleteExtensions.Add(property.Name);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // VS Code treats an unreadable or malformed .obsolete file as empty, so do the same.
        }

        return obsoleteExtensions;
    }

    private static string? ReadExtensionVersion(string extensionDirectory)
    {
        try
        {
            var packageJsonPath = Path.Combine(extensionDirectory, "package.json");
            if (File.Exists(packageJsonPath))
            {
                // VS Code extension manifests contain the installed package version as:
                //   { "name": "aspire-vscode", "publisher": "microsoft-aspire", "version": "1.2.3" }
                using var packageJson = JsonDocument.Parse(File.ReadAllText(packageJsonPath));
                if (packageJson.RootElement.TryGetProperty("version", out var versionProperty)
                    && versionProperty.ValueKind == JsonValueKind.String
                    && versionProperty.GetString() is { Length: > 0 } packageVersion)
                {
                    if (SemVersion.TryParse(packageVersion, SemVersionStyles.Strict, out _))
                    {
                        return packageVersion;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Fall back to the version encoded in the directory name when the manifest cannot be read.
        }

        const string prefix = ExtensionId + "-";
        var folderName = Path.GetFileName(extensionDirectory);
        if (folderName.Length <= prefix.Length)
        {
            return null;
        }

        // VS Code appends a target platform after the manifest version for platform-specific
        // installs, for example "microsoft-aspire.aspire-vscode-1.2.3-darwin-arm64".
        // See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionManagementUtil.ts.
        var versionAndTargetPlatform = folderName[prefix.Length..];
        var targetPlatformSeparator = versionAndTargetPlatform.IndexOf('-');
        var folderVersion = targetPlatformSeparator >= 0
            ? versionAndTargetPlatform[..targetPlatformSeparator]
            : versionAndTargetPlatform;

        return SemVersion.TryParse(folderVersion, SemVersionStyles.Strict, out _)
            ? folderVersion
            : versionAndTargetPlatform;
    }

    // Matches an extension folder name against the Aspire extension id. A case-insensitive prefix match
    // tolerates any installed version without spawning the VS Code CLI. Requiring a digit immediately
    // after the trailing '-' pins the match to the version segment so a different extension whose id
    // starts with ours (e.g. "microsoft-aspire.aspire-vscode-extras-1.0.0") is not treated as a match.
    private static bool IsVersionedExtensionFolder(string folderName)
    {
        const string prefix = ExtensionId + "-";
        return folderName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && folderName.Length > prefix.Length
            && char.IsAsciiDigit(folderName[prefix.Length]);
    }

    private static JsonObject BuildMetadata(VsCodeExtensionDetection detection)
    {
        var metadata = new JsonObject
        {
            ["vsCodeInstalled"] = detection.VsCodeInstalled,
            ["extensionInstalled"] = detection.ExtensionInstalled,
            ["extensionId"] = ExtensionId
        };

        if (!string.IsNullOrWhiteSpace(detection.ExtensionVersion))
        {
            metadata["extensionVersion"] = detection.ExtensionVersion;
        }

        return metadata;
    }
}

/// <summary>
/// Captures whether VS Code and the Aspire VS Code extension were detected, including its version when available.
/// </summary>
internal sealed record VsCodeExtensionDetection(bool VsCodeInstalled, bool ExtensionInstalled, string? ExtensionVersion);
