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
