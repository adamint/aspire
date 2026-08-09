// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;
using System.Xml.Linq;
using Aspire.TestUtilities;
using Xunit;

namespace Infrastructure.Tests;

/// <summary>
/// Tests for .github/workflows/run-tests.yml.
/// </summary>
public sealed class RunTestsWorkflowTests
{
    private static readonly string s_workflowPath = Path.Combine(RepoRoot.Path, ".github", "workflows", "run-tests.yml");
    private static readonly string s_testsWorkflowPath = Path.Combine(RepoRoot.Path, ".github", "workflows", "tests.yml");
    private static readonly string s_specializedTestRunnerWorkflowPath = Path.Combine(RepoRoot.Path, ".github", "workflows", "specialized-test-runner.yml");
    private static readonly string s_specializedTestRunsheetBuilderTargetsPath = Path.Combine(RepoRoot.Path, "eng", "SpecializedTestRunsheetBuilderBase.targets");

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
    public void TestsWorkflowPassesAllowZeroTestsToRunTestsWorkflow()
    {
        string workflowText = File.ReadAllText(s_testsWorkflowPath);
        MatchCollection matches = Regex.Matches(
            workflowText,
            @"uses: \./\.github/workflows/run-tests\.yml(?<block>.*?)(?=\n  [a-zA-Z0-9_]+:|\z)",
            RegexOptions.Singleline);

        Assert.NotEmpty(matches);

        foreach (Match match in matches)
        {
            Assert.Contains("allowZeroTests: ${{ matrix.allowZeroTests || false }}", match.Groups["block"].Value);
        }
    }

    [Fact]
    public void SpecializedTestRunnerWorkflowAlwaysOptsIntoAllowZeroTests()
    {
        // eng/SpecializedTestRunsheetBuilderBase.targets generates every row this workflow's matrix
        // consumes (quarantined and outerloop tests), and it unconditionally appends
        // /p:IgnoreZeroTestResult=true to each row's command (asserted below). The generated rows
        // never carry an "allowZeroTests" key, so `matrix.tests.allowZeroTests || false` is a vacuous
        // expression that always evaluates to false: it silently re-enables the zero-test guard for
        // every specialized test run. The call site must instead pass allowZeroTests: true directly.
        string workflowText = File.ReadAllText(s_specializedTestRunnerWorkflowPath);
        MatchCollection matches = Regex.Matches(
            workflowText,
            @"uses: \./\.github/workflows/run-tests\.yml(?<block>.*?)(?=\n\n|\z)",
            RegexOptions.Singleline);

        Assert.Single(matches);
        string block = matches[0].Groups["block"].Value;

        Assert.Contains("allowZeroTests: true", block);
        Assert.DoesNotContain("matrix.tests.allowZeroTests", block);
    }

    [Fact]
    public void SpecializedTestRunsheetBuilderUnconditionallyIgnoresZeroTestResult()
    {
        // This asserts the invariant that SpecializedTestRunnerWorkflowAlwaysOptsIntoAllowZeroTests
        // relies on: every generated runsheet row's command tolerates zero tests via
        // /p:IgnoreZeroTestResult=true, with no surrounding Condition that could turn it off for some
        // rows. If this ever becomes conditional, the workflow's blanket allowZeroTests: true would
        // need to become row-specific too (see option (b) in the regression fix for PR #19177).
        var document = XDocument.Load(s_specializedTestRunsheetBuilderTargetsPath);
        var commandElements = document
            .Descendants()
            .Where(element =>
                element.Name.LocalName == "_TestCommand" &&
                element.Value.Contains("/p:IgnoreZeroTestResult=true", StringComparison.Ordinal))
            .ToArray();

        Assert.NotEmpty(commandElements);

        foreach (var commandElement in commandElements)
        {
            AssertNoUnexpectedCondition(commandElement);

            foreach (var ancestor in commandElement.Ancestors().TakeWhile(static ancestor => ancestor.Name.LocalName != "Target"))
            {
                AssertNoUnexpectedCondition(ancestor);
            }
        }
    }

