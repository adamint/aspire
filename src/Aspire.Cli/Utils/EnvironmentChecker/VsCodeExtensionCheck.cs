// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Frozen;
using System.Diagnostics.CodeAnalysis;
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
/// from the environment variable the extension itself contributes when the CLI runs inside a process
/// VS Code created for it, and otherwise resolved from the extension manifest on disk. The outcome is
/// three-state: a known current version passes, a known outdated version warns, and a version that
/// could not be determined warns separately rather than being reported as healthy.
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
    /// The environment variable the Aspire VS Code extension contributes to the terminals VS Code
    /// creates for it, carrying the version of the extension instance that is actually running. Tasks
    /// and debug sessions configured with <c>"console": "integratedTerminal"</c> inherit it because
    /// they run in a terminal; a debug process launched into the internal console does not.
    /// See <c>extension/src/utils/cliPathEnvironment.ts</c>.
    /// </summary>
    internal const string ExtensionVersionEnvironmentVariable = "ASPIRE_VSCODE_EXTENSION_VERSION";

    /// <summary>
    /// The environment variable the Aspire VS Code extension contributes with the Marketplace channel
    /// of the running extension instance.
    /// </summary>
    internal const string ExtensionChannelEnvironmentVariable = "ASPIRE_VSCODE_EXTENSION_CHANNEL";

    /// <summary>
    /// The environment variable the Aspire VS Code extension contributes with the install source of
    /// the running extension instance.
    /// </summary>
    internal const string ExtensionSourceEnvironmentVariable = "ASPIRE_VSCODE_EXTENSION_SOURCE";

    private const string StableChannel = "stable";
    private const string PreReleaseChannel = "pre-release";
    private const string MarketplaceSource = "marketplace";

    private const int MaximumManifestSize = 1024 * 1024;

    // "codium" is VSCodium's stable launcher and "code-oss" is the name Linux distributions use for
    // the OSS build; both install into the .vscode-oss roots the layout already scans.
    private static readonly string[] s_vsCodeLaunchers = ["code", "code-insiders", "codium", "codium-insiders", "code-oss"];

    // The profile index holds one entry per installed extension, so it is allowed to be larger than a
    // single manifest while still bounding what doctor will read into memory.
    private const int MaximumProfileIndexSize = 8 * 1024 * 1024;

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

        // A disabled update check is a deliberate opt-out, so it reports the same "installed" pass it
        // did before the comparison existed. An unknown version is different: doctor is a diagnostic
        // command, so reporting "healthy" when the version could not be read would end the user's
        // investigation on absent evidence. That case gets its own warning instead.
        if (!updateCheckEnabled)
        {
            return [CreateInstalledResult(metadata, EnvironmentCheckStatus.Pass)];
        }

        if (!SemVersion.TryParse(detection.ExtensionVersion, SemVersionStyles.Strict, out var installedVersion))
        {
            metadata["extensionVersionKnown"] = false;

            return
            [
                new EnvironmentCheckResult
                {
                    Category = EnvironmentCheckCategories.DevelopmentTools,
                    Name = CheckName,
                    Status = EnvironmentCheckStatus.Warning,
                    Message = DoctorCommandStrings.VsCodeExtensionVersionUnknownMessage,
                    Details = FormatSearchedRoots(detection.SearchedRoots),
                    Fix = DoctorCommandStrings.VsCodeExtensionVersionUnknownFix,

                    // Only a confirmed Marketplace install gets the Marketplace link. A side-load or
                    // an Open VSX install did not come from there, so pointing the user at it would
                    // hand them a page that does not describe what they have installed.
                    Link = detection.InstallSource is VsCodeExtensionInstallSource.Marketplace ? MarketplaceUrl : null,
                    Metadata = metadata
                }
            ];
        }

        metadata["extensionVersionKnown"] = true;

        if (detection.InstallSource is not VsCodeExtensionInstallSource.Marketplace)
        {
            return [CreateInstalledResult(metadata, EnvironmentCheckStatus.Pass)];
        }

        if (detection.ReleaseChannel is VsCodeExtensionReleaseChannel.Unknown)
        {
            return [CreateMarketplaceUnavailableResult(metadata, "The installed extension's Marketplace channel could not be determined.")];
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
        catch (InvalidDataException exception)
        {
            // The Marketplace was reachable, but the response shape or size made the version data
            // unusable. Treat that the same as unavailable external data so doctor keeps running.
            return [CreateMarketplaceUnavailableResult(metadata, exception)];
        }
        catch (JsonException exception)
        {
            return [CreateMarketplaceUnavailableResult(metadata, exception)];
        }

        // VS Code Marketplace pre-release extensions use plain major.minor.patch versions; the
        // pre-release bit is gallery metadata, not a semver suffix. Compare against the channel
        // reported by the active extension (or the installed manifest metadata), never by
        // SemVersion.IsPrerelease.
        // See https://github.com/microsoft/vsmarketplace/issues/310.
        var channel = detection.ReleaseChannel is VsCodeExtensionReleaseChannel.PreRelease
            ? PreReleaseChannel
            : StableChannel;
        var latestVersion = detection.ReleaseChannel is VsCodeExtensionReleaseChannel.PreRelease
            ? versions.PreReleaseVersion
            : versions.StableVersion;
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

        if (!IsVsCodeInstalled(environment, homeDirectory, commandResolver))
        {
            return new VsCodeExtensionDetection(VsCodeInstalled: false, ExtensionInstalled: false);
        }

        // The extension contributes its own version through EnvironmentVariableCollection, which VS Code
        // applies to the terminals it creates (and therefore to tasks and to debug sessions configured
        // with "console": "integratedTerminal", because those run inside one). It deliberately does not
        // reach a debug process launched into the internal console; see
        // https://github.com/microsoft/vscode/issues/114818. When the variable is present it is the
        // version of the instance that is actually running, so it is preferred over anything on disk: several extension roots can hold the extension at once
        // (desktop plus .vscode-server for Remote/WSL/devcontainers), --extensions-dir is invisible to
        // a child process, and portable mode relocates the whole root.
        //
        // The value is only trusted when it parses, so a truncated or corrupted variable falls through
        // to the disk scan for the roots it searched -- but not for a version.
        var reportedVersion = environment.GetEnvironmentVariable(ExtensionVersionEnvironmentVariable)?.Trim();
        if (!string.IsNullOrEmpty(reportedVersion) &&
            SemVersion.TryParse(reportedVersion, SemVersionStyles.Strict, out var reportedSemVersion))
        {
            var reportedChannel = ParseReleaseChannel(environment.GetEnvironmentVariable(ExtensionChannelEnvironmentVariable));
            var reportedSource = ParseInstallSource(environment.GetEnvironmentVariable(ExtensionSourceEnvironmentVariable));

            // The extension host cannot see how the extension was installed: VS Code deletes __metadata
            // from the manifest before building the description an extension reads, so the reported
            // source is normally unknown even for a Marketplace install. Leaving it there would retire
            // the Marketplace comparison on the very path that reports the most accurate version, so
            // the on-disk record is consulted for the missing signals. It is only adopted when the disk
            // scan resolved the same version that was reported, which rules out a second copy in
            // another extensions root donating its origin. It cannot rule out everything: profiles
            // share the extracted extension folder but keep their own metadata, so a non-default
            // profile that side-loaded this exact version still reads the default profile's record.
            // Closing that gap needs a per-profile source signal, and VS Code exposes none -- the
            // reason this fallback exists at all.
            if (reportedSource is VsCodeExtensionInstallSource.Unknown ||
                reportedChannel is VsCodeExtensionReleaseChannel.Unknown)
            {
                var reportedDiskDetection = ResolveExtensionFromDisk(environment, homeDirectory);

                // Full equality rather than ComparePrecedence: precedence ignores build metadata, so
                // 1.2.3+loaded and 1.2.3+disk would compare equal and let an unrelated copy donate its
                // origin and channel to the running instance, which is the thing this guard prevents.
                if (SemVersion.TryParse(reportedDiskDetection.Version, SemVersionStyles.Strict, out var diskVersion) &&
                    diskVersion.Equals(reportedSemVersion))
                {
                    if (reportedSource is VsCodeExtensionInstallSource.Unknown)
                    {
                        reportedSource = reportedDiskDetection.InstallSource;
                    }

                    if (reportedChannel is VsCodeExtensionReleaseChannel.Unknown)
                    {
                        reportedChannel = reportedDiskDetection.ReleaseChannel;
                    }
                }
            }

            return new VsCodeExtensionDetection(
                VsCodeInstalled: true,
                ExtensionInstalled: true,
                ExtensionVersion: reportedVersion,
                VersionSource: VsCodeExtensionVersionSource.Extension,
                ReleaseChannel: reportedChannel,
                InstallSource: reportedSource);
        }

        // Outside a VS Code-created process there is no environment signal. Older extension builds also
        // predate the variable entirely, and those are exactly the installations this check exists to
        // find, so the manifest on disk has to be read rather than treating the missing variable as a
        // clean bill of health.
        var diskDetection = ResolveExtensionFromDisk(environment, homeDirectory);

        // A non-empty but unparseable reported version still proves the extension is loaded: only the
        // running extension sets the variable. The disk scan can legitimately come up empty for that
        // same installation (portable mode, --extensions-dir, or a remote/server root the CLI cannot
        // see), so falling back to diskDetection.Installed alone would report the extension as MISSING
        // and tell the user to install what they already have. Keep the reported signal so the run
        // lands on the "installed, version unknown" warning instead.
        var extensionReportedItself = !string.IsNullOrEmpty(reportedVersion);

        // Nothing on disk may be adopted in that case. A variable that is present at all means a
        // specific instance is loaded right now, and one that does not parse means the CLI cannot say
        // which -- exactly the situation the parseable path refuses to guess in, where the disk record
        // is only adopted after diskVersion.Equals(reportedSemVersion). No such check is possible
        // here, so a stale copy under a default root would donate its version, channel, and origin to
        // a portable or --extensions-dir instance and produce a confident update verdict about an
        // installation the user is not running. The searched roots are still carried through: they
        // name where the CLI looked, not what it found.
        if (extensionReportedItself)
        {
            return new VsCodeExtensionDetection(
                VsCodeInstalled: true,
                ExtensionInstalled: true,
                SearchedRoots: diskDetection.SearchedRoots);
        }

        return new VsCodeExtensionDetection(
            VsCodeInstalled: true,
            ExtensionInstalled: diskDetection.Installed,
            ExtensionVersion: diskDetection.Version,
            VersionSource: diskDetection.Version is null ? VsCodeExtensionVersionSource.None : VsCodeExtensionVersionSource.Manifest,
            ReleaseChannel: diskDetection.ReleaseChannel,
            InstallSource: diskDetection.InstallSource,
            SearchedRoots: diskDetection.SearchedRoots);
    }

    /// <summary>
    /// Finds the Aspire extension version installed under a known extension root.
    /// </summary>
    /// <remarks>
    /// VS Code leaves the previous directory in place after an upgrade, so a root routinely holds
    /// several versions of the same extension at once. The highest version is the one VS Code loads,
    /// and versions are ordered by semver precedence rather than as strings so <c>1.10.0</c> sorts
    /// above <c>1.9.0</c>. That rule is only safe inside one root. When multiple default roots contain
    /// Aspire and the extension did not report its active instance, a desktop install can mask the
    /// remote/server install that launched the CLI, so the version is reported as unknown instead of
    /// taking a cross-root maximum.
    /// </remarks>
    private static VsCodeExtensionDiskDetection ResolveExtensionFromDisk(
        IEnvironment environment,
        DirectoryInfo homeDirectory)
    {
        var searchedRoots = new List<string>();
        var rootsWithExtension = new List<VsCodeExtensionRootDetection>();

        foreach (var extensionRoot in VsCodeInstallLayout.GetExtensionRootPaths(environment, homeDirectory))
        {
            searchedRoots.Add(extensionRoot.Path);
            var rootDetection = ResolveExtensionFromRoot(extensionRoot);

            if (rootDetection.Installed)
            {
                rootsWithExtension.Add(rootDetection);
            }
        }

        return rootsWithExtension.Count switch
        {
            0 => new VsCodeExtensionDiskDetection(false, null, VsCodeExtensionReleaseChannel.Unknown, VsCodeExtensionInstallSource.Unknown, searchedRoots),
            1 => new VsCodeExtensionDiskDetection(
                true,
                rootsWithExtension[0].Version?.ToString(),
                rootsWithExtension[0].ReleaseChannel,
                rootsWithExtension[0].InstallSource,
                searchedRoots),
            _ => new VsCodeExtensionDiskDetection(true, null, VsCodeExtensionReleaseChannel.Unknown, VsCodeExtensionInstallSource.Unknown, searchedRoots)
        };
    }

    private static VsCodeExtensionRootDetection ResolveExtensionFromRoot(VsCodeExtensionRoot extensionRoot)
    {
        var extensionsDirectory = extensionRoot.Path;
        SemVersion? highestVersion = null;
        var releaseChannel = VsCodeExtensionReleaseChannel.Unknown;
        var installSource = VsCodeExtensionInstallSource.Unknown;
        var installed = false;
        var profileMetadata = ReadProfileExtensionMetadata(extensionsDirectory);

        var listedInIndex = false;

        foreach (var extensionDirectory in EnumerateExtensionDirectories(extensionsDirectory))
        {
            installed = true;

            if (!TryResolveExtensionVersion(
                    extensionDirectory,
                    out var version,
                    out var candidateReleaseChannel,
                    out var candidateInstallSource))
            {
                continue;
            }

            // The profile index is the authoritative record of how an extension got here, so it
            // overrides whatever the extracted manifest happened to retain. Current VS Code writes
            // only { targetPlatform, installedTimestamp, size } into the manifest's __metadata and
            // keeps source/isPreReleaseVersion here, so without this read the origin of a Marketplace
            // install cannot be told apart from a side-load at all.
            var indexed = profileMetadata.TryGetValue(Path.GetFileName(extensionDirectory), out var recorded);

            // The index names the folder the profile actually loads, so a listed folder outranks an
            // unlisted one even when the unlisted one carries a higher version. An interrupted update
            // or a hand-copied directory leaves a higher-numbered folder on disk that VS Code never
            // loads, and reporting its version would describe an extension the user is not running.
            if (listedInIndex && !indexed)
            {
                continue;
            }

            var supersedesUnlistedCandidate = indexed && !listedInIndex;
            if (!supersedesUnlistedCandidate &&
                highestVersion is not null &&
                SemVersion.ComparePrecedence(version, highestVersion) <= 0)
            {
                continue;
            }

            listedInIndex |= indexed;
            highestVersion = version;

            // A null here means the index carried no signal, which is different from the index saying
            // the install is not from the gallery: the latter has to override whatever the manifest
            // claims rather than fall back to it.
            releaseChannel = recorded.ReleaseChannel ?? candidateReleaseChannel;
            installSource = recorded.InstallSource ?? candidateInstallSource;

            // "gallery" names whichever gallery the build is configured against. VSCodium's is Open
            // VSX, so treating its installs as Marketplace ones would query and link a feed the
            // extension did not come from.
            if (!extensionRoot.UsesMicrosoftGallery)
            {
                installSource = VsCodeExtensionInstallSource.Unknown;
            }
        }

        return new VsCodeExtensionRootDetection(installed, highestVersion, releaseChannel, installSource);
    }

    /// <summary>
    /// Reads the profile's extension index, which records how each installed extension was acquired.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the signal VS Code itself trusts. The extracted <c>package.json</c> only ever keeps a
    /// trimmed <c>__metadata</c>, and current builds strip it from the extension description
    /// entirely, so neither the manifest nor <c>vscode.Extension.packageJSON</c> can answer whether an
    /// install came from the Marketplace. The index does, for every entry.
    /// </para>
    /// <para>
    /// Entries look like this (trimmed; a real file is an array of these):
    /// <code>
    /// [{
    ///   "identifier": { "id": "microsoft-aspire.aspire-vscode", "uuid": "..." },
    ///   "version": "1.2.3",
    ///   "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
    ///   "metadata": { "source": "gallery", "isPreReleaseVersion": false, "publisherId": "..." }
    /// }]
    /// </code>
    /// <c>relativeLocation</c> is the extracted folder name, which is what the directory scan keys on.
    /// Older files can omit <c>relativeLocation</c> or <c>metadata</c>, and a partially written index
    /// is not worth failing doctor over, so anything unexpected is skipped rather than thrown.
    /// </para>
    /// <para>
    /// This reads the default profile's index, which sits beside the extension root. A non-default
    /// profile keeps its own index under the user-data directory, so an extension installed only
    /// there is not listed here and falls back to the extracted manifest. That degrades to an unknown
    /// origin, which suppresses the update comparison rather than asserting a wrong one; it never
    /// reports the extension as missing, because the directory scan is what proves installation.
    /// See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/node/extensionsScannerService.ts.
    /// </para>
    /// </remarks>
    private static IReadOnlyDictionary<string, (VsCodeExtensionReleaseChannel? ReleaseChannel, VsCodeExtensionInstallSource? InstallSource)> ReadProfileExtensionMetadata(
        string extensionsDirectory)
    {
        var indexPath = Path.Combine(extensionsDirectory, "extensions.json");

        try
        {
            var indexFile = new FileInfo(indexPath);

            // The index grows with the number of installed extensions, so it is allowed to be larger
            // than a single manifest while still being capped against reading an arbitrary file here.
            if (!indexFile.Exists || indexFile.Length > MaximumProfileIndexSize)
            {
                return FrozenDictionary<string, (VsCodeExtensionReleaseChannel?, VsCodeExtensionInstallSource?)>.Empty;
            }

            using var stream = indexFile.OpenRead();
            using var document = JsonDocument.Parse(stream);

            if (document.RootElement.ValueKind is not JsonValueKind.Array)
            {
                return FrozenDictionary<string, (VsCodeExtensionReleaseChannel?, VsCodeExtensionInstallSource?)>.Empty;
            }

            var metadataByFolder = new Dictionary<string, (VsCodeExtensionReleaseChannel?, VsCodeExtensionInstallSource?)>(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in document.RootElement.EnumerateArray())
            {
                if (entry.ValueKind is not JsonValueKind.Object ||
                    !entry.TryGetProperty("relativeLocation", out var relativeLocation) ||
                    relativeLocation.ValueKind != JsonValueKind.String ||
                    relativeLocation.GetString() is not { Length: > 0 } folderName)
                {
                    continue;
                }

                // metadata is optional in the stored schema. The entry is still kept, because
                // relativeLocation alone answers which folder the profile loads. Recording nulls for
                // channel and origin does not make them unknown: the caller reads them as "the index
                // carried no signal" and falls back to whatever the extracted manifest retained, which
                // for a manifest with no pre-release flag is stable. Dropping the entry instead would
                // hand the which-folder question back to the directory scan, which can only pick the
                // highest version on disk.
                var hasMetadata = entry.TryGetProperty("metadata", out var metadata) &&
                    metadata.ValueKind is JsonValueKind.Object;

                metadataByFolder[folderName] = hasMetadata
                    ? (GetMetadataReleaseChannelOrDefault(metadata), GetMetadataInstallSourceOrDefault(metadata))
                    : (null, null);
            }

            return metadataByFolder;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return FrozenDictionary<string, (VsCodeExtensionReleaseChannel?, VsCodeExtensionInstallSource?)>.Empty;
        }
    }

    private static IEnumerable<string> EnumerateExtensionDirectories(string extensionsDirectory)
    {
        if (!Directory.Exists(extensionsDirectory))
        {
            yield break;
        }

        var obsoleteExtensionDirectories = ReadObsoleteExtensionDirectories(extensionsDirectory);

        // IgnoreInaccessible lets the probe skip an unreadable extension folder and keep scanning the
        // rest, instead of throwing and reporting the whole extensions root as "not found" (a false
        // warning even when the Aspire extension is installed alongside an inaccessible one). The
        // parameterless EnumerateDirectories overload uses legacy behavior that throws instead.
        // AttributesToSkip is reset to None (the default EnumerationOptions skips Hidden/System) so an
        // extension folder is never silently ignored because of an unexpected attribute.
        var enumerationOptions = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.None
        };

        IEnumerator<string> enumerator;
        try
        {
            enumerator = Directory.EnumerateDirectories(extensionsDirectory, "*", enumerationOptions).GetEnumerator();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Treat an unreadable extensions root as empty rather than failing the whole doctor run.
            yield break;
        }

        using (enumerator)
        {
            while (true)
            {
                string current;
                try
                {
                    // MoveNext performs the directory read, so enumeration faults surface here rather
                    // than from the call above. It cannot sit inside a try with a yield in scope, so
                    // the loop advances and yields in separate steps.
                    if (!enumerator.MoveNext())
                    {
                        yield break;
                    }

                    current = enumerator.Current;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    yield break;
                }

                var folderName = Path.GetFileName(current);
                if (IsVersionedExtensionFolder(folderName) &&
                    !obsoleteExtensionDirectories.Contains(folderName))
                {
                    yield return current;
                }
            }
        }
    }

    private static IReadOnlySet<string> ReadObsoleteExtensionDirectories(string extensionsDirectory)
    {
        var obsoletePath = Path.Combine(extensionsDirectory, ".obsolete");

        try
        {
            var obsoleteFile = new FileInfo(obsoletePath);
            if (!obsoleteFile.Exists || obsoleteFile.Length > MaximumManifestSize)
            {
                return FrozenSet<string>.Empty;
            }

            using var stream = obsoleteFile.OpenRead();
            using var document = JsonDocument.Parse(stream);

            if (document.RootElement.ValueKind is not JsonValueKind.Object)
            {
                return FrozenSet<string>.Empty;
            }

            var obsoleteExtensionDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // VS Code records extensions pending deletion as:
            //   { "microsoft-aspire.aspire-vscode-1.2.3": true, "publisher.other-1.0.0": false }
            // The object is maintained by the extension scanner and keyed by the extracted folder
            // name; malformed entries are ignored because a corrupt marker must not make doctor fail.
            // Only a JSON true marks the folder obsolete: VS Code tests the value for truthiness and
            // writes false to clear a marker rather than removing the key, so treating the key alone
            // as obsolete would hide an active install and report the extension as missing.
            // See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/node/extensionsScannerService.ts.
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.True)
                {
                    obsoleteExtensionDirectories.Add(property.Name);
                }
            }

            return obsoleteExtensionDirectories;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return FrozenSet<string>.Empty;
        }
    }

    /// <summary>
    /// Reads the version of an installed extension, preferring the manifest over the folder name.
    /// </summary>
    /// <remarks>
    /// The <c>&lt;publisher&gt;.&lt;name&gt;-&lt;version&gt;</c> folder name is a convention; the
    /// <c>version</c> field of the extracted <c>package.json</c> is the manifest contract, so it wins.
    /// The folder name is only consulted when the manifest is missing or unreadable, and then only a
    /// plain release version is accepted: a platform-specific VSIX unpacks to a folder such as
    /// <c>...-1.2.3-darwin-arm64</c>, whose suffix parses as the semver pre-release <c>1.2.3-darwin-arm64</c>
    /// and would otherwise be mistaken for a pre-release build of the extension.
    /// See https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions.
    /// </remarks>
    private static bool TryResolveExtensionVersion(
        string extensionDirectory,
        [NotNullWhen(true)] out SemVersion? version,
        out VsCodeExtensionReleaseChannel releaseChannel,
        out VsCodeExtensionInstallSource installSource)
    {
        if (TryReadManifestVersion(
                Path.Combine(extensionDirectory, "package.json"),
                out version,
                out releaseChannel,
                out installSource))
        {
            return true;
        }

        var folderName = Path.GetFileName(extensionDirectory);
        var versionSegment = folderName[(ExtensionId.Length + 1)..];

        if (SemVersion.TryParse(versionSegment, SemVersionStyles.Strict, out var folderVersion) &&
            !folderVersion.IsPrerelease &&
            folderVersion.Metadata.Length == 0)
        {
            version = folderVersion;
            releaseChannel = VsCodeExtensionReleaseChannel.Unknown;
            installSource = VsCodeExtensionInstallSource.Unknown;
            return true;
        }

        version = null;
        releaseChannel = VsCodeExtensionReleaseChannel.Unknown;
        installSource = VsCodeExtensionInstallSource.Unknown;
        return false;
    }

    private static bool TryReadManifestVersion(
        string manifestPath,
        [NotNullWhen(true)] out SemVersion? version,
        out VsCodeExtensionReleaseChannel releaseChannel,
        out VsCodeExtensionInstallSource installSource)
    {
        version = null;
        releaseChannel = VsCodeExtensionReleaseChannel.Unknown;
        installSource = VsCodeExtensionInstallSource.Unknown;

        try
        {
            var manifest = new FileInfo(manifestPath);

            // An extension manifest is a few kilobytes. The cap stops doctor from reading an
            // arbitrarily large file that happens to sit at this path into memory.
            if (!manifest.Exists || manifest.Length > MaximumManifestSize)
            {
                return false;
            }

            using var stream = manifest.OpenRead();
            using var document = JsonDocument.Parse(stream);

            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("version", out var versionElement) ||
                versionElement.ValueKind != JsonValueKind.String ||
                !SemVersion.TryParse(versionElement.GetString(), SemVersionStyles.Strict, out version))
            {
                return false;
            }

            releaseChannel = GetManifestReleaseChannel(document.RootElement);
            installSource = GetManifestInstallSource(document.RootElement);

            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // A corrupt or locked manifest falls back to the folder name rather than failing the run.
            return false;
        }
    }

    /// <summary>
    /// Reads the Marketplace release channel recorded in an installed extension's manifest metadata,
    /// treating a manifest that records no channel as stable.
    /// </summary>
    private static VsCodeExtensionReleaseChannel GetManifestReleaseChannel(JsonElement manifest)
        => TryGetManifestMetadata(manifest, out var metadata)
            ? GetMetadataReleaseChannel(metadata)
            : VsCodeExtensionReleaseChannel.Stable;

    /// <summary>
    /// Reads the install origin an extracted manifest happens to record, which is only consulted when
    /// the profile index has nothing to say about the folder.
    /// </summary>
    /// <remarks>
    /// This is deliberately the weakest of the two signals. VS Code's <c>ManifestMetadata</c> is
    /// <c>Partial&lt;{ targetPlatform, installedTimestamp, size }&gt;</c> -- no <c>source</c> -- and the
    /// extracted manifest is written with <c>{ ...manifest.__metadata, ...metaData }</c>, so a
    /// <c>source</c> a package ships in its own <c>package.json</c> survives the install. VS Code
    /// itself reads <c>source</c> from the profile index for that reason, and so does the caller,
    /// which only falls back here when the index does not list the folder. Dropping the fallback
    /// entirely would be worse than the self-declaration it admits: an install whose index is missing
    /// or unreadable would stop being update-checked at all, and the only thing a false <c>gallery</c>
    /// buys is one Marketplace request and a link.
    /// See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionsScannerService.ts.
    /// </remarks>
    private static VsCodeExtensionInstallSource GetManifestInstallSource(JsonElement manifest)
        => TryGetManifestMetadata(manifest, out var metadata)
            ? GetMetadataInstallSource(metadata)
            : VsCodeExtensionInstallSource.Unknown;

    private static VsCodeExtensionReleaseChannel GetMetadataReleaseChannel(JsonElement metadata)
        => GetMetadataReleaseChannelOrDefault(metadata) ?? VsCodeExtensionReleaseChannel.Stable;

    private static VsCodeExtensionInstallSource GetMetadataInstallSource(JsonElement metadata)
        => GetMetadataInstallSourceOrDefault(metadata) ?? VsCodeExtensionInstallSource.Unknown;

    /// <summary>
    /// Reads the release channel from a VS Code metadata object, or <see langword="null"/> when the
    /// object records no channel at all.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>preRelease</c> is the channel the install tracks and <c>isPreReleaseVersion</c> only
    /// describes the artifact that happens to be extracted, so <c>preRelease</c> is read first: after
    /// opting into pre-release updates the two disagree until the next update lands, and it is the
    /// tracked channel that says which feed the install will move along. It is also the field the
    /// extension host is given, so reading it here keeps the CLI and the extension on one answer.
    /// </para>
    /// <para>
    /// VS Code coerces both flags with <c>!!</c>, and older gallery installs were written without
    /// either, so callers treat an absent property as stable. A property that is present but is not a
    /// JSON boolean (for example <c>"isPreReleaseVersion": "true"</c>) is metadata we cannot trust,
    /// and guessing stable there would compare a pre-release install against the stable feed, so it
    /// reports <see cref="VsCodeExtensionReleaseChannel.Unknown"/>.
    /// </para>
    /// </remarks>
    private static VsCodeExtensionReleaseChannel? GetMetadataReleaseChannelOrDefault(JsonElement metadata)
    {
        if (!metadata.TryGetProperty("preRelease", out var channelFlag) &&
            !metadata.TryGetProperty("isPreReleaseVersion", out channelFlag))
        {
            return null;
        }

        return channelFlag.ValueKind switch
        {
            JsonValueKind.True => VsCodeExtensionReleaseChannel.PreRelease,
            JsonValueKind.False => VsCodeExtensionReleaseChannel.Stable,
            _ => VsCodeExtensionReleaseChannel.Unknown
        };
    }

    private static VsCodeExtensionInstallSource? GetMetadataInstallSourceOrDefault(JsonElement metadata)
    {
        // source is the only recorded install origin ("gallery" for a gallery install, "vsix" for a
        // side-load):
        //   "metadata": { "id": "...", "publisherId": "...", "source": "gallery" }
        // publisherId is deliberately not accepted as a substitute: VS Code looks a side-loaded VSIX
        // up in the gallery on install and stamps the matched publisherId onto it, so inferring a
        // gallery install from it sends the outbound request this signal exists to gate. The profile
        // index carries source for every entry it lists, which is where the answer comes from; an
        // extracted package.json usually does not, because current VS Code persists only
        // { targetPlatform, installedTimestamp, size } there, and an unrecorded origin is reported as
        // unknown rather than guessed at.
        // See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionsScannerService.ts.
        if (!metadata.TryGetProperty("source", out var source))
        {
            return null;
        }

        // A source VS Code did write settles the question, including one that is not a string at all
        // ({ "source": 7 }): metadata that is present but untrustworthy is not a gallery install.
        return source.ValueKind == JsonValueKind.String &&
            string.Equals(source.GetString()?.Trim(), "gallery", StringComparison.OrdinalIgnoreCase)
                ? VsCodeExtensionInstallSource.Marketplace
                : VsCodeExtensionInstallSource.Unknown;
    }

    private static bool TryGetManifestMetadata(JsonElement manifest, out JsonElement metadata)
    {
        return manifest.TryGetProperty("__metadata", out metadata) &&
            metadata.ValueKind == JsonValueKind.Object;
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

        metadata["extensionVersionSource"] = detection.VersionSource switch
        {
            VsCodeExtensionVersionSource.Extension => "extension",
            VsCodeExtensionVersionSource.Manifest => "manifest",
            _ => "unknown"
        };
        metadata["extensionChannel"] = detection.ReleaseChannel switch
        {
            VsCodeExtensionReleaseChannel.Stable => StableChannel,
            VsCodeExtensionReleaseChannel.PreRelease => PreReleaseChannel,
            _ => "unknown"
        };
        metadata["extensionInstallSource"] = detection.InstallSource switch
        {
            VsCodeExtensionInstallSource.Marketplace => MarketplaceSource,
            _ => "unknown"
        };

        return metadata;
    }

    private static VsCodeExtensionReleaseChannel ParseReleaseChannel(string? channel)
        => channel?.Trim().ToLowerInvariant() switch
        {
            StableChannel => VsCodeExtensionReleaseChannel.Stable,
            PreReleaseChannel => VsCodeExtensionReleaseChannel.PreRelease,
            _ => VsCodeExtensionReleaseChannel.Unknown
        };

    private static VsCodeExtensionInstallSource ParseInstallSource(string? source)
        => source?.Trim().ToLowerInvariant() switch
        {
            MarketplaceSource => VsCodeExtensionInstallSource.Marketplace,
            _ => VsCodeExtensionInstallSource.Unknown
        };

    /// <summary>
    /// Renders the extension roots that were searched so an unknown version says where it looked.
    /// </summary>
    private static string FormatSearchedRoots(IReadOnlyList<string>? searchedRoots)
    {
        // The environment variable path never touches disk, so there is nothing to list. That happens
        // only when the variable itself was unreadable, which the fix text already covers.
        if (searchedRoots is null || searchedRoots.Count == 0)
        {
            return DoctorCommandStrings.VsCodeExtensionVersionUnknownDetails;
        }

        return string.Format(
            CultureInfo.CurrentCulture,
            DoctorCommandStrings.VsCodeExtensionVersionUnknownSearchedDetailsFormat,
            string.Join(", ", searchedRoots));
    }

    private static bool IsVsCodeInstalled(
        IEnvironment environment,
        DirectoryInfo homeDirectory,
        Func<string, string?> commandResolver)
    {
        // VS Code sets TERM_PROGRAM for integrated terminals. Outside an integrated terminal, probe the
        // launchers without spawning any of them. VSCodium is included because VsCodeInstallLayout
        // scans its .vscode-oss roots: recognising the roots but not the launcher would make the check
        // exit before the scan on a machine that only has VSCodium, and never report the extension it
        // would have found. See https://code.visualstudio.com/docs/terminal/shell-integration.
        if (string.Equals(
                environment.GetEnvironmentVariable("TERM_PROGRAM"),
                "vscode",
                StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        foreach (var launcher in s_vsCodeLaunchers)
        {
            if (commandResolver(launcher) is not null)
            {
                return true;
            }
        }

        // PATH is not a reliable installation signal. On macOS the "code" command only exists after
        // the user explicitly runs "Shell Command: Install 'code' command in PATH", so a doctor run
        // from a plain terminal on an ordinary VS Code machine reaches here with nothing found, and
        // returning false would drop the check entirely -- including the outdated-extension warning
        // it exists to produce. A populated extension root is installation evidence PATH cannot give:
        // VS Code creates it on first extension install and does not remove it on uninstall, so a
        // leftover root can outlive the product, which only ever costs an advisory recommendation.
        foreach (var root in VsCodeInstallLayout.GetExtensionRootPaths(environment, homeDirectory))
        {
            if (Directory.Exists(root.Path))
            {
                return true;
            }
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
/// Identifies where an installed extension version was read from.
/// </summary>
internal enum VsCodeExtensionVersionSource
{
    /// <summary>
    /// No version could be determined.
    /// </summary>
    None,

    /// <summary>
    /// The running extension reported its own version through the environment.
    /// </summary>
    Extension,

    /// <summary>
    /// The version was read from an installed extension's manifest or folder name on disk.
    /// </summary>
    Manifest
}

internal enum VsCodeExtensionReleaseChannel
{
    Unknown,
    Stable,
    PreRelease
}

internal enum VsCodeExtensionInstallSource
{
    Unknown,
    Marketplace
}

/// <summary>
/// Captures whether VS Code and the Aspire VS Code extension were detected, the version that was
/// resolved for the extension, and where that version came from.
/// </summary>
/// <param name="VsCodeInstalled">Whether a VS Code build was detected.</param>
/// <param name="ExtensionInstalled">Whether the Aspire extension was detected.</param>
/// <param name="ExtensionVersion">The resolved extension version, or <see langword="null"/> when it could not be determined.</param>
/// <param name="VersionSource">Where <paramref name="ExtensionVersion"/> was read from.</param>
/// <param name="ReleaseChannel">The Marketplace release channel for the installed extension.</param>
/// <param name="InstallSource">Where the installed extension came from.</param>
/// <param name="SearchedRoots">
/// The extension roots the disk scan looked at, used to explain an unknown version. It is
/// <see langword="null"/> when the version came from the environment and no scan ran.
/// </param>
internal sealed record VsCodeExtensionDetection(
    bool VsCodeInstalled,
    bool ExtensionInstalled,
    string? ExtensionVersion = null,
    VsCodeExtensionVersionSource VersionSource = VsCodeExtensionVersionSource.None,
    VsCodeExtensionReleaseChannel ReleaseChannel = VsCodeExtensionReleaseChannel.Unknown,
    VsCodeExtensionInstallSource InstallSource = VsCodeExtensionInstallSource.Unknown,
    IReadOnlyList<string>? SearchedRoots = null);

internal sealed record VsCodeExtensionDiskDetection(
    bool Installed,
    string? Version,
    VsCodeExtensionReleaseChannel ReleaseChannel,
    VsCodeExtensionInstallSource InstallSource,
    IReadOnlyList<string> SearchedRoots);

internal sealed record VsCodeExtensionRootDetection(
    bool Installed,
    SemVersion? Version,
    VsCodeExtensionReleaseChannel ReleaseChannel,
    VsCodeExtensionInstallSource InstallSource);
