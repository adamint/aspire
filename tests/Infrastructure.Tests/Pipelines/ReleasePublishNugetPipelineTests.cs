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
    public async Task HomebrewDryRunUsesOfflineValidationMode()
    {
        var pipeline = await ReadRepoFileAsync("eng/pipelines/release-publish-nuget.yml");
        var homebrewJobIndex = FindRequiredText(pipeline, "job: HomebrewValidateJob");
        var validateScriptIndex = FindRequiredText(pipeline, "\"$(Build.SourcesDirectory)/eng/homebrew/validate-cask-artifact.sh\"");
        var jobSetup = pipeline[homebrewJobIndex..validateScriptIndex];

        Assert.Contains("validation_mode=\"LiveRelease\"", jobSetup);
        Assert.Contains("'${{ parameters.DryRun }}' == 'true'", jobSetup);
        Assert.Contains("validation_mode=\"LiveArchives\"", jobSetup);

        var validateScriptCall = pipeline[validateScriptIndex..Math.Min(pipeline.Length, validateScriptIndex + 500)];
        Assert.Contains("--validation-mode \"$validation_mode\"", validateScriptCall);
        Assert.DoesNotContain("--validation-mode LiveRelease", validateScriptCall);
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
