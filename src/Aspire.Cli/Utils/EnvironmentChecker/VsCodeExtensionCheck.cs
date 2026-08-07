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
/// The check is intentionally silent when VS Code is not detected. Marketplace access is limited
/// to gallery installations whose active extension root and release channel can be identified.
/// </remarks>
internal sealed class VsCodeExtensionCheck : IEnvironmentCheck
{
    internal const string CheckName = "vscode-extension";
    internal const string ExtensionId = "microsoft-aspire.aspire-vscode";
    internal const string MarketplaceUrl = "https://aka.ms/aspire/vscode-extension";

    private const string UnknownValue = "unknown";
    private const string StableChannel = "stable";
    private const string PreReleaseChannel = "pre-release";
    private static readonly string[] s_targetPlatformSuffixes =
    [
        "win32-x64",
        "win32-ia32",
        "win32-arm64",
        "linux-x64",
        "linux-arm64",
        "linux-armhf",
        "alpine-x64",
        "alpine-arm64",
        "darwin-x64",
        "darwin-arm64",
        "universal",
        "web"
    ];

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

        if (!ShouldCheckMarketplace(detection, updateCheckEnabled, out var installedVersion))
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

        var latestVersion = detection.IsPreReleaseVersion == true
            ? versions.PreReleaseVersion
            : versions.StableVersion;
        if (latestVersion is null)
        {
            return
            [
                CreateMarketplaceUnavailableResult(
                    metadata,
                    new InvalidDataException(
                        $"The VS Code Marketplace response did not include a {detection.ExtensionReleaseChannel} version."))
            ];
        }

        var updateAvailable = SemVersion.ComparePrecedence(installedVersion, latestVersion) < 0;
        metadata["latestVersion"] = latestVersion.ToString();
        metadata["latestVersionChannel"] = detection.ExtensionReleaseChannel;
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

        // When the environment names the active extension root, probe only that root. Falling
        // through to the defaults could report an extension from ~/.vscode that the running
        // VS Code instance would never load.
        if (TryGetExplicitExtensionRoot(environment, homeDirectory, out var explicitRoot))
        {
            return DetectInRoot(explicitRoot, activeInstallationKnown: true);
        }

        var detections = GetDefaultExtensionRoots(homeDirectory)
            .Select(root => DetectInRoot(root, activeInstallationKnown: true))
            .Where(detection => detection.ExtensionInstalled)
            .ToArray();

