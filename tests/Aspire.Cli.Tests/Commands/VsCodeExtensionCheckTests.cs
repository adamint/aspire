// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using System.Net;
using System.Text.Json;
using Aspire.Cli.Resources;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils.EnvironmentChecker;
using Microsoft.Extensions.Logging.Abstractions;
using Semver;

namespace Aspire.Cli.Tests.Commands;

public class VsCodeExtensionCheckTests(ITestOutputHelper outputHelper)
{
    private const string ReportedVersionVariable = VsCodeExtensionCheck.ExtensionVersionEnvironmentVariable;
    private const string ReportedChannelVariable = "ASPIRE_VSCODE_EXTENSION_CHANNEL";
    private const string ReportedSourceVariable = "ASPIRE_VSCODE_EXTENSION_SOURCE";

    [Fact]
    public async Task CheckAsync_ReturnsEmpty_WhenVsCodeNotInstalled()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // No TERM_PROGRAM and nothing resolvable on PATH, so real detection reports VS Code absent.
        var environment = new TestEnvironment(new Dictionary<string, string?>());
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var results = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.Empty(results);
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsWarning_WhenExtensionMissing()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // VS Code is present (TERM_PROGRAM) but the extension contributed no version and the override
        // extensions directory is empty.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckCategories.DevelopmentTools, result.Category);
        Assert.Equal(VsCodeExtensionCheck.CheckName, result.Name);
        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionMissingMessage, result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionMissingFix, result.Fix);
        Assert.Equal(VsCodeExtensionCheck.MarketplaceUrl, result.Link);
        Assert.NotNull(result.Metadata);
        Assert.True(result.Metadata["vsCodeInstalled"]!.GetValue<bool>());
        Assert.False(result.Metadata["extensionInstalled"]!.GetValue<bool>());
        Assert.Equal(VsCodeExtensionCheck.ExtensionId, result.Metadata["extensionId"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsPass_WhenReportedVersionMatchesMarketplace()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckCategories.DevelopmentTools, result.Category);
        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Null(result.Fix);
        Assert.Null(result.Link);
        Assert.NotNull(result.Metadata);
        Assert.True(result.Metadata["vsCodeInstalled"]!.GetValue<bool>());
        Assert.True(result.Metadata["extensionInstalled"]!.GetValue<bool>());
        Assert.Equal(VsCodeExtensionCheck.ExtensionId, result.Metadata["extensionId"]!.GetValue<string>());
        Assert.Equal("1.2.3", result.Metadata["extensionVersion"]!.GetValue<string>());
        Assert.Equal("1.2.3", result.Metadata["latestVersion"]!.GetValue<string>());
        Assert.Equal("stable", result.Metadata["latestVersionChannel"]!.GetValue<string>());
        Assert.False(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.True(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsWarning_WhenReportedVersionIsOutOfDate()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.5.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(
            string.Format(CultureInfo.CurrentCulture, DoctorCommandStrings.VsCodeExtensionOutOfDateMessageFormat, "1.2.3", "1.5.0"),
            result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionOutOfDateFix, result.Fix);
        Assert.Equal(VsCodeExtensionCheck.MarketplaceUrl, result.Link);
        Assert.NotNull(result.Metadata);
        Assert.Equal("1.2.3", result.Metadata["extensionVersion"]!.GetValue<string>());
        Assert.Equal("1.5.0", result.Metadata["latestVersion"]!.GetValue<string>());
        Assert.True(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsPass_WhenReportedVersionIsNewerThanMarketplaceVersion()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // A locally built or side-loaded extension can sit ahead of the gallery. That is not an
        // out-of-date install, so it must not produce a warning.
        var environment = CreateVsCodeEnvironmentWithReportedVersion("9.9.9");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.5.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.False(result.Metadata!["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_ComparesOnDiskVersion_WhenExtensionDidNotReportItsVersion()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Regression test for the reported defect: an extension predating the environment variable, or
        // a doctor run outside a VS Code-created process, must still be compared rather than passing.
        CreateInstalledExtension(extensions, "1.2.3");
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.9.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(
            string.Format(
                CultureInfo.CurrentCulture,
                DoctorCommandStrings.VsCodeExtensionOutOfDateMessageFormat,
                "1.2.3",
                "1.9.0"),
            result.Message);
        Assert.Equal("1.2.3", result.Metadata!["extensionVersion"]!.GetValue<string>());
        Assert.Equal("manifest", result.Metadata["extensionVersionSource"]!.GetValue<string>());
        Assert.True(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsPass_WhenOnDiskVersionIsCurrent()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, "1.9.0");
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.9.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Equal("1.9.0", result.Metadata!["extensionVersion"]!.GetValue<string>());
        Assert.False(result.Metadata["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_PrefersManifestVersionOverFolderName()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // The folder name is a convention; the manifest is the contract, so the manifest wins.
        CreateInstalledExtension(extensions, folderVersion: "1.2.3", manifestVersion: "1.9.0");
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.9.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("1.9.0", result.Metadata!["extensionVersion"]!.GetValue<string>());
    }

    [Fact]
    public async Task CheckAsync_UsesFolderVersion_WhenManifestIsMissing()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, folderVersion: "1.2.3", manifestVersion: null);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("1.2.3", result.Metadata!["extensionVersion"]!.GetValue<string>());
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenDiskInstallDoesNotIdentifyMarketplaceSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, "1.2.3", marketplace: false);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Equal("1.2.3", result.Metadata!["extensionVersion"]!.GetValue<string>());
        Assert.Equal("manifest", result.Metadata["extensionVersionSource"]!.GetValue<string>());
        Assert.Equal("unknown", result.Metadata["extensionInstallSource"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Theory]
    // VS Code leaves the previous directory behind after an upgrade, so the highest version wins.
    // The 1.9.0/1.10.0 pair is ordered by semver precedence, where an ordinal string sort is wrong.
    [InlineData(new[] { "1.9.0", "1.10.0" }, "1.10.0")]
    [InlineData(new[] { "1.10.0", "1.9.0" }, "1.10.0")]
    [InlineData(new[] { "1.2.3", "1.9.0", "1.10.2" }, "1.10.2")]
    public async Task CheckAsync_SelectsHighestInstalledVersion(string[] installedVersions, string expectedVersion)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        foreach (var installedVersion in installedVersions)
        {
            CreateInstalledExtension(extensions, installedVersion);
        }

        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse(expectedVersion, SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(expectedVersion, result.Metadata!["extensionVersion"]!.GetValue<string>());
        Assert.False(result.Metadata["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_ReturnsUnknownWarning_WhenInstalledVersionCannotBeDetermined()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // The extension is installed but neither the manifest nor the folder name yields a version, so
        // the outcome must be a distinct "unknown" warning rather than a pass on absent evidence.
        var extensionDirectory = Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.x-dev"));
        File.WriteAllText(Path.Combine(extensionDirectory.FullName, "package.json"), "{ \"name\": \"aspire-vscode\" }");
        // Overridden so the searched-roots detail names exactly one directory instead of every
        // default root the scan reports as looked at.
        var environment = CreateVsCodeEnvironmentWithOverriddenExtensionsRoot(extensions);
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionVersionUnknownMessage, result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionVersionUnknownFix, result.Fix);
        Assert.Equal(
            string.Format(
                CultureInfo.CurrentCulture,
                DoctorCommandStrings.VsCodeExtensionVersionUnknownSearchedDetailsFormat,
                extensions.FullName),
            result.Details);
        Assert.False(result.Metadata!["extensionVersionKnown"]!.GetValue<bool>());
        Assert.Equal("unknown", result.Metadata["extensionVersionSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_StillNamesTheSearchedRoots_WhenReportedVersionCannotBeParsed()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A corrupted variable must not be trusted, and must not short-circuit the disk scan either:
        // nothing it found may be adopted, but where it looked is still what the warning has to name
        // so the user can check those roots themselves.
        CreateInstalledExtension(extensions, "1.2.3");
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            // Overridden so the searched-roots detail names exactly one directory.
            ["VSCODE_EXTENSIONS"] = extensions.FullName,
            [ReportedVersionVariable] = "not-a-version"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(
            string.Format(
                CultureInfo.CurrentCulture,
                DoctorCommandStrings.VsCodeExtensionVersionUnknownSearchedDetailsFormat,
                extensions.FullName),
            result.Details);
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_IgnoresPlatformSuffixedFolderName_WhenManifestIsMissing()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A platform-specific VSIX unpacks to "<id>-1.2.3-darwin-arm64", whose suffix parses as the
        // semver pre-release "1.2.3-darwin-arm64". Without a manifest that is not a usable version.
        Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3-darwin-arm64"));
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionVersionUnknownMessage, result.Message);
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Theory]
    [InlineData("dns")]
    [InlineData("http")]
    [InlineData("io")]
    [InlineData("json")]
    [InlineData("timeout")]
    public async Task CheckAsync_ReturnsWarningWithDiagnostics_WhenMarketplaceLookupFails(string failureKind)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        Exception failure = failureKind switch
        {
            "dns" => new HttpRequestException("Name resolution failed."),
            "http" => new HttpRequestException("Marketplace returned 503.", null, HttpStatusCode.ServiceUnavailable),
            "io" => new IOException("Marketplace response stream failed."),
            "json" => new JsonException("Marketplace response was invalid JSON."),
            "timeout" => new TimeoutException("Marketplace request timed out."),
            _ => throw new ArgumentOutOfRangeException(nameof(failureKind))
        };
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromException<SemVersion>(failure)
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Equal(
            failureKind == "timeout"
                ? DoctorCommandStrings.VsCodeExtensionLatestVersionCheckTimedOutDetails
                : DoctorCommandStrings.VsCodeExtensionLatestVersionCheckUnavailableDetails,
            result.Details);
        Assert.Null(result.Fix);
        Assert.Null(result.Link);
        Assert.NotNull(result.Metadata);
        Assert.Equal("1.2.3", result.Metadata["extensionVersion"]!.GetValue<string>());
        Assert.Equal(failureKind == "timeout" ? "timeout" : "unavailable", result.Metadata["latestVersionError"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsWarningWithDiagnostics_WhenMarketplaceResponseIsInvalid()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        var failure = new InvalidDataException("Marketplace response did not contain the Aspire extension.");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => Task.FromException<VsCodeExtensionMarketplaceVersions>(failure)
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionLatestVersionCheckUnavailableDetails, result.Details);
        Assert.Null(result.Fix);
        Assert.Null(result.Link);
        Assert.NotNull(result.Metadata);
        Assert.Equal("1.2.3", result.Metadata["extensionVersion"]!.GetValue<string>());
        Assert.Equal("unavailable", result.Metadata["latestVersionError"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsWarningWithDiagnostics_WhenMarketplaceOmitsTheRequestedChannel()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // A pre-release channel signal selects the pre-release feed, but the gallery can report only
        // a stable version. Rather than silently comparing against the wrong channel, report the
        // lookup as unavailable.
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.3.0-preview.1.25601.3", channel: "pre-release");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionLatestVersionCheckUnavailableDetails, result.Details);
        Assert.Equal("unavailable", result.Metadata!["latestVersionError"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_PropagatesUnexpectedMarketplaceCancellation()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        using var internalCancellation = new CancellationTokenSource();
        internalCancellation.Cancel();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromCanceled<SemVersion>(internalCancellation.Token)
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => check.CheckAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task CheckAsync_PropagatesUnexpectedMarketplaceFailure()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => throw new InvalidOperationException("Unexpected implementation failure.")
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal("Unexpected implementation failure.", exception.Message);
    }

    [Fact]
    public async Task CheckAsync_PropagatesCallerCancellationDuringMarketplaceLookup()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        using var cancellationTokenSource = new CancellationTokenSource();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = cancellationToken =>
            {
                cancellationTokenSource.Cancel();
                return Task.FromCanceled<SemVersion>(cancellationToken);
            }
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => check.CheckAsync(cancellationTokenSource.Token));
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenUpdateNotificationsAreDisabled()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var features = new TestFeatures().SetFeature(KnownFeatures.UpdateNotificationsEnabled, false);
        var check = new VsCodeExtensionCheck(
            environment,
            TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home),
            marketplaceClient,
            features,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.False(result.Metadata!["updateCheckEnabled"]!.GetValue<bool>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Theory]
    [InlineData("1.2.3-preview.1", "1.3.0-preview.1", true)]
    [InlineData("1.2.3-preview.1", "1.2.3-preview.1", false)]
    [InlineData("1.3.0-preview.2", "1.3.0-preview.1", false)]
    public async Task CheckAsync_UsesPreReleaseChannel_WhenReportedVersionHasAPreReleaseTag(
        string installedVersion,
        string latestPreReleaseVersion,
        bool expectedUpdateAvailable)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion(installedVersion, channel: "pre-release");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => Task.FromResult(new VsCodeExtensionMarketplaceVersions(
                // Deliberately far ahead of every input so a stable-channel comparison would warn,
                // proving the pre-release feed is the one being used.
                StableVersion: SemVersion.Parse("99.0.0", SemVersionStyles.Strict),
                PreReleaseVersion: SemVersion.Parse(latestPreReleaseVersion, SemVersionStyles.Strict)))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(
            expectedUpdateAvailable ? EnvironmentCheckStatus.Warning : EnvironmentCheckStatus.Pass,
            result.Status);
        Assert.Equal(latestPreReleaseVersion, result.Metadata!["latestVersion"]!.GetValue<string>());
        Assert.Equal("pre-release", result.Metadata["latestVersionChannel"]!.GetValue<string>());
        Assert.Equal(expectedUpdateAvailable, result.Metadata["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_UsesPreReleaseChannel_WhenReportedChannelIsPreReleaseWithoutSemverTag()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.17.0", channel: "pre-release");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => Task.FromResult(new VsCodeExtensionMarketplaceVersions(
                StableVersion: SemVersion.Parse("99.0.0", SemVersionStyles.Strict),
                PreReleaseVersion: SemVersion.Parse("1.18.0", SemVersionStyles.Strict)))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("1.18.0", result.Metadata!["latestVersion"]!.GetValue<string>());
        Assert.Equal("pre-release", result.Metadata["latestVersionChannel"]!.GetValue<string>());
        Assert.True(result.Metadata["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenExtensionDoesNotReportMarketplaceSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.17.0", source: "unknown");
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Equal("1.17.0", result.Metadata!["extensionVersion"]!.GetValue<string>());
        Assert.Equal("unknown", result.Metadata["extensionInstallSource"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_UsesStableChannel_WhenReportedVersionHasNoPreReleaseTag()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.2.3");
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => Task.FromResult(new VsCodeExtensionMarketplaceVersions(
                StableVersion: SemVersion.Parse("1.2.3", SemVersionStyles.Strict),
                // Ahead of the stable version, as the gallery requires. Comparing against this feed
                // would produce a spurious warning for a stable install.
                PreReleaseVersion: SemVersion.Parse("1.3.0-preview.1", SemVersionStyles.Strict)))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("1.2.3", result.Metadata!["latestVersion"]!.GetValue<string>());
        Assert.Equal("stable", result.Metadata["latestVersionChannel"]!.GetValue<string>());
        Assert.False(result.Metadata["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenManifestRecordsAVsixInstallSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // VS Code looks a side-loaded VSIX up in the gallery and stores the matched publisherId, so
        // publisherId alone does not prove a Marketplace install. __metadata.source records the real
        // origin and has to win over it.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "publisherId": "microsoft-aspire", "isPreReleaseVersion": false, "source": "vsix" }
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenTheRecordedInstallSourceIsMalformed()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A source VS Code did write, in any shape, settles the question. Treating a malformed one as
        // absent would let the weaker publisherId inference override metadata that is present but
        // untrustworthy, and send the outbound request this signal exists to gate.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "source": 7, "publisherId": "5f5636e7-69ed-4afe-b5d6-8d231fb3d3ee" }
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_UsesTheTrackedChannel_WhenItDisagreesWithTheInstalledArtifact()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Opting into pre-release updates flips `preRelease` immediately while `isPreReleaseVersion`
        // still describes the stable artifact on disk. The install now moves along the pre-release
        // feed, so that is the feed the comparison has to use.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "targetPlatform": "undefined" }
            """);
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "isPreReleaseVersion": false, "preRelease": true, "source": "gallery" }
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => Task.FromResult(new VsCodeExtensionMarketplaceVersions(
                SemVersion.Parse("9.9.9", SemVersionStyles.Strict),
                SemVersion.Parse("1.2.3", SemVersionStyles.Strict)))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("pre-release", result.Metadata!["extensionChannel"]!.GetValue<string>());
    }

    [Fact]
    public void Detect_ReportsVsCodeInstalled_WhenOnlyTheVsCodiumLauncherIsOnPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, "1.2.3");
        // The layout scans VSCodium's .vscode-oss roots, so a machine with only VSCodium must not be
        // dismissed before the scan runs; the extension is installed and doctor has to say so.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
        });

        var detection = VsCodeExtensionCheck.Detect(
            environment,
            home,
            command => command == "codium" ? "/usr/local/bin/codium" : null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
    }

    [Fact]
    public async Task CheckAsync_ChecksMarketplace_WhenTheExtensionReportsItselfWithoutAnInstallSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Current VS Code hides the install origin from the extension host, so the extension reports a
        // version and no source. Without recovering the source from disk the Marketplace comparison
        // would never run on the path that reports the most accurate version.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "targetPlatform": "undefined", "installedTimestamp": 1780396882003 }
            """);
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "isPreReleaseVersion": false, "source": "gallery" }
            }]
            """);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [VsCodeExtensionCheck.ExtensionVersionEnvironmentVariable] = "1.2.3"
        });
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.3.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("extension", result.Metadata!["extensionVersionSource"]!.GetValue<string>());
        Assert.Equal("marketplace", result.Metadata["extensionInstallSource"]!.GetValue<string>());
        Assert.True(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotAdoptTheDiskInstallSource_WhenItDescribesADifferentVersion()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // The reported version wins over disk precisely because the running instance can live in a root
        // the CLI cannot see. A record for some other version is then a different copy of the extension,
        // and its install origin says nothing about the one that is loaded.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "targetPlatform": "undefined" }
            """);
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "isPreReleaseVersion": false, "source": "gallery" }
            }]
            """);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [VsCodeExtensionCheck.ExtensionVersionEnvironmentVariable] = "9.9.9"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("9.9.9", result.Metadata!["extensionVersion"]!.GetValue<string>());
        Assert.Equal("unknown", result.Metadata["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenTheProfileIndexRecordsAVsixInstall()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A side-loaded VSIX that the gallery matched carries a publisherId in the extracted manifest,
        // which on its own reads as a Marketplace install. The profile index records the real origin,
        // so it has to override the manifest rather than merely being a fallback for it.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "publisherId": "5f5636e7-69ed-4afe-b5d6-8d231fb3d3ee" }
            """);
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "publisherId": "5f5636e7-69ed-4afe-b5d6-8d231fb3d3ee", "isPreReleaseVersion": false, "source": "vsix" }
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ChecksMarketplace_WhenTheProfileIndexRecordsAGalleryInstall()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Current VS Code trims the extracted manifest's __metadata down to installer bookkeeping, so
        // the profile index is the only place a Marketplace install can still be recognised from.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "targetPlatform": "undefined", "installedTimestamp": 1780396882003, "size": 1234 }
            """);
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "isPreReleaseVersion": false, "source": "gallery" }
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.3.0", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("marketplace", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal("stable", result.Metadata["extensionChannel"]!.GetValue<string>());
        Assert.True(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ComparesAgainstThePreReleaseFeed_WhenTheProfileIndexRecordsAPreReleaseInstall()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "targetPlatform": "undefined", "installedTimestamp": 1780396882003 }
            """);
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "isPreReleaseVersion": true, "source": "gallery" }
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            // The stable channel is far ahead of the installed build, so a run that compared against it
            // would warn. Landing on Pass proves the pre-release channel came from the profile index.
            GetLatestVersionsAsyncCallback = _ => Task.FromResult(new VsCodeExtensionMarketplaceVersions(
                SemVersion.Parse("9.9.9", SemVersionStyles.Strict),
                SemVersion.Parse("1.2.3", SemVersionStyles.Strict)))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("pre-release", result.Metadata!["extensionChannel"]!.GetValue<string>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ChecksMarketplace_WhenManifestRecordsAGalleryInstallSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "isPreReleaseVersion": false, "source": "gallery" }
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("marketplace", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReportsUnknownChannel_WhenManifestPreReleaseFlagIsNotABoolean()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A manifest that stringifies the flag cannot be trusted to say which feed to compare
        // against, and guessing stable would report a pre-release install as out of date.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "source": "gallery", "publisherId": "microsoft-aspire", "isPreReleaseVersion": "true" }
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionChannel"]!.GetValue<string>());
        Assert.Equal("unavailable", result.Metadata["latestVersionError"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_UsesStableChannel_WhenManifestOmitsThePreReleaseFlag()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // VS Code coerces the flag with !!metadata.isPreReleaseVersion and gallery installs predating
        // it were written without it, so an absent flag means stable. Reporting unknown here would
        // retire the comparison for every one of those installs.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "source": "gallery", "publisherId": "microsoft-aspire" }
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("stable", result.Metadata!["extensionChannel"]!.GetValue<string>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsUnknownVersionWarning_WhenReportedVersionIsUnparseableAndNothingIsOnDisk()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Only the running extension sets the variable, so a corrupted value still proves the
        // extension is loaded. Telling the user to install what they already have would be wrong.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = "not-a-version"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionVersionUnknownMessage, result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionVersionUnknownFix, result.Fix);
        Assert.True(result.Metadata!["extensionInstalled"]!.GetValue<bool>());
        Assert.False(result.Metadata["extensionVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotAdoptADiskInstall_WhenTheReportedVersionIsUnparseable()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A stale Marketplace copy under a default root, and a running instance the scan cannot see
        // (portable mode or --extensions-dir) whose reported version does not parse. The disk record
        // describes a different installation, so adopting its version would produce a confident
        // update verdict about something the user is not running.
        CreateInstalledExtension(extensions, "1.0.0", marketplace: true);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = "not-a-version"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionVersionUnknownMessage, result.Message);
        Assert.True(result.Metadata!["extensionInstalled"]!.GetValue<bool>());
        Assert.False(result.Metadata["extensionVersionKnown"]!.GetValue<bool>());
        Assert.Equal("unknown", result.Metadata["extensionVersionSource"]!.GetValue<string>());
        Assert.Equal("unknown", result.Metadata["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public void Detect_UsesVersionReportedByTheRunningExtension()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion("1.16.0");

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.16.0", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_TrimsReportedVersion()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = CreateVsCodeEnvironmentWithReportedVersion(" 1.16.0\n");

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.Equal("1.16.0", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_ReportsExtensionInstalled_WhenNothingIsOnDiskButTheExtensionReportedItself()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Remote, portable, and --extensions-dir installs put the extension somewhere the CLI cannot
        // enumerate. The contributed version is authoritative precisely for those cases.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = "1.16.0"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.16.0", detection.ExtensionVersion);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Detect_FallsBackToDisk_WhenReportedVersionIsBlank(string reportedVersion)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = reportedVersion
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
        Assert.Equal(VsCodeExtensionVersionSource.Manifest, detection.VersionSource);
    }

    [Fact]
    public void Detect_FindsExtension_ViaVsCodeExtensionsOverride()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3"));
        var environment = CreateVsCodeEnvironmentWithOverriddenExtensionsRoot(extensions);

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
        Assert.Equal(VsCodeExtensionVersionSource.Manifest, detection.VersionSource);
        Assert.Equal([extensions.FullName], detection.SearchedRoots);
        // The override names a directory, not a product, so it can never be classified as a
        // Marketplace install however familiar the path looks.
        Assert.Equal(VsCodeExtensionInstallSource.Unknown, detection.InstallSource);
    }

    [Fact]
    public void Detect_IgnoresDefaultRoots_WhenVsCodeExtensionsOverrideSet()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var overrideDirectory = workspace.CreateDirectory("override");
        // VSCODE_EXTENSIONS replaces the extension location outright, so an install under the home
        // default must not be reported when the override points somewhere else.
        Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = overrideDirectory.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_ReturnsUnknownVersion_WhenMultipleDefaultRootsContainTheExtension()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-9.9.9"));
        Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode-server", "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
        Assert.Null(detection.ExtensionVersion);
        Assert.Equal(VsCodeExtensionVersionSource.None, detection.VersionSource);
    }

    [Fact]
    public void Detect_IgnoresObsoleteExtensionDirectory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        const string folderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, folderName));
        File.WriteAllText(Path.Combine(extensions.FullName, ".obsolete"), $$"""{"{{folderName}}":true}""");
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_KeepsExtensionDirectory_WhenItsObsoleteMarkerIsNotTrue()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, "1.2.3");
        // VS Code clears a marker by writing false rather than removing the key, so treating the key
        // alone as obsolete would hide an active install and report the extension as missing.
        File.WriteAllText(
            Path.Combine(extensions.FullName, ".obsolete"),
            """{"microsoft-aspire.aspire-vscode-1.2.3":false}""");
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_FindsVsCode_WhenNoLauncherIsOnPathButAnExtensionRootExists()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, "1.2.3");
        // The normal macOS setup: "code" is only on PATH after the user runs the explicit shell
        // command, so a doctor run from a plain terminal has no launcher and no TERM_PROGRAM.
        var environment = new TestEnvironment();

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
    }

    [Theory]
    [InlineData(".vscode")]
    [InlineData(".vscode-insiders")]
    [InlineData(".vscode-oss")]
    [InlineData(".vscode-server")]
    [InlineData(".vscode-server-insiders")]
    [InlineData(".vscode-server-oss")]
    [InlineData(".vscodium-insiders")]
    [InlineData(".vscodium-server")]
    [InlineData(".vscodium-server-insiders")]
    public void Detect_FindsExtension_ViaEachDefaultExtensionsRoot(string rootFolder)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // Exercise every default extensions root VsCodeInstallLayout composes: the desktop folders for
        // stable/Insiders/VSCodium and their remote/server counterparts.
        Directory.CreateDirectory(Path.Combine(home.FullName, rootFolder, "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
    }

    [Theory]
    [InlineData("code")]
    [InlineData("code-insiders")]
    public void Detect_DetectsVsCode_ViaPathFallback_WhenTermProgramNotVsCode(string launcherOnPath)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // No TERM_PROGRAM, so detection falls back to probing the CLI launchers on PATH via the
        // injected resolver.
        var environment = new TestEnvironment(new Dictionary<string, string?>());
        string? Resolver(string command) => string.Equals(command, launcherOnPath, StringComparison.Ordinal) ? "/usr/bin/" + command : null;

        var detection = VsCodeExtensionCheck.Detect(environment, home, Resolver);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_ReportsVsCodeNotInstalled_WhenTermProgramAbsentAndNotOnPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var environment = new TestEnvironment(new Dictionary<string, string?>());

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.False(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_IgnoresReportedVersion_WhenVsCodeIsNotInstalled()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // A stale variable inherited from an unrelated parent process must not make the check claim
        // VS Code is present.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            [ReportedVersionVariable] = "1.16.0"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.False(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
        Assert.Null(detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_MatchesExtensionFolder_CaseInsensitively()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "Microsoft-Aspire.Aspire-VSCode-9.9.9"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_ReportsExtensionMissing_WhenOnlyUnrelatedExtensionsPresent()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "ms-dotnettools.csharp-2.0.0"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_ReportsExtensionMissing_WhenFolderSharesPrefixWithDifferentId()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // A different extension whose id begins with ours. Without the digit boundary the prefix match
        // would incorrectly treat this as the Aspire extension.
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-extras-1.0.0"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_ReportsExtensionMissing_WhenExtensionsDirectoryDoesNotExist()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // Point the override at a path that is never created so DirectoryContainsExtension hits the
        // Directory.Exists == false guard. VS Code being present must still yield a clean "missing"
        // result rather than throwing on the absent directory.
        var missingExtensionsDirectory = Path.Combine(home.FullName, "does-not-exist");
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = missingExtensionsDirectory
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    private static TestEnvironment CreateVsCodeEnvironmentWithReportedVersion(
        string reportedVersion,
        string channel = "stable",
        string source = "marketplace")
        => new(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = reportedVersion,
            [ReportedChannelVariable] = channel,
            [ReportedSourceVariable] = source
        });

    // Points the extension root at a temporary directory so the scan never reads the real
    // ~/.vscode/extensions of the machine running the tests.
    [Fact]
    public async Task CheckAsync_OmitsTheMarketplaceLink_WhenTheVersionIsUnknownAndTheInstallIsNotFromTheMarketplace()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // The unknown-version warning is raised before the install-source guard, so it is the one
        // place a side-load or an Open VSX install can still be handed a Marketplace link for a feed
        // it did not come from.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = "not-a-version"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.False(result.Metadata!["extensionVersionKnown"]!.GetValue<bool>());
        Assert.Null(result.Link);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenTheExtensionsRootIsOverriddenToAnUnrecognizedPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // VS Code, VSCodium, and code-oss all honor VSCODE_EXTENSIONS, so an override that matches no
        // known data folder cannot say which gallery "gallery" refers to.
        var extensions = workspace.CreateDirectory("portable-extensions");
        CreateInstalledExtension(extensions, "1.2.3");
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "source": "gallery", "isPreReleaseVersion": false }
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithOverriddenExtensionsRoot(extensions);
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenTheExtensionsRootIsOverriddenToAMicrosoftDataFolder()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // Pointing the override at VS Code's own data folder does not make the running product VS
        // Code -- VSCodium honors VSCODE_EXTENSIONS too, and the "gallery" it records there is Open
        // VSX. The path carries no product identity, so it cannot license a Marketplace request.
        var extensions = CreateDefaultExtensionsRoot(home);
        CreateInstalledExtension(extensions, "1.2.3", marketplace: true);
        var environment = CreateVsCodeEnvironmentWithOverriddenExtensionsRoot(extensions);
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReportsTheVersionTheProfileIndexLists_WhenTheEntryCarriesNoMetadata()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // metadata is optional in the stored schema, but relativeLocation still names the folder the
        // profile loads. Discarding the entry would hand the choice back to the highest version on
        // disk, which is the stale folder.
        CreateInstalledExtension(extensions, "1.2.3");
        CreateInstalledExtension(extensions, "9.9.9");
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3"
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal("1.2.3", result.Metadata!["extensionVersion"]!.GetValue<string>());
    }

    [Fact]
    public async Task CheckAsync_DoesNotAdoptTheDiskRecord_WhenItDiffersOnlyByBuildMetadata()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // Semver precedence ignores build metadata, so 1.2.3+disk and 1.2.3+loaded would compare equal
        // and let a different build donate its origin to the running instance.
        CreateInstalledExtension(extensions, "1.2.3", "1.2.3+disk");
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            [ReportedVersionVariable] = "1.2.3+loaded"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenOnlyAPublisherIdIsRecorded()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // VS Code looks a side-loaded VSIX up in the gallery on install and stamps the matched
        // publisherId onto it, so a publisherId with no recorded source does not establish that the
        // install came from the Marketplace, and guessing that it did makes the outbound request the
        // source check exists to avoid.
        CreateInstalledExtensionWithMetadata(
            extensions,
            "1.2.3",
            """
            { "publisherId": "microsoft-aspire", "isPreReleaseVersion": false }
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReportsTheVersionTheProfileIndexLists_WhenAHigherVersionedFolderRemainsOnDisk()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = CreateDefaultExtensionsRoot(home);
        // An interrupted update or a hand-copied directory leaves a higher-numbered folder behind that
        // the profile never loads. The index names the folder VS Code actually runs, so reporting the
        // highest folder on disk would describe an extension the user does not have loaded.
        CreateInstalledExtension(extensions, "1.2.3");
        CreateInstalledExtension(extensions, "9.9.9");
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "source": "gallery", "isPreReleaseVersion": false }
            }]
            """);
        var environment = CreateVsCodeEnvironmentWithoutReportedVersion();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("1.2.3", result.Metadata!["extensionVersion"]!.GetValue<string>());
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenTheInstallCameFromAnOpenVsxBuild()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // VSCodium points extensionsGallery at Open VSX, so "gallery" in one of its roots means Open
        // VSX. Comparing that install against the VS Code Marketplace would report an update from a
        // feed the extension was never published to.
        var extensions = Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode-oss", "extensions"));
        CreateInstalledExtension(extensions, "1.2.3");
        CreateProfileExtensionIndex(
            extensions,
            """
            [{
              "identifier": { "id": "microsoft-aspire.aspire-vscode" },
              "version": "1.2.3",
              "relativeLocation": "microsoft-aspire.aspire-vscode-1.2.3",
              "metadata": { "source": "gallery", "isPreReleaseVersion": false }
            }]
            """);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });
        var marketplaceClient = CreateUnusedMarketplaceClient();
        var check = CreateCheck(environment, home, marketplaceClient);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionInstallSource"]!.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    // The default desktop root of a Marketplace build. Tests point VSCODE_EXTENSIONS here rather than
    // at an arbitrary directory because the override is product-agnostic: only a path that matches a
    // known Microsoft-gallery folder is treated as one.
    private static DirectoryInfo CreateDefaultExtensionsRoot(DirectoryInfo home)
        => Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode", "extensions"));

    // The default roots are scanned relative to the home directory the check is given, so tests that
    // lay their extension out under ~/.vscode/extensions need no override -- and must not set one,
    // because an overridden root names a directory rather than a product and is deliberately never
    // classified as a Marketplace install.
    private static TestEnvironment CreateVsCodeEnvironmentWithoutReportedVersion()
        => new(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

    private static TestEnvironment CreateVsCodeEnvironmentWithOverriddenExtensionsRoot(DirectoryInfo extensions)
        => new(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

    private static void CreateInstalledExtension(DirectoryInfo extensionsRoot, string version)
        => CreateInstalledExtension(extensionsRoot, version, version);

    private static void CreateInstalledExtension(DirectoryInfo extensionsRoot, string version, bool marketplace)
        => CreateInstalledExtension(extensionsRoot, version, version, marketplace);

    // Lays out an extension the way VS Code extracts a VSIX: a "<publisher>.<name>-<version>" folder
    // containing the manifest the extension host reads.
    private static void CreateInstalledExtension(
        DirectoryInfo extensionsRoot,
        string folderVersion,
        string? manifestVersion)
        => CreateInstalledExtension(extensionsRoot, folderVersion, manifestVersion, marketplace: true);

    private static void CreateInstalledExtension(
        DirectoryInfo extensionsRoot,
        string folderVersion,
        string? manifestVersion,
        bool marketplace)
    {
        var directory = Directory.CreateDirectory(
            Path.Combine(extensionsRoot.FullName, $"microsoft-aspire.aspire-vscode-{folderVersion}"));

        if (manifestVersion is not null)
        {
            var metadata = marketplace
                ? """
                  ,"__metadata":{
                    "id":"microsoft-aspire.aspire-vscode",
                    "publisherId":"microsoft-aspire",
                    "source":"gallery",
                    "isPreReleaseVersion":false
                  }
                  """
                : string.Empty;
            File.WriteAllText(
                Path.Combine(directory.FullName, "package.json"),
                $$"""{ "name": "aspire-vscode", "publisher": "microsoft-aspire", "version": "{{manifestVersion}}"{{metadata}} }""");
        }
    }

    // Lays out an installed extension whose manifest carries a specific __metadata body, so tests can
    // reproduce the exact scanner-owned shapes VS Code writes, for example:
    //   "__metadata": { "publisherId": "microsoft-aspire", "isPreReleaseVersion": false, "source": "gallery" }
    private static void CreateInstalledExtensionWithMetadata(
        DirectoryInfo extensionsRoot,
        string version,
        string metadataJson)
    {
        var directory = Directory.CreateDirectory(
            Path.Combine(extensionsRoot.FullName, $"microsoft-aspire.aspire-vscode-{version}"));

        File.WriteAllText(
            Path.Combine(directory.FullName, "package.json"),
            $$"""{ "name": "aspire-vscode", "publisher": "microsoft-aspire", "version": "{{version}}", "__metadata": {{metadataJson}} }""");
    }

    // Mirrors the profile index VS Code maintains next to the extracted extension folders; entries are
    // keyed by relativeLocation, which is the extracted folder name the disk scan enumerates.
    private static void CreateProfileExtensionIndex(DirectoryInfo extensionsRoot, string entriesJson)
        => File.WriteAllText(Path.Combine(extensionsRoot.FullName, "extensions.json"), entriesJson);

    private static TestVsCodeExtensionMarketplaceClient CreateUnusedMarketplaceClient()
        => new()
        {
            StableVersionCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };

    private static VsCodeExtensionCheck CreateCheck(
        TestEnvironment environment,
        DirectoryInfo home,
        TestVsCodeExtensionMarketplaceClient marketplaceClient)
        => new(
            environment,
            TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home),
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);
}
