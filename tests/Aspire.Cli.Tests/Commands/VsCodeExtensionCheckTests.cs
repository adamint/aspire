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
    [Fact]
    public async Task CheckAsync_ReturnsEmpty_WhenVsCodeNotInstalled()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // No TERM_PROGRAM and nothing resolvable on PATH, so real detection reports VS Code absent.
        var environment = new TestEnvironment(new Dictionary<string, string?>());
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var results = await check.CheckAsync(TestContext.Current.CancellationToken);

        Assert.Empty(results);
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsWarning_WhenExtensionMissing()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        // VS Code is present (TERM_PROGRAM) but the override extensions directory is empty.
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

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
    public async Task CheckAsync_ReturnsPass_WhenExtensionInstalled()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        // VS Code is present and the Aspire extension is installed in the override extensions directory.
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

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
    public async Task CheckAsync_ReturnsWarning_WhenInstalledExtensionIsOutOfDate()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.3.0", SemVersionStyles.Strict))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Warning, result.Status);
        Assert.Equal(
            string.Format(
                CultureInfo.CurrentCulture,
                DoctorCommandStrings.VsCodeExtensionOutOfDateMessageFormat,
                "1.2.3",
                "1.3.0"),
            result.Message);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionOutOfDateFix, result.Fix);
        Assert.Equal(VsCodeExtensionCheck.MarketplaceUrl, result.Link);
        Assert.NotNull(result.Metadata);
        Assert.Equal("1.2.3", result.Metadata["extensionVersion"]!.GetValue<string>());
        Assert.Equal("1.3.0", result.Metadata["latestVersion"]!.GetValue<string>());
        Assert.Equal("stable", result.Metadata["latestVersionChannel"]!.GetValue<string>());
        Assert.True(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.True(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsPass_WhenInstalledExtensionIsNewerThanMarketplaceVersion()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-2.0.0";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "2.0.0", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.3.0", SemVersionStyles.Strict))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Null(result.Fix);
        Assert.Null(result.Link);
        Assert.NotNull(result.Metadata);
        Assert.Equal("2.0.0", result.Metadata["extensionVersion"]!.GetValue<string>());
        Assert.Equal("1.3.0", result.Metadata["latestVersion"]!.GetValue<string>());
        Assert.Equal("stable", result.Metadata["latestVersionChannel"]!.GetValue<string>());
        Assert.False(result.Metadata["updateAvailable"]!.GetValue<bool>());
        Assert.True(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsPassWithoutMarketplaceCall_WhenInstalledVersionCannotBeParsed()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.invalid"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(DoctorCommandStrings.VsCodeExtensionInstalledMessage, result.Message);
        Assert.Null(result.Fix);
        Assert.Null(result.Link);
        Assert.NotNull(result.Metadata);
        Assert.False(result.Metadata.ContainsKey("extensionVersion"));
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
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
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
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
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

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
    public async Task CheckAsync_PropagatesUnexpectedMarketplaceCancellation()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        using var internalCancellation = new CancellationTokenSource();
        internalCancellation.Cancel();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromCanceled<SemVersion>(internalCancellation.Token)
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => check.CheckAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task CheckAsync_PropagatesUnexpectedMarketplaceFailure()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => throw new InvalidOperationException("Unexpected implementation failure.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal("Unexpected implementation failure.", exception.Message);
    }

    [Fact]
    public async Task CheckAsync_PropagatesCallerCancellationDuringMarketplaceLookup()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        using var cancellationTokenSource = new CancellationTokenSource();
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = cancellationToken =>
            {
                cancellationTokenSource.Cancel();
                return Task.FromCanceled<SemVersion>(cancellationToken);
            }
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => check.CheckAsync(cancellationTokenSource.Token));
        Assert.Equal(1, marketplaceClient.CallCount);
    }

    [Fact]
    public void Detect_FindsExtension_ViaVsCodeExtensionsOverride()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_PrefersPackageJsonVersionOverFolderVersion()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionDirectory = Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3"));
        File.WriteAllText(
            Path.Combine(extensionDirectory.FullName, "package.json"),
            """{"version":"2.3.4"}""");

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("2.3.4", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_FallsBackToFolderVersion_WhenPackageJsonCannotBeParsed()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionDirectory = Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3-darwin-arm64"));
        File.WriteAllText(Path.Combine(extensionDirectory.FullName, "package.json"), "{");

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_FallsBackToFolderVersion_WhenPackageVersionIsInvalid()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionDirectory = Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3"));
        File.WriteAllText(
            Path.Combine(extensionDirectory.FullName, "package.json"),
            """{"version":"not-a-version"}""");

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_PreservesPreReleaseFolderVersion_WhenPackageJsonIsUnavailable()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3-preview.4"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.2.3-preview.4", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_DoesNotPublishInvalidFolderVersion_WhenPackageJsonIsUnavailable()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(
            Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.invalid"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Null(detection.ExtensionVersion);
    }

    [Fact]
    public async Task CheckAsync_UsesPreReleaseChannelFromExtensionsIndex()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: true);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal("pre-release", result.Metadata!["extensionReleaseChannel"]?.GetValue<string>());
    }

    [Fact]
    public async Task CheckAsync_UsesStableChannelFromExtensionsIndex()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.2.3", SemVersionStyles.Strict))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal("stable", result.Metadata!["extensionReleaseChannel"]?.GetValue<string>());
        Assert.Equal("gallery", result.Metadata["extensionSource"]?.GetValue<string>());
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenExtensionsIndexLacksReleaseChannelMetadata()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: null);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionReleaseChannel"]?.GetValue<string>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Theory]
    [InlineData("vsix")]
    [InlineData("resource")]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenExtensionIsNotGalleryInstalled(string source)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false, source);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal(source, result.Metadata!["extensionSource"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenExtensionInstallSourceIsUnknown()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        const string extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false, source: null);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.Equal("unknown", result.Metadata!["extensionSource"]!.GetValue<string>());
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenUpdateNotificationsAreDisabled()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionFolderName = "microsoft-aspire.aspire-vscode-1.2.3";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, "1.2.3", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => throw new InvalidOperationException("Marketplace must not be queried.")
        };
        var features = new TestFeatures().SetFeature(KnownFeatures.UpdateNotificationsEnabled, false);
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
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
    [InlineData("1.2.3", "1.3.0", true)]
    [InlineData("1.2.3", "1.2.3", false)]
    [InlineData("1.3.0", "1.2.3", false)]
    public async Task CheckAsync_UsesMatchingMarketplaceChannel_ForPreReleaseInstall(
        string installedVersion,
        string latestPreReleaseVersion,
        bool expectedUpdateAvailable)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        var extensionFolderName = $"microsoft-aspire.aspire-vscode-{installedVersion}";
        Directory.CreateDirectory(Path.Combine(extensions.FullName, extensionFolderName));
        WriteExtensionsIndex(extensions, extensionFolderName, installedVersion, isPreReleaseVersion: true);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            GetLatestVersionsAsyncCallback = _ => Task.FromResult(new VsCodeExtensionMarketplaceVersions(
                StableVersion: SemVersion.Parse("99.0.0", SemVersionStyles.Strict),
                PreReleaseVersion: SemVersion.Parse(latestPreReleaseVersion, SemVersionStyles.Strict)))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(
            expectedUpdateAvailable ? EnvironmentCheckStatus.Warning : EnvironmentCheckStatus.Pass,
            result.Status);
        Assert.Equal(latestPreReleaseVersion, result.Metadata!["latestVersion"]!.GetValue<string>());
        Assert.Equal("pre-release", result.Metadata["latestVersionChannel"]?.GetValue<string>());
        Assert.Equal(expectedUpdateAvailable, result.Metadata["updateAvailable"]!.GetValue<bool>());
    }

    [Fact]
    public void Detect_SelectsHighestValidInstalledVersionWithinActiveRoot()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-2.0.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode-insiders", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_GIT_ASKPASS_MAIN"] = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass-main.js"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("2.0.0", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_UsesStableRoot_WhenStableIntegratedTerminalIsActive()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var stableExtensions = Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode", "extensions"));
        var insidersExtensions = Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode-insiders", "extensions"));
        const string stableFolderName = "microsoft-aspire.aspire-vscode-1.0.0";
        const string insidersFolderName = "microsoft-aspire.aspire-vscode-2.0.0";
        Directory.CreateDirectory(Path.Combine(stableExtensions.FullName, stableFolderName));
        Directory.CreateDirectory(Path.Combine(insidersExtensions.FullName, insidersFolderName));
        WriteExtensionsIndex(stableExtensions, stableFolderName, "1.0.0", isPreReleaseVersion: false);
        WriteExtensionsIndex(insidersExtensions, insidersFolderName, "2.0.0", isPreReleaseVersion: false);
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode-server", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_GIT_ASKPASS_MAIN"] = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass-main.js"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.0.0", detection.ExtensionVersion);
    }

    [Theory]
    [InlineData("/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions/git/dist/askpass-main.js")]
    [InlineData("/usr/share/code-insiders/resources/app/extensions/git/dist/askpass-main.js")]
    [InlineData(@"C:\Users\test\AppData\Local\Programs\Microsoft VS Code Insiders\Code - Insiders.exe")]
    public void Detect_UsesInsidersRoot_WhenInsidersIntegratedTerminalIsActive(string askPassPath)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode-insiders", "extensions", "microsoft-aspire.aspire-vscode-2.0.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode-server", "extensions", "microsoft-aspire.aspire-vscode-4.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_GIT_ASKPASS_MAIN"] = askPassPath
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("2.0.0", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_UsesServerRoot_WhenAgentFolderIdentifiesActiveServer()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var agentFolder = workspace.CreateDirectory("active-server");
        Directory.CreateDirectory(
            Path.Combine(agentFolder.FullName, "extensions", "microsoft-aspire.aspire-vscode-1.5.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_AGENT_FOLDER"] = agentFolder.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.5.0", detection.ExtensionVersion);
    }

    [Theory]
    [InlineData("/usr/bin/code", ".vscode-server", "1.5.0")]
    [InlineData("/usr/bin/code-insiders", ".vscode-server-insiders", "1.6.0")]
    public void Detect_UsesServerRoot_WhenRemoteClientCommandIdentifiesChannel(
        string clientCommand,
        string serverRoot,
        string expectedVersion)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode-insiders", "extensions", "microsoft-aspire.aspire-vscode-4.0.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, serverRoot, "extensions", $"microsoft-aspire.aspire-vscode-{expectedVersion}"));
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_IPC_HOOK_CLI"] = "/run/user/1000/vscode-ipc.sock",
            ["VSCODE_CLIENT_COMMAND"] = clientCommand
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal(expectedVersion, detection.ExtensionVersion);
    }

    [Fact]
    public async Task CheckAsync_DoesNotCheckMarketplace_WhenActiveRootCannotBeIdentified()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var stableExtensions = Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode", "extensions"));
        var insidersExtensions = Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode-insiders", "extensions"));
        const string stableFolderName = "microsoft-aspire.aspire-vscode-1.0.0";
        const string insidersFolderName = "microsoft-aspire.aspire-vscode-2.0.0";
        Directory.CreateDirectory(Path.Combine(stableExtensions.FullName, stableFolderName));
        Directory.CreateDirectory(Path.Combine(insidersExtensions.FullName, insidersFolderName));
        WriteExtensionsIndex(stableExtensions, stableFolderName, "1.0.0", isPreReleaseVersion: false);
        WriteExtensionsIndex(insidersExtensions, insidersFolderName, "2.0.0", isPreReleaseVersion: false);
        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(home, homeDirectory: home);
        var marketplaceClient = new TestVsCodeExtensionMarketplaceClient
        {
            StableVersionCallback = _ => Task.FromResult(SemVersion.Parse("1.5.0", SemVersionStyles.Strict))
        };
        var check = new VsCodeExtensionCheck(
            environment,
            executionContext,
            marketplaceClient,
            NullLogger<VsCodeExtensionCheck>.Instance,
            _ => null);

        var result = Assert.Single(await check.CheckAsync(TestContext.Current.CancellationToken));

        Assert.Equal(EnvironmentCheckStatus.Pass, result.Status);
        Assert.True(result.Metadata!["extensionInstalled"]!.GetValue<bool>());
        Assert.Equal("unknown", result.Metadata["vsCodeChannel"]!.GetValue<string>());
        Assert.False(result.Metadata.ContainsKey("extensionVersion"));
        Assert.False(result.Metadata["latestVersionKnown"]!.GetValue<bool>());
        Assert.Equal(0, marketplaceClient.CallCount);
    }

    [Fact]
    public void Detect_IgnoresVersionsMarkedObsoleteByVsCode()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.2.3"));
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-1.5.0"));
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-2.0.0"));
        File.WriteAllText(
            Path.Combine(extensions.FullName, ".obsolete"),
            """{"microsoft-aspire.aspire-vscode-2.0.0":true}""");

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.5.0", detection.ExtensionVersion);
    }

    [Theory]
    [InlineData(".vscode")]
    [InlineData(".vscode-insiders")]
    [InlineData(".vscode-server")]
    [InlineData(".vscode-server-insiders")]
    public void Detect_FindsExtension_ViaEachDefaultExtensionsRoot(string rootFolder)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        // Exercise each default extensions root that GetExtensionDirectories composes (desktop
        // stable/Insiders and remote/server) rather than the VSCODE_EXTENSIONS override.
        Directory.CreateDirectory(Path.Combine(home.FullName, rootFolder, "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_IgnoresDefaultRoots_WhenVsCodeExtensionsOverrideSet()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var overrideDirectory = workspace.CreateDirectory("override");
        // The extension is present in the default desktop root but absent from the override directory.
        // VSCODE_EXTENSIONS makes VS Code load only the override, so detection must report it missing.
        Directory.CreateDirectory(Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = overrideDirectory.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_UsesPortableRoot_WhenPortableModeIsActive()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var portableDataFolder = workspace.CreateDirectory("code-portable-data");
        // Portable mode keeps every VS Code data folder next to the application, so the running
        // window loads "<portable data folder>/extensions" and never the home-directory default.
        Directory.CreateDirectory(
            Path.Combine(portableDataFolder.FullName, "extensions", "microsoft-aspire.aspire-vscode-1.5.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_PORTABLE"] = portableDataFolder.FullName,
            ["VSCODE_GIT_ASKPASS_MAIN"] = "/Volumes/VSCode-darwin-x64/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass-main.js"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("1.5.0", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_ReportsExtensionMissing_WhenPortableRootHasNoExtension()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var portableDataFolder = workspace.CreateDirectory("data");
        Directory.CreateDirectory(Path.Combine(portableDataFolder.FullName, "extensions"));
        // A leftover non-portable install must not be reported: the portable window would never
        // load it, so comparing it against the Marketplace would describe the wrong installation.
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-1.2.3"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_PORTABLE"] = portableDataFolder.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.VsCodeInstalled);
        Assert.False(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_PrefersVsCodeExtensionsOverride_OverPortableRoot()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var overrideDirectory = workspace.CreateDirectory("override");
        var portableDataFolder = workspace.CreateDirectory("data");
        // VS Code resolves the extension root as --extensions-dir, VSCODE_EXTENSIONS,
        // VSCODE_PORTABLE/extensions, then the home data folder, so the explicit override wins.
        Directory.CreateDirectory(
            Path.Combine(overrideDirectory.FullName, "microsoft-aspire.aspire-vscode-2.0.0"));
        Directory.CreateDirectory(
            Path.Combine(portableDataFolder.FullName, "extensions", "microsoft-aspire.aspire-vscode-1.5.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = overrideDirectory.FullName,
            ["VSCODE_PORTABLE"] = portableDataFolder.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("2.0.0", detection.ExtensionVersion);
    }

    [Fact]
    public void Detect_UsesHomeDefaultRoot_WhenNeitherOverrideNorPortableModeIsSet()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var portableDataFolder = workspace.CreateDirectory("data");
        // The portable data folder exists on disk but VSCODE_PORTABLE is unset, so VS Code is not
        // running in portable mode and detection must fall through to the home-directory defaults.
        Directory.CreateDirectory(
            Path.Combine(portableDataFolder.FullName, "extensions", "microsoft-aspire.aspire-vscode-1.5.0"));
        Directory.CreateDirectory(
            Path.Combine(home.FullName, ".vscode", "extensions", "microsoft-aspire.aspire-vscode-3.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_GIT_ASKPASS_MAIN"] = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass-main.js"
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home, _ => null);

        Assert.True(detection.ExtensionInstalled);
        Assert.Equal("3.0.0", detection.ExtensionVersion);
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
    public void Detect_MatchesExtensionFolder_CaseInsensitively()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "Microsoft-Aspire.Aspire-VSCode-9.9.9"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
        });

        var detection = VsCodeExtensionCheck.Detect(environment, home);

        Assert.True(detection.ExtensionInstalled);
    }

    [Fact]
    public void Detect_ReportsExtensionMissing_WhenOnlyUnrelatedExtensionsPresent()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var home = workspace.CreateDirectory("home");
        var extensions = workspace.CreateDirectory("extensions");
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "ms-dotnettools.csharp-2.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
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
        var extensions = workspace.CreateDirectory("extensions");
        // A different extension whose id begins with ours. Without the digit boundary the prefix match
        // would incorrectly treat this as the Aspire extension.
        Directory.CreateDirectory(Path.Combine(extensions.FullName, "microsoft-aspire.aspire-vscode-extras-1.0.0"));

        var environment = new TestEnvironment(new Dictionary<string, string?>
        {
            ["TERM_PROGRAM"] = "vscode",
            ["VSCODE_EXTENSIONS"] = extensions.FullName
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

    private static void WriteExtensionsIndex(
        DirectoryInfo extensionsDirectory,
        string relativeLocation,
        string version,
        bool? isPreReleaseVersion,
        string? source = "gallery")
    {
        var metadata = new Dictionary<string, object?>
        {
            ["targetPlatform"] = "undefined",
            ["hasPreReleaseVersion"] = isPreReleaseVersion == true,
            ["preRelease"] = isPreReleaseVersion == true
        };
        if (source is not null)
        {
            metadata["source"] = source;
        }
        if (isPreReleaseVersion is not null)
        {
            metadata["isPreReleaseVersion"] = isPreReleaseVersion;
        }

        var entries = new[]
        {
            new Dictionary<string, object?>
            {
                ["identifier"] = new Dictionary<string, object?>
                {
                    ["id"] = VsCodeExtensionCheck.ExtensionId,
                    ["uuid"] = "8e7be971-be8c-4936-8301-1ee17742ac25"
                },
                ["location"] = new Dictionary<string, object?>
                {
                    ["$mid"] = 1,
                    ["path"] = Path.Combine(extensionsDirectory.FullName, relativeLocation),
                    ["scheme"] = "file"
                },
                ["relativeLocation"] = relativeLocation,
                ["version"] = version,
                ["metadata"] = metadata
            }
        };

        File.WriteAllText(
            Path.Combine(extensionsDirectory.FullName, "extensions.json"),
            JsonSerializer.Serialize(entries));
    }
}
