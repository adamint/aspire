// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;
using Aspire.TestUtilities;
using Xunit;

namespace Infrastructure.Tests;

/// <summary>
/// Tests for .github/workflows/run-tests.yml.
/// </summary>
public sealed class RunTestsWorkflowTests
{
    private static readonly string s_workflowPath = Path.Combine(RepoRoot.Path, ".github", "workflows", "run-tests.yml");

    private readonly ITestOutputHelper _output;

    public RunTestsWorkflowTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    [RequiresTools(["pwsh"])]
    public async Task HangDumpDetectorsMatchMtpHangDumpFilesAndIgnoreOtherDumps()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            Directory.CreateDirectory(Path.Combine(testResultsDirectory, "nested"));

            File.WriteAllText(Path.Combine(testResultsDirectory, "dotnet_6079_hang.dmp"), "");
            File.WriteAllText(Path.Combine(testResultsDirectory, "dotnet_6079_hang.log"), "");
            File.WriteAllText(Path.Combine(testResultsDirectory, "dotnet_6079_crash.dmp"), "");
            File.WriteAllText(Path.Combine(testResultsDirectory, "unrelated.dmp"), "");
            File.WriteAllText(Path.Combine(testResultsDirectory, "not-a-dump-hangdump.txt"), "");
            File.WriteAllText(Path.Combine(testResultsDirectory, "nested", "docker_6110_hang.dmp"), "");

            string scriptPath = CreateDetectorScript(scratchDirectory);

