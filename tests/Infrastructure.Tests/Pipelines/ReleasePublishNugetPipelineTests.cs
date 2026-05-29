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

        Assert.Contains("template: azure-pipelines/1ES.Official.Publish.yml@MicroBuildTemplate", pipeline);
        Assert.DoesNotContain("template: v1/1ES.Official.PipelineTemplate.yml@1ESPipelineTemplates", pipeline);
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