        // Without an environment variable naming the active root, several installs can be present
        // at once (desktop plus Insiders plus a remote server). Any of them could be the one the
        // running VS Code loads, so report the extension as installed but mark the active
        // installation unknown rather than comparing an arbitrary copy against the Marketplace.
        return detections.Length switch
        {
            0 => new VsCodeExtensionDetection(VsCodeInstalled: true, ExtensionInstalled: false),
            1 => detections[0],
            _ => new VsCodeExtensionDetection(
                VsCodeInstalled: true,
                ExtensionInstalled: true,
                ActiveInstallationKnown: false)
        };
    }

    private EnvironmentCheckResult CreateMarketplaceUnavailableResult(
        JsonObject metadata,
        Exception exception)
    {
        _logger.LogDebug(exception, "The VS Code Marketplace version check was unavailable.");
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

    private static bool ShouldCheckMarketplace(
        VsCodeExtensionDetection detection,
        bool updateCheckEnabled,
        out SemVersion installedVersion)
    {
        // Only query the Marketplace when an update is both meaningful and actionable. A VSIX or
        // sideloaded build has no Marketplace counterpart to compare against, an ambiguous root
        // means the version found may not be the one VS Code actually loads, and an unknown
        // release channel would risk comparing a pre-release install against the stable feed.
        // Each of those would produce a warning the user cannot act on, so the check stays quiet.
        if (updateCheckEnabled &&
            detection.ActiveInstallationKnown &&
            string.Equals(detection.ExtensionSource, "gallery", StringComparison.Ordinal) &&
            detection.IsPreReleaseVersion is not null &&
            SemVersion.TryParse(detection.ExtensionVersion, SemVersionStyles.Strict, out var parsedVersion) &&
            parsedVersion is not null)
        {
            installedVersion = parsedVersion;
            return true;
        }

        installedVersion = null!;
        return false;
    }

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

        metadata["vsCodeChannel"] = detection.VsCodeChannel;
        metadata["extensionReleaseChannel"] = detection.ExtensionReleaseChannel;
        metadata["extensionSource"] = detection.ExtensionSource;
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
        return string.Equals(
                environment.GetEnvironmentVariable("TERM_PROGRAM"),
                "vscode",
                StringComparison.OrdinalIgnoreCase)
            || commandResolver("code") is not null
            || commandResolver("code-insiders") is not null;
    }

    private static bool TryGetExplicitExtensionRoot(
        IEnvironment environment,
        DirectoryInfo homeDirectory,
        out ExtensionRoot root)
    {
        // Ordered most to least authoritative. VSCODE_EXTENSIONS replaces the extension location
        // outright, VSCODE_AGENT_FOLDER names a remote server install root, the IPC pair marks a
        // remote/server terminal, and the askpass helper path is the desktop fallback because its
        // location encodes the installed channel:
        //   /Applications/Visual Studio Code.app/.../extensions/git/dist/askpass-main.js
        //   /Applications/Visual Studio Code - Insiders.app/.../askpass-main.js
        // See https://code.visualstudio.com/docs/terminal/shell-integration.
        var overrideDirectory = environment.GetEnvironmentVariable("VSCODE_EXTENSIONS");
        if (!string.IsNullOrWhiteSpace(overrideDirectory))
        {
            root = new ExtensionRoot(overrideDirectory, DetermineChannel(environment));
            return true;
        }

        var agentFolder = environment.GetEnvironmentVariable("VSCODE_AGENT_FOLDER");
        if (!string.IsNullOrWhiteSpace(agentFolder))
        {
            root = new ExtensionRoot(Path.Combine(agentFolder, "extensions"), DetermineChannel(environment));
            return true;
        }

        var clientCommand = environment.GetEnvironmentVariable("VSCODE_CLIENT_COMMAND");
        if (!string.IsNullOrWhiteSpace(environment.GetEnvironmentVariable("VSCODE_IPC_HOOK_CLI")) &&
            !string.IsNullOrWhiteSpace(clientCommand))
        {
            var channel = ContainsInsiders(clientCommand) ? "insiders" : StableChannel;
            var serverRoot = channel == "insiders" ? ".vscode-server-insiders" : ".vscode-server";
            root = new ExtensionRoot(
                Path.Combine(homeDirectory.FullName, serverRoot, "extensions"),
                channel);
            return true;
        }

        var askPassPath = environment.GetEnvironmentVariable("VSCODE_GIT_ASKPASS_MAIN");
        if (!string.IsNullOrWhiteSpace(askPassPath))
        {
            var channel = ContainsInsiders(askPassPath) ? "insiders" : StableChannel;
            var desktopRoot = channel == "insiders" ? ".vscode-insiders" : ".vscode";
            root = new ExtensionRoot(
                Path.Combine(homeDirectory.FullName, desktopRoot, "extensions"),
                channel);
            return true;
        }

        root = default!;
        return false;
    }

    private static string DetermineChannel(IEnvironment environment)
    {
        var clientCommand = environment.GetEnvironmentVariable("VSCODE_CLIENT_COMMAND");
        var askPassPath = environment.GetEnvironmentVariable("VSCODE_GIT_ASKPASS_MAIN");
        if (ContainsInsiders(clientCommand) || ContainsInsiders(askPassPath))
        {
            return "insiders";
        }

        return UnknownValue;
    }

    private static bool ContainsInsiders(string? value)
        => value?.Contains("insiders", StringComparison.OrdinalIgnoreCase) == true;

    private static IEnumerable<ExtensionRoot> GetDefaultExtensionRoots(DirectoryInfo homeDirectory)
    {
        var home = homeDirectory.FullName;

        yield return new ExtensionRoot(Path.Combine(home, ".vscode", "extensions"), StableChannel);
        yield return new ExtensionRoot(Path.Combine(home, ".vscode-insiders", "extensions"), "insiders");
        yield return new ExtensionRoot(Path.Combine(home, ".vscode-server", "extensions"), StableChannel);
        yield return new ExtensionRoot(Path.Combine(home, ".vscode-server-insiders", "extensions"), "insiders");
    }

    private static VsCodeExtensionDetection DetectInRoot(
        ExtensionRoot root,
        bool activeInstallationKnown)
    {
        var installedExtensions = FindInstalledExtensions(root.Path);
        if (installedExtensions.Count == 0)
        {
            return new VsCodeExtensionDetection(
                VsCodeInstalled: true,
                ExtensionInstalled: false,
                VsCodeChannel: root.Channel,
                ActiveInstallationKnown: activeInstallationKnown);
        }

        var selectedExtension = installedExtensions
            .Where(extension => extension.Version is not null)
            .OrderByDescending(
                extension => extension.Version,
                SemVersionPrecedenceComparer.Instance)
            .FirstOrDefault()
            // Every copy has an unreadable version, so nothing can be ordered. Report the
            // extension as installed with an unknown version rather than as missing.
            ?? installedExtensions[0];

        return new VsCodeExtensionDetection(
            VsCodeInstalled: true,
            ExtensionInstalled: true,
            ExtensionVersion: selectedExtension.Version?.ToString(),
            VsCodeChannel: root.Channel,
            ExtensionReleaseChannel: selectedExtension.IsPreReleaseVersion switch
            {
                true => PreReleaseChannel,
                false => StableChannel,
                null => UnknownValue
            },
            ExtensionSource: NormalizeExtensionSource(selectedExtension.Source),
            IsPreReleaseVersion: selectedExtension.IsPreReleaseVersion,
            ActiveInstallationKnown: activeInstallationKnown);
    }

    private static List<InstalledExtension> FindInstalledExtensions(string extensionsDirectory)
    {
        if (!Directory.Exists(extensionsDirectory))
        {
            return [];
        }

        var indexEntries = ReadExtensionsIndex(extensionsDirectory);
        var obsoleteExtensions = ReadObsoleteExtensions(extensionsDirectory);
        var installedExtensions = new List<InstalledExtension>();
        var enumerationOptions = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.None
        };

        try
        {
            foreach (var directory in Directory.EnumerateDirectories(
                extensionsDirectory,
                "*",
                enumerationOptions))
            {
                var folderName = Path.GetFileName(directory);
                if (!IsVersionedExtensionFolder(folderName) ||
                    obsoleteExtensions.Contains(folderName))
                {
                    continue;
                }

                indexEntries.TryGetValue(folderName, out var indexEntry);
                var version = TryReadPackageVersion(directory)
                    ?? TryReadFolderVersion(folderName);
                installedExtensions.Add(
                    new InstalledExtension(
                        version,
                        indexEntry?.IsPreReleaseVersion,
                        indexEntry?.Source));
            }
        }
        catch (IOException)
        {
            return [];
        }
        catch (UnauthorizedAccessException)
        {
            return [];
        }

        return installedExtensions;
    }

    private static Dictionary<string, ExtensionIndexEntry> ReadExtensionsIndex(
        string extensionsDirectory)
    {
        var indexPath = Path.Combine(extensionsDirectory, "extensions.json");
        if (!File.Exists(indexPath))
        {
            return new Dictionary<string, ExtensionIndexEntry>(StringComparer.OrdinalIgnoreCase);
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(indexPath));
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return new Dictionary<string, ExtensionIndexEntry>(StringComparer.OrdinalIgnoreCase);
            }

            var entries = new Dictionary<string, ExtensionIndexEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in document.RootElement.EnumerateArray())
            {
                if (!TryReadExtensionIndexEntry(entry, out var relativeLocation, out var indexEntry))
                {
                    continue;
                }

                entries[relativeLocation] = indexEntry;
            }

            return entries;
        }
        catch (IOException)
        {
            return new Dictionary<string, ExtensionIndexEntry>(StringComparer.OrdinalIgnoreCase);
        }
        catch (UnauthorizedAccessException)
        {
            return new Dictionary<string, ExtensionIndexEntry>(StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return new Dictionary<string, ExtensionIndexEntry>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static bool TryReadExtensionIndexEntry(
        JsonElement entry,
        out string relativeLocation,
        out ExtensionIndexEntry indexEntry)
    {
        // Entries in extensions.json look like:
        //   { "identifier": { "id": "microsoft-aspire.aspire-vscode" },
        //     "version": "1.16.0",
        //     "relativeLocation": "microsoft-aspire.aspire-vscode-1.16.0",
        //     "metadata": { "isPreReleaseVersion": false, "source": "gallery" } }
        // "metadata" is absent for extensions VS Code did not install from the gallery, so both
        // fields stay null and the caller skips the Marketplace comparison rather than guessing.
        relativeLocation = string.Empty;
        indexEntry = default!;

        if (!entry.TryGetProperty("identifier", out var identifier) ||
            !identifier.TryGetProperty("id", out var id) ||
            !string.Equals(id.GetString(), ExtensionId, StringComparison.OrdinalIgnoreCase) ||
            !entry.TryGetProperty("relativeLocation", out var relativeLocationElement) ||
            relativeLocationElement.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        relativeLocation = relativeLocationElement.GetString()!;
        bool? isPreReleaseVersion = null;
        string? source = null;
        if (entry.TryGetProperty("metadata", out var metadata) &&
            metadata.ValueKind == JsonValueKind.Object)
        {
            if (metadata.TryGetProperty("isPreReleaseVersion", out var preReleaseElement) &&
                preReleaseElement.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                isPreReleaseVersion = preReleaseElement.GetBoolean();
            }

            if (metadata.TryGetProperty("source", out var sourceElement) &&
                sourceElement.ValueKind == JsonValueKind.String)
            {
                source = sourceElement.GetString();
            }
        }

        indexEntry = new ExtensionIndexEntry(isPreReleaseVersion, source);
        return true;
    }

    private static HashSet<string> ReadObsoleteExtensions(string extensionsDirectory)
    {
        // VS Code marks an extension folder for deletion by adding it to `.obsolete` before the
        // folder itself is removed, keyed by folder name:
        //   { "microsoft-aspire.aspire-vscode-1.15.0": true }
        // Those folders can outlive the uninstall for a whole session, so skipping them prevents
        // a superseded copy from being reported as the installed version.
        var obsoletePath = Path.Combine(extensionsDirectory, ".obsolete");
        var obsoleteExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(obsoletePath))
        {
            return obsoleteExtensions;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(obsoletePath));
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return obsoleteExtensions;
            }

            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.True)
                {
                    obsoleteExtensions.Add(property.Name);
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        catch (JsonException)
        {
        }

        return obsoleteExtensions;
    }

    private static SemVersion? TryReadPackageVersion(string extensionDirectory)
    {
        var packageJsonPath = Path.Combine(extensionDirectory, "package.json");
        if (!File.Exists(packageJsonPath))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(packageJsonPath));
            return document.RootElement.TryGetProperty("version", out var versionElement) &&
                versionElement.ValueKind == JsonValueKind.String &&
                SemVersion.TryParse(
                    versionElement.GetString(),
                    SemVersionStyles.Strict,
                    out var version)
                    ? version
                    : null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static SemVersion? TryReadFolderVersion(string folderName)
    {
        // Installed extensions live in per-version folders that VS Code lowercases as
        // "<publisher>.<name>-<version>", optionally followed by a target platform for
        // platform-specific builds:
        //   microsoft-aspire.aspire-vscode-1.16.0
        //   microsoft-aspire.aspire-vscode-1.16.0-darwin-arm64
        // The platform suffix has to be stripped before parsing, otherwise it reads as a
        // semver pre-release tag and makes a stable build compare as older than it is.
        // See https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions.
        var versionText = folderName[(ExtensionId.Length + 1)..];
        foreach (var suffix in s_targetPlatformSuffixes)
        {
            var platformSuffix = "-" + suffix;
            if (versionText.EndsWith(platformSuffix, StringComparison.OrdinalIgnoreCase))
            {
                versionText = versionText[..^platformSuffix.Length];
                break;
            }
        }

        return SemVersion.TryParse(versionText, SemVersionStyles.Strict, out var version)
            ? version
            : null;
    }

    private static bool IsVersionedExtensionFolder(string folderName)
    {
        const string prefix = ExtensionId + "-";

        return folderName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
            folderName.Length > prefix.Length &&
            char.IsAsciiDigit(folderName[prefix.Length]);
    }

    private static string NormalizeExtensionSource(string? source)
        => source?.ToLowerInvariant() switch
        {
            "gallery" => "gallery",
            "vsix" => "vsix",
            "resource" => "resource",
            _ => UnknownValue
        };

    private sealed record ExtensionRoot(string Path, string Channel);

    private sealed record ExtensionIndexEntry(bool? IsPreReleaseVersion, string? Source);

    private sealed record InstalledExtension(
        SemVersion? Version,
        bool? IsPreReleaseVersion,
        string? Source);

    private sealed class SemVersionPrecedenceComparer : IComparer<SemVersion?>
    {
        internal static SemVersionPrecedenceComparer Instance { get; } = new();

        public int Compare(SemVersion? x, SemVersion? y)
        {
            if (ReferenceEquals(x, y))
            {
                return 0;
            }

            if (x is null)
            {
                return -1;
            }

            if (y is null)
            {
                return 1;
            }

            return SemVersion.ComparePrecedence(x, y);
        }
    }
}

internal sealed record VsCodeExtensionDetection(
    bool VsCodeInstalled,
    bool ExtensionInstalled,
    string? ExtensionVersion = null,
    string VsCodeChannel = "unknown",
    string ExtensionReleaseChannel = "unknown",
    string ExtensionSource = "unknown",
    bool? IsPreReleaseVersion = null,
    bool ActiveInstallationKnown = false);
