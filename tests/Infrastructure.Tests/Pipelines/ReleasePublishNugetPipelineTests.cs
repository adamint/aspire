// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Xunit;

namespace Infrastructure.Tests;

public sealed class ReleasePublishNugetPipelineTests
{
    private readonly string _repoRoot = FindRepoRoot();

    [Fact]
    public async Task ValidatesNpmPublishPreconditionsBeforeNuGetPublish()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");
        var nuGetPublishIndex = FindRequiredText(pipeline, "task: 1ES.PublishNuget@1");

        AssertBefore(
            pipeline,
            "npm publishing is blocked for prerelease runs because the MicroBuild npm publish template does not yet expose a dist-tag parameter.",
            nuGetPublishIndex);

        AssertBefore(
            pipeline,
            "NpmPublishOwners must be set before publishing npm packages.",
            nuGetPublishIndex);

        AssertBefore(
            pipeline,
            "NpmPublishApprovers must be set before publishing npm packages.",
            nuGetPublishIndex);
    }

    [Fact]
    public async Task UsesEsrpPublishTemplateForNpmPublishing()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

        // The MicroBuild. prefix is REQUIRED for ESRP-based publishing — it wires the MicroBuild
        // signing/publish credential context so MicroBuild.Publish.yml and the auto-injected
        // MicroBuildAuthorizePublishPlugin task can authenticate against the
        // devdiv.pkgs.visualstudio.com/_packaging/MicroBuildToolset feed.
        // Plain `1ES.Official.Publish.yml@MicroBuildTemplate` (no `MicroBuild.` prefix) injects
        // the authorize task without supplying credentials, causing a 401.
        // See microsoft/vscode-azuretools, microsoft/pyright, microsoft/vscode-python-environments.
        Assert.Contains("template: azure-pipelines/MicroBuild.1ES.Official.Publish.yml@MicroBuildTemplate", pipeline);
        Assert.DoesNotContain("template: v1/1ES.Official.PipelineTemplate.yml@1ESPipelineTemplates", pipeline);
        // Guard against accidental regression to the plain template (without the MicroBuild. prefix)
        Assert.DoesNotContain("template: azure-pipelines/1ES.Official.Publish.yml@MicroBuildTemplate", pipeline);
    }

    [Fact]
    public async Task DefinesTeamNameVariableForMicroBuildTelemetry()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

        // MicroBuild.1ES.Official.Publish.yml@MicroBuildTemplate auto-injects MicroBuildCleanup@1
        // (displayName "🔩 MicroBuild Telemetry") at the END of every job. That task hard-requires
        // a variable literally named `TeamName`; if absent the task fails with:
        //   "The TeamName variable is required to use MicroBuild. Please update your definition
        //    variables to include your team name in the 'TeamName' variable."
        // common-variables.yml defines `_TeamName: dotnet-aspire` for Arcade conventions but
        // MicroBuild reads the unprefixed name, so we must declare TeamName at pipeline scope.
        Assert.Contains("- name: TeamName", pipeline);
        Assert.Contains("value: dotnet-aspire", pipeline);
    }

    [Fact]
    public async Task RoutesMicroBuildPublishAuthPluginToDncengFeedOrDisablesIt()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

        // MicroBuild.1ES.Official.Publish.yml@MicroBuildTemplate -> Stages/PublishStage.yml
        // -> Jobs/PublishJob.yml auto-injects MicroBuildAuthorizePublishPlugin@0 at the START
        // of every job. By default that task pulls its nuget package from
        // `devdiv.pkgs.visualstudio.com/_packaging/MicroBuildToolset`, which is NOT accessible
        // from the dnceng collection -> 401 -> stage fails before any customer step runs.
        // Two valid escapes from MicroBuildTemplate are required:
        //   1) templateContext.mb.publish.enabled: false  (for jobs that don't ESRP-publish)
        //   2) templateContext.mb.publish.feedSource: <dnceng mirror>  (for the publishing job)
        // Both must be present in this pipeline:
        //   - non-publishing jobs (PrepareJob, WinGetJob, DispatchGitHubTasksJob,
        //     PublishReleaseAssetsJob, HomebrewValidateJob) -> enabled: false
        //   - ReleaseJob (the only job that actually publishes) -> feedSource = dnceng mirror
        Assert.Contains("enabled: false", pipeline);
        Assert.Contains(
            "feedSource: 'https://pkgs.dev.azure.com/dnceng/_packaging/MicroBuildToolset/nuget/v3/index.json'",
            pipeline);
    }

    [Fact]
    public async Task UsesRequiredNpmEsrpOwnersAndApprover()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

        Assert.Contains("default: 'joperezr,ankj'", pipeline);
        Assert.Contains("default: 'adamratzman'", pipeline);
        Assert.Contains("$requiredNpmOwners = @('joperezr', 'ankj')", pipeline);
        Assert.Contains("$requiredNpmApprovers = @('adamratzman')", pipeline);
        Assert.Contains("NpmPublishOwners and NpmPublishApprovers must not contain the same alias(es)", pipeline);
    }

    [Fact]
    public async Task ValidatesPublishedNpmPackageFromRegistryAfterPublish()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");
        var pointerPublishIndex = FindRequiredText(pipeline, "folderLocation: '$(Pipeline.Workspace)\\npm\\pointer-package'");
        var registryValidationIndex = FindRequiredText(pipeline, "npm install -g --foreground-scripts=true --no-audit --no-fund --loglevel=warn --registry=https://registry.npmjs.org/ $packageSpec");
        var channelPromotionIndex = FindRequiredText(pipeline, "# ===== PROMOTE TO CHANNEL =====");
        var nodeToolIndex = FindRequiredText(pipeline, "task: NodeTool@0");
        var dryRunReachabilityIndex = FindRequiredText(pipeline, "Dry Run - Validate npm Registry Reachability");
        var pointerSkipIndex = FindRequiredText(pipeline, "SkipNpmPointerPublish");

        Assert.True(
            pointerPublishIndex < registryValidationIndex,
            "Expected registry validation to happen after the npm pointer package is published.");

        Assert.True(
            registryValidationIndex < channelPromotionIndex,
            "Expected registry validation to happen before channel promotion.");

        Assert.True(
            nodeToolIndex < registryValidationIndex,
            "Expected Node.js to be installed before registry validation uses npm.");

        Assert.True(
            dryRunReachabilityIndex < registryValidationIndex,
            "Expected dry-run registry reachability validation to exercise npm before the actual publish-only install smoke.");

        Assert.True(
            pointerSkipIndex < registryValidationIndex,
            "Expected pointer package publishing to be independently skippable so registry validation can be retried without republishing.");

        Assert.Contains("aspire --version output matched the published npm package version", pipeline);
        Assert.Contains("npm view $packageSpec version --registry=https://registry.npmjs.org/", pipeline);
        Assert.Contains("Registry validation will still install the selected source build's pointer package version from npm.", pipeline);
    }

    [Fact]
    public async Task PrepareNpmCliPackagesScriptIsBash32Compatible()
    {
        var template = await ReadRepoFileAsync("eng/pipelines/templates/prepare-npm-cli-packages.yml");

        // macOS AzDO runners execute bash@3 tasks with /bin/bash which is still
        // Bash 3.2 on every shipping macOS release. These constructs are Bash 4+
        // and silently break the install/uninstall smoke that gates the npm release.
        // See dry-run build 2987449 where `shopt: globstar: invalid shell option name`
        // killed `🟣Locate pointer and RID tarballs` on macOS.
        Assert.DoesNotContain("shopt -s globstar", template);
        Assert.DoesNotContain("mapfile ", template);
        Assert.DoesNotContain("readarray ", template);
        // declare -A (associative arrays) is also Bash 4+.
        Assert.DoesNotContain("declare -A", template);
    }

    [Fact]
    public async Task PrepareNpmCliPackagesScriptInstallsOfflineWithTimeout()
    {
        var template = await ReadRepoFileAsync("eng/pipelines/templates/prepare-npm-cli-packages.yml");

        // The pointer package declares every supported RID as an optionalDependency
        // pinned to the just-built version, which does not yet exist in the public
        // npm registry. Even with --omit=optional, npm still resolves optional dep
        // metadata while building the dep tree. In 1ES Linux/Windows pools the
        // registry call is blackholed by network isolation rules and each of 7
        // lookups burns the full fetch-timeout — that's the 9-minute pointer install
        // hang observed in dry-run build 2987581. Pair --omit=optional with --offline
        // (no registry traffic at all) and cap any accidental fetch with a short
        // --fetch-timeout. NPM_CONFIG_CACHE points at a fresh empty directory so
        // --offline cannot reuse a poisoned cache.
        Assert.Contains("--offline", template);
        Assert.Contains("--fetch-timeout=", template);
    }

    [Fact]
    public async Task PointerPublishPreflightsRidPackagesAreOnRegistry()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

        // The pointer pins each RID package via optionalDependencies. If any
        // RID dep is missing on npm at pointer-publish time (operator set
        // SkipNpmRidPublish=true; only some RIDs landed in an earlier attempt;
        // ESRP partial failure), end-user `npm install -g @microsoft/aspire-cli`
        // succeeds but the launcher throws "The Aspire CLI native package '…'
        // was not installed" on first invocation. The post-publish smoke only
        // covers the publish-pool's own RID, so missing other-RID tarballs
        // reach customers invisibly without this preflight.
        Assert.Contains("Verify npm RID Packages Present Before Pointer Publish", pipeline);
        Assert.Contains("Refusing to publish pointer package", pipeline);

        var preflightIndex = pipeline.IndexOf("Verify npm RID Packages Present Before Pointer Publish", StringComparison.Ordinal);
        Assert.True(preflightIndex > 0);

        // The preflight must precede the actual pointer publish so it can gate
        // submission.
        var pointerPublishIndex = pipeline.IndexOf(
            "folderLocation: '$(Pipeline.Workspace)\\npm\\pointer-package'",
            StringComparison.Ordinal);
        Assert.True(pointerPublishIndex > preflightIndex,
            "Preflight RID-check must appear before the pointer-publish step.");
    }

    [Fact]
    public async Task PostPublishSmokeRejectsEmptyAspireVersionOutput()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");

        // Without an explicit empty-stdout check, `@(...)` wraps an empty
        // version line into an empty array and PowerShell's `-notmatch`
        // against an empty array silently returns an empty array (falsy),
        // letting an `aspire --version` that exits 0 with no output slip past
        // the version-pattern check. Assert the explicit guard is present.
        Assert.Contains("$versionLine.Count -eq 0", pipeline);
        Assert.Contains("produced no output.", pipeline);
    }

    private static void AssertBefore(string contents, string text, int boundaryIndex)
    {
        var textIndex = FindRequiredText(contents, text);

        Assert.True(
            textIndex < boundaryIndex,
            $"Expected '{text}' to appear before 'task: 1ES.PublishNuget@1'.");
    }

    private static int FindRequiredText(string contents, string text)
    {
        var index = contents.IndexOf(text, StringComparison.Ordinal);

        Assert.True(index >= 0, $"Expected to find '{text}'.");

        return index;
    }

    private Task<string> ReadRepoFileAsync(string relativePath)
        => File.ReadAllTextAsync(Path.Combine(_repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));

    private static string FindRepoRoot()
    {
        string? current = AppContext.BaseDirectory;

        while (current is not null)
        {
            if (File.Exists(Path.Combine(current, "Aspire.slnx")))
            {
                return current;
            }

            current = Directory.GetParent(current)?.FullName;
        }

        throw new DirectoryNotFoundException("Could not find repository root containing Aspire.slnx");
    }
}