    [Fact]
    public void TestsWorkflowValidateLockfileRegistriesStepsInvokeSharedScript()
    {
        // extension/scripts/validate-lockfile-registry.cjs used to be duplicated here as an inline
        // `node -e "... .includes(allow) ..."` one-liner, which reintroduced the same
        // origin-substring bypass documented on the shared script (a hostile host can smuggle the
        // feed string into its path/hostname-suffix/fragment, or downgrade to http://, and still
        // pass an `.includes()` check). Every "Validate lockfile registries" step in this workflow
        // must instead call the shared, hardened script so there is exactly one implementation to
        // keep correct.
        string workflowText = File.ReadAllText(s_testsWorkflowPath);
        string[] lines = workflowText.ReplaceLineEndings("\n").Split('\n');

        List<int> stepStarts = [];
        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i] == "      - name: Validate lockfile registries")
            {
                stepStarts.Add(i);
            }
        }

        Assert.NotEmpty(stepStarts);

        foreach (int stepStart in stepStarts)
        {
            string? runValue = null;
            for (int i = stepStart + 1; i < lines.Length && !lines[i].StartsWith("      - name:", StringComparison.Ordinal); i++)
            {
                string trimmed = lines[i].TrimStart();
                if (trimmed.StartsWith("run:", StringComparison.Ordinal))
                {
                    runValue = trimmed["run:".Length..].Trim();
                    break;
                }
            }

            Assert.Equal("node scripts/validate-lockfile-registry.cjs", runValue);
        }
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
    public async Task TestResultValidationAllowsTrxFilesContainNoTestsWhenOptedOut()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            File.WriteAllText(Path.Combine(scratchDirectory, "test-exit-code.txt"), "0");
            WriteTrxFile(Path.Combine(testResultsDirectory, "empty.trx"), totalTests: 0);

            using var command = new PowerShellCommand(CreateTestResultValidationScript(scratchDirectory, allowZeroTests: true), _output).WithTimeout(TimeSpan.FromMinutes(1));

            CommandResult result = await command.ExecuteAsync(scratchDirectory);

            result.EnsureSuccessful();
            Assert.Contains("No tests were reported in the .trx files, but allowZeroTests is true.", result.Output);
            Assert.Contains("0 test(s)", result.Output);
        }
        finally
        {
            DeleteScratchDirectory(scratchDirectory);
        }
    }

    [Fact]
    [RequiresTools(["pwsh"])]
    public async Task TestResultValidationFailsWhenTrxFileHasNoCountersEvenWhenZeroTestsAreAllowed()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            File.WriteAllText(Path.Combine(scratchDirectory, "test-exit-code.txt"), "0");
            WriteTrxFileWithoutCounters(Path.Combine(testResultsDirectory, "truncated.trx"));

            using var command = new PowerShellCommand(CreateTestResultValidationScript(scratchDirectory, allowZeroTests: true), _output).WithTimeout(TimeSpan.FromMinutes(1));

            CommandResult result = await command.ExecuteAsync(scratchDirectory);

            Assert.Equal(1, result.ExitCode);
            Assert.Contains("has no parseable ResultSummary/Counters/@total", result.Output);
        }
        finally
        {
            DeleteScratchDirectory(scratchDirectory);
        }
    }

    [Fact]
    [RequiresTools(["pwsh"])]
    public async Task TestResultValidationFailsWhenTrxFileHasUnparseableCountersEvenWhenZeroTestsAreAllowed()
    {
        string scratchDirectory = CreateScratchDirectory();
        try
        {
            string testResultsDirectory = Path.Combine(scratchDirectory, "testresults");
            Directory.CreateDirectory(testResultsDirectory);
            File.WriteAllText(Path.Combine(scratchDirectory, "test-exit-code.txt"), "0");
            WriteTrxFile(Path.Combine(testResultsDirectory, "bad-count.trx"), totalTests: "not-a-number");

            using var command = new PowerShellCommand(CreateTestResultValidationScript(scratchDirectory, allowZeroTests: true), _output).WithTimeout(TimeSpan.FromMinutes(1));

            CommandResult result = await command.ExecuteAsync(scratchDirectory);

            Assert.Equal(1, result.ExitCode);
            Assert.Contains("has an unparseable ResultSummary/Counters/@total value 'not-a-number'", result.Output);
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

    private static string CreateTestResultValidationScript(string scratchDirectory, bool allowZeroTests = false)
    {
        string scriptPath = Path.Combine(scratchDirectory, "validate-test-results.ps1");
        string script = ExtractPowerShellStep("Verify test results exist")
            .Replace("${{ github.workspace }}", "$Workspace", StringComparison.Ordinal)
            .Replace("'${{ inputs.ignoreTestFailures }}'", "'true'", StringComparison.Ordinal)
            .Replace("'${{ inputs.allowZeroTests }}'", $"'{allowZeroTests.ToString().ToLowerInvariant()}'", StringComparison.Ordinal);

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

    private static void AssertNoUnexpectedCondition(XElement element)
    {
        var condition = element.Attribute("Condition");
        if (condition is null)
        {
            return;
        }

        Assert.True(
            element.Name.LocalName == "PropertyGroup" &&
            string.Equals(condition.Value, " '$(_HasSpecializedTests)' == 'true' ", StringComparison.Ordinal),
            $"{element.Name.LocalName} must not have an unexpected Condition attribute here: {condition.Value}");
    }

    private static void WriteTrxFile(string path, int totalTests)
        => WriteTrxFile(path, totalTests.ToString());

    private static void WriteTrxFile(string path, string totalTests)
    {
        // MTP TRX files use the TeamTest namespace and report counts as:
        //   <TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
        //     <ResultSummary><Counters total="3" ... /></ResultSummary>
        // The workflow parser depends on that loosely structured XML shape, so keep the fixture representative.
        File.WriteAllText(
            path,
            $$"""
            <?xml version="1.0" encoding="utf-8"?>
            <TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
              <ResultSummary outcome="Completed">
                <Counters total="{{totalTests}}" executed="{{totalTests}}" passed="{{totalTests}}" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" />
              </ResultSummary>
            </TestRun>
            """);
    }

    private static void WriteTrxFileWithoutCounters(string path)
    {
        // Represents a truncated MTP TRX that has flushed the TestRun shell but not the counters yet:
        //   <TestRun><ResultSummary outcome="InProgress" /></TestRun>
        File.WriteAllText(
            path,
            """
            <?xml version="1.0" encoding="utf-8"?>
            <TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
              <ResultSummary outcome="InProgress" />
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