            foreach (string filter in GetHangDumpDetectorFilters())
            {
                using var command = new PowerShellCommand(scriptPath, _output).WithTimeout(TimeSpan.FromMinutes(1));

                CommandResult result = await command.ExecuteAsync(testResultsDirectory, filter);

                result.EnsureSuccessful();
                Assert.Equal(
                    [
                        "docker_6110_hang.dmp",
                        "dotnet_6079_hang.dmp"
                    ],
                    GetOutputLines(result));
            }
        }
        finally
        {
            DeleteScratchDirectory(scratchDirectory);
        }
    }

    [Fact]
    [RequiresTools(["pwsh"])]
    public async Task HangDumpDetectorsReportCleanWhenDirectoryIsEmpty()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            string scriptPath = CreateDetectorScript(scratchDirectory);

            foreach (string filter in GetHangDumpDetectorFilters())
            {
                using var command = new PowerShellCommand(scriptPath, _output).WithTimeout(TimeSpan.FromMinutes(1));

                CommandResult result = await command.ExecuteAsync(testResultsDirectory, filter);

                result.EnsureSuccessful();
                Assert.Empty(GetOutputLines(result));
            }
        }
        finally
        {
            DeleteScratchDirectory(scratchDirectory);
        }
    }

    [Fact]
    public void TestResultValidationRunsAfterSuccessfulTestRunnerSteps()
    {
        string condition = ExtractStepProperty("Verify test results exist", "if");
        string expectedCondition =
            "${{ always() && " +
            "(steps.run-nuget-tests-unix.outcome == 'success' || " +
            "steps.run-nuget-tests-windows.outcome == 'success' || " +
            "steps.run-tests-unix.outcome == 'success' || " +
            "steps.run-tests-windows.outcome == 'success') }}";

        Assert.Equal(expectedCondition, condition);
    }

    [Fact]
    [RequiresTools(["pwsh"])]
    public async Task TestResultValidationFailsWhenTrxFilesContainNoTests()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            File.WriteAllText(Path.Combine(scratchDirectory, "test-exit-code.txt"), "0");
            WriteTrxFile(Path.Combine(testResultsDirectory, "empty.trx"), totalTests: 0);

            using var command = new PowerShellCommand(CreateTestResultValidationScript(scratchDirectory), _output).WithTimeout(TimeSpan.FromMinutes(1));

            CommandResult result = await command.ExecuteAsync(scratchDirectory);

            Assert.Equal(1, result.ExitCode);
            Assert.Contains("No tests were reported in the .trx files.", result.Output);
        }
        finally
        {
            DeleteScratchDirectory(scratchDirectory);
        }
    }

    [Fact]
    [RequiresTools(["pwsh"])]
    public async Task TestResultValidationPassesWhenTrxFilesContainTests()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            File.WriteAllText(Path.Combine(scratchDirectory, "test-exit-code.txt"), "0");
            WriteTrxFile(Path.Combine(testResultsDirectory, "tests.trx"), totalTests: 3);

            using var command = new PowerShellCommand(CreateTestResultValidationScript(scratchDirectory), _output).WithTimeout(TimeSpan.FromMinutes(1));

            CommandResult result = await command.ExecuteAsync(scratchDirectory);

            result.EnsureSuccessful();
            Assert.Contains("3 test(s)", result.Output);
        }
        finally
        {
            DeleteScratchDirectory(scratchDirectory);
        }
    }

    private static string[] GetHangDumpDetectorFilters()
    {
        string workflowText = File.ReadAllText(s_workflowPath);
        MatchCollection matches = Regex.Matches(
            workflowText,
            @"\$(?:hasHangDumps|hangDumpFiles)\s*=\s*Get-ChildItem\s+-Path\s+[^\r\n]+?\s+-Filter\s+(?<filter>\S+)\s+-Recurse");

        Assert.Equal(2, matches.Count);

        return matches
            .Select(match => match.Groups["filter"].Value)
            .ToArray();
    }

    private static string CreateDetectorScript(string scratchDirectory)
    {
        string scriptPath = Path.Combine(scratchDirectory, "detect-hang-dumps.ps1");
        File.WriteAllText(
            scriptPath,
            """
            param(
              [Parameter(Mandatory=$true)][string]$TestResultsDir,
              [Parameter(Mandatory=$true)][string]$Filter
            )

            Get-ChildItem -Path $TestResultsDir -Filter $Filter -Recurse -ErrorAction SilentlyContinue |
              Sort-Object -Property Name |
              ForEach-Object { $_.Name }
            """);

        return scriptPath;
    }

    private static string CreateTestResultValidationScript(string scratchDirectory)
    {
        string scriptPath = Path.Combine(scratchDirectory, "validate-test-results.ps1");
        string script = ExtractPowerShellStep("Verify test results exist")
            .Replace("${{ github.workspace }}", "$Workspace", StringComparison.Ordinal)
            .Replace("'${{ inputs.ignoreTestFailures }}'", "'true'", StringComparison.Ordinal)
            .Replace("'${{ inputs.allowZeroTests }}'", "'false'", StringComparison.Ordinal);

        File.WriteAllText(
            scriptPath,
            $$"""
            param(
              [Parameter(Mandatory=$true)][string]$Workspace
            )

            {{script}}
            """);

        return scriptPath;
    }

    private static string ExtractPowerShellStep(string stepName)
    {
        string workflowText = File.ReadAllText(s_workflowPath);
        string[] lines = workflowText.ReplaceLineEndings("\n").Split('\n');
        int stepStart = Array.FindIndex(lines, line => line == $"      - name: {stepName}");
        Assert.True(stepStart >= 0, $"Could not find step '{stepName}' in {s_workflowPath}.");

        int runStart = Array.FindIndex(lines, stepStart, line => line == "        run: |");
        Assert.True(runStart >= 0, $"Could not find PowerShell run block for step '{stepName}' in {s_workflowPath}.");

        var scriptLines = new List<string>();
        for (int i = runStart + 1; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.StartsWith("      - name:", StringComparison.Ordinal))
            {
                break;
            }

            Assert.True(line.Length == 0 || line.StartsWith("          ", StringComparison.Ordinal), $"Unexpected line indentation in step '{stepName}': {line}");
            scriptLines.Add(line.Length >= 10 ? line[10..] : line);
        }

        Assert.NotEmpty(scriptLines);
        return string.Join(Environment.NewLine, scriptLines);
    }

    private static string ExtractStepProperty(string stepName, string propertyName)
    {
        string workflowText = File.ReadAllText(s_workflowPath);
        string[] lines = workflowText.ReplaceLineEndings("\n").Split('\n');
        int stepStart = Array.FindIndex(lines, line => line == $"      - name: {stepName}");
        Assert.True(stepStart >= 0, $"Could not find step '{stepName}' in {s_workflowPath}.");

        for (int i = stepStart + 1; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.StartsWith("      - name:", StringComparison.Ordinal))
            {
                break;
            }

            string prefix = $"        {propertyName}: ";
            if (line.StartsWith(prefix, StringComparison.Ordinal))
            {
                return line[prefix.Length..];
            }
        }

        Assert.Fail($"Could not find property '{propertyName}' for step '{stepName}' in {s_workflowPath}.");
        return "";
    }

    private static void WriteTrxFile(string path, int totalTests)
    {
        File.WriteAllText(
            path,
            $$"""
            <?xml version="1.0" encoding="utf-8"?>
            <TestRun>
              <ResultSummary outcome="Completed">
                <Counters total="{{totalTests}}" executed="{{totalTests}}" passed="{{totalTests}}" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" />
              </ResultSummary>
            </TestRun>
            """);
    }

    private static string[] GetOutputLines(CommandResult result)
        => result.Output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

    private static string CreateScratchDirectory()
    {
        string scratchRoot = Path.Combine(RepoRoot.Path, "artifacts", "tmp", nameof(RunTestsWorkflowTests));
        Directory.CreateDirectory(scratchRoot);

        string scratchDirectory = Path.Combine(scratchRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratchDirectory);

        return scratchDirectory;
    }

    private static void DeleteScratchDirectory(string scratchDirectory)
    {
        if (Directory.Exists(scratchDirectory))
        {
            Directory.Delete(scratchDirectory, recursive: true);
        }
    }
}
