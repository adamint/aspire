// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Xunit;

namespace Infrastructure.Tests;

public sealed class CiWorkflowTests
{
    [Fact]
    public void RunTestsInstallsJavaForProjectsThatRequireIt()
    {
        var workflow = File.ReadAllText(Path.Combine(RepoRoot.Path, ".github", "workflows", "run-tests.yml"));
        var javaSetup = System.Text.RegularExpressions.Regex.Match(
            workflow,
            "(?ms)^      - name: Set up Java\\n(?<body>.*?)(?=^      - |\\z)");
        Assert.True(javaSetup.Success, "Could not find the Java setup step in run-tests.yml.");
        Assert.Contains("if: ${{ fromJson(inputs.properties).requiresJava == true }}", javaSetup.Value);
        Assert.Contains("uses: actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961 # v5.7.0", javaSetup.Value);
        Assert.Contains("distribution: temurin", javaSetup.Value);
        Assert.Contains("java-version: 21", javaSetup.Value);

        var properties = File.ReadAllText(Path.Combine(RepoRoot.Path, "eng", "testing", "CITestsProperties.props"));
        Assert.Contains("<CITestsProperty Include=\"requiresJava\" MSBuildProp=\"RequiresJava\"", properties);

        var javaTests = File.ReadAllText(Path.Combine(
            RepoRoot.Path,
            "tests",
            "Aspire.Hosting.CodeGeneration.Java.Tests",
            "Aspire.Hosting.CodeGeneration.Java.Tests.csproj"));
        Assert.Contains("<RequiresJava>true</RequiresJava>", javaTests);
    }

    [Fact]
    public void CiFailureTrackerCheckoutDoesNotPinMain()
    {
        var workflow = File.ReadAllText(Path.Combine(RepoRoot.Path, ".github", "workflows", "ci.yml"));
        var job = System.Text.RegularExpressions.Regex.Match(workflow, "(?ms)^  ci_failure_tracker:\\n(?<body>.*?)(?=^  [A-Za-z0-9_-]+:\\n|\\z)");
        Assert.True(job.Success, "Could not find the ci_failure_tracker job in ci.yml.");

        var checkout = System.Text.RegularExpressions.Regex.Match(job.Value, "(?ms)^      - uses: actions/checkout@.*?(?=^      - |\\z)");
        Assert.True(checkout.Success, "Could not find the ci_failure_tracker checkout step.");

        // Push CI also runs on release/**. Pinning this checkout to main makes the
        // tracker execute main's reporter instead of the workflow code from the branch
        // whose run is being evaluated.
        Assert.DoesNotContain("ref: main", checkout.Value);
    }
}
