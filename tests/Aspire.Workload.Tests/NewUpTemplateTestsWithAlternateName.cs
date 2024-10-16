// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Xunit;
using Xunit.Abstractions;

namespace Aspire.Workload.Tests;

public class NewUpTemplatesWithAlternateName(ITestOutputHelper testOutput) : WorkloadTestsBase(testOutput)
{
    public static TheoryData<string, TestSdk, TestTargetFramework, TestTemplatesInstall, string?> TestData(string templateName) => new()
        {
            // Previous Sdk
            { templateName, TestSdk.Previous, TestTargetFramework.Previous, TestTemplatesInstall.Net8, null },
            { templateName, TestSdk.Previous, TestTargetFramework.Previous, TestTemplatesInstall.Net9AndNet8, null },

            // Current SDK
            { templateName, TestSdk.Current, TestTargetFramework.Previous, TestTemplatesInstall.Net8, null },
            { templateName, TestSdk.Current, TestTargetFramework.Previous, TestTemplatesInstall.Net9AndNet8, null },

            { templateName, TestSdk.Current, TestTargetFramework.Current, TestTemplatesInstall.Net9, null },
            { templateName, TestSdk.Current, TestTargetFramework.Current, TestTemplatesInstall.Net9AndNet8, null },
        };

    [Theory]
    [MemberData(nameof(TestData), parameters: "aspire-9")]
    [MemberData(nameof(TestData), parameters: "aspire-starter-9")]
    public async Task CanNewStandaloneTemplatesWithAlternateName(string templateName, TestSdk sdk, TestTargetFramework tfm, TestTemplatesInstall templates, string? error)
    {
        var id = GetNewProjectId(prefix: $"new_build_{templateName}_{tfm.ToTFMString()}");

        var buildEnvToUse = sdk switch
        {
            TestSdk.Current => BuildEnvironment.ForCurrentSdkOnly,
            TestSdk.Previous => BuildEnvironment.ForPreviousSdkOnly,
            TestSdk.CurrentSdkAndPreviousRuntime => BuildEnvironment.ForCurrentSdkAndPreviousRuntime,
            _ => throw new ArgumentOutOfRangeException(nameof(sdk))
        };

        var templateHive = templates switch
        {
            TestTemplatesInstall.Net8 => TemplatesCustomHive.TemplatesHive,
            TestTemplatesInstall.Net9 => TemplatesCustomHive.TemplatesHive,
            TestTemplatesInstall.Net9AndNet8 => TemplatesCustomHive.TemplatesHive,
            _ => throw new ArgumentOutOfRangeException(nameof(templates))
        };

        await templateHive.EnsureInstalledAsync(buildEnvToUse);
        try
        {
            await using var project = await AspireProject.CreateNewTemplateProjectAsync(
                id,
                templateName,
                _testOutput,
                buildEnvironment: buildEnvToUse,
                targetFramework: tfm,
                customHiveForTemplates: templateHive.CustomHiveDirectory);

            Assert.True(error is null, $"Expected to throw an exception with message: {error}");
        }
        catch (ToolCommandException tce) when (error is not null)
        {
            Assert.NotNull(tce.Result);
            Assert.Contains(error, tce.Result.Value.Output);
        }
    }

    [Theory]
    // [MemberData(nameof(TestDataForNewAndBuildTemplateTests), parameters: "aspire-apphost")]
    // [MemberData(nameof(TestDataForNewAndBuildTemplateTests), parameters: "aspire-servicedefaults")]
    [MemberData(nameof(TestData), parameters: "aspire-mstest-9")]
    [MemberData(nameof(TestData), parameters: "aspire-nunit-9")]
    [MemberData(nameof(TestData), parameters: "aspire-xunit-9")]
    public async Task CanNewTestFrameworkTemplatesWithAlternateName(string templateName, TestSdk sdk, TestTargetFramework tfm, TestTemplatesInstall templates, string? error)
    {
        var id = GetNewProjectId(prefix: $"new_build_{templateName}_{tfm.ToTFMString()}");
        string config = "Debug";

        var buildEnvToUse = sdk switch
        {
            TestSdk.Current => BuildEnvironment.ForCurrentSdkOnly,
            TestSdk.Previous => BuildEnvironment.ForPreviousSdkOnly,
            TestSdk.CurrentSdkAndPreviousRuntime => BuildEnvironment.ForCurrentSdkAndPreviousRuntime,
            _ => throw new ArgumentOutOfRangeException(nameof(sdk))
        };

        var templateHive = templates switch
        {
            TestTemplatesInstall.Net8 => TemplatesCustomHive.TemplatesHive,
            TestTemplatesInstall.Net9 => TemplatesCustomHive.TemplatesHive,
            TestTemplatesInstall.Net9AndNet8 => TemplatesCustomHive.TemplatesHive,
            _ => throw new ArgumentOutOfRangeException(nameof(templates))
        };

        await templateHive.EnsureInstalledAsync(buildEnvToUse);
        try
        {
            await using var project = await AspireProject.CreateNewTemplateProjectAsync(
                id: id,
                template: "aspire-9",
                testOutput: _testOutput,
                buildEnvironment: buildEnvToUse,
                targetFramework: tfm,
                customHiveForTemplates: templateHive.CustomHiveDirectory);

            var testProjectDir = await CreateAndAddTestTemplateProjectAsync(
                                        id: id,
                                        testTemplateName: templateName,
                                        project: project,
                                        tfm: tfm,
                                        buildEnvironment: buildEnvToUse,
                                        templateHive: templateHive);

            await project.BuildAsync(extraBuildArgs: [$"-c {config}"], workingDirectory: testProjectDir);
        }
        catch (ToolCommandException tce) when (error is not null)
        {
            Assert.NotNull(tce.Result);
            Assert.Contains(error, tce.Result.Value.Output);
        }
    }
}
