// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.Text.Json;
using Aspire.TestUtilities;
using Xunit;
using YamlDotNet.Serialization;

namespace Infrastructure.Tests.TestTriggerMap;

/// <summary>
/// Behavioral coverage for the file-matching logic in <c>.github/actions/check-changed-files/action.yml</c>,
/// the skip gate that decides whether a PR can skip the ENTIRE CI workflow. The sibling
/// <see cref="SelectTestsWorkflowTests"/> only pins that the action <em>mentions</em> <c>keep_unmatched</c>;
/// those presence assertions still pass if the action parsed the input but never consulted it -- in which
/// case an npm markdown template would match the <c>**.md</c> skip pattern and let a template-only PR
/// wrongly skip CI. This runs the action's actual bash against a real git diff so a regression in the
/// keep_unmatched precedence is caught.
/// </summary>
public sealed class CheckChangedFilesActionTests(ITestOutputHelper outputHelper) : IDisposable
{
    private readonly TemporaryWorkspace _workspace = TemporaryWorkspace.Create(outputHelper);

    public void Dispose() => _workspace.Dispose();

    [Fact]
    [RequiresTools(["bash", "git", "jq"])]
    public async Task KeepUnmatchedForcesNpmTemplateToRequireCiWhileOrdinaryMarkdownSkips()
    {
        // The skip gate lists **.md, so ALL files below match it on their own -- only keep_unmatched
        // distinguishes them. An ordinary doc must stay matched (skippable), while the npm packaging
        // templates must be forced unmatched (requires CI) even though they are also .md files.
        const string ordinaryMarkdown = "docs/notes.md";
        const string npmTemplate = "eng/scripts/pack-cli-npm-package.CHANGELOG.md";
        // A template that does not exist yet: the carve-out is a glob, so a future template is covered
        // the moment it is added, without editing this test or the workflow.
        const string futureNpmTemplate = "eng/scripts/pack-cli-npm-package.FUTURE.md";
        const string patternsFile = "eng/github-ci/skip-patterns.txt";

        // Read the REAL keep_unmatched value out of .github/workflows/ci.yml rather than restating it.
        // A copy here would keep passing after the workflow's carve-out was narrowed or deleted, which
        // is precisely the regression this test exists to catch.
        var keepUnmatched = ReadKeepUnmatchedFromCiWorkflow();

        Git("init", "-q", "-b", "main");
        Git("config", "user.email", "test@example.com");
        Git("config", "user.name", "Test");
        Git("config", "commit.gpgsign", "false");

        WriteWorkspaceFile(patternsFile, "**.md\n");
        Git("add", "-A");
        Git("commit", "-q", "-m", "base");
        var baseSha = Git("rev-parse", "HEAD");

        WriteWorkspaceFile(ordinaryMarkdown, "notes\n");
        WriteWorkspaceFile(npmTemplate, "changelog\n");
        WriteWorkspaceFile(futureNpmTemplate, "future\n");
        Git("add", "-A");
        Git("commit", "-q", "-m", "head");
        var headSha = Git("rev-parse", "HEAD");

        var outputs = await RunCheckChangedFilesAsync(patternsFile, keepUnmatched, baseSha, headSha);

        // The gate must not report "only skippable files changed": the templates require CI.
        Assert.Equal("false", outputs.OnlyChanged);
        // git diff --name-only sorts alphabetically, so docs/ precedes eng/, and CHANGELOG precedes FUTURE.
        Assert.Equal([ordinaryMarkdown, npmTemplate, futureNpmTemplate], outputs.ChangedFiles);
        Assert.Equal([ordinaryMarkdown], outputs.MatchedFiles);
        Assert.Equal([npmTemplate, futureNpmTemplate], outputs.UnmatchedFiles);
    }

    // Extracts the keep_unmatched input the real workflow passes to the check-changed-files action.
    private static string ReadKeepUnmatchedFromCiWorkflow()
    {
        var ciPath = Path.Combine(RepoRoot.Path, ".github", "workflows", "ci.yml");
        var deserializer = new DeserializerBuilder().Build();
        var root = deserializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(ciPath));

        var jobs = (Dictionary<object, object>)root["jobs"];
        foreach (var job in jobs.Values.Cast<Dictionary<object, object>>())
        {
            if (!job.TryGetValue("steps", out var stepsValue))
            {
                continue;
            }

            foreach (var step in ((List<object>)stepsValue).Cast<Dictionary<object, object>>())
            {
                if (step.TryGetValue("uses", out var uses)
                    && ((string)uses).Contains("check-changed-files", StringComparison.Ordinal)
                    && step.TryGetValue("with", out var with)
                    && ((Dictionary<object, object>)with).TryGetValue("keep_unmatched", out var keepUnmatched))
                {
                    // The workflow uses a block scalar, so the parsed value carries a trailing newline.
                    return ((string)keepUnmatched).TrimEnd('\n', '\r');
                }
            }
        }

        throw new InvalidOperationException("Could not find a check-changed-files step with keep_unmatched in .github/workflows/ci.yml.");
    }

    [Fact]
    [RequiresTools(["bash", "git", "jq"])]
    public async Task InputsTreatShellSyntaxAsLiteralGlobText()
    {
        const string hostileMarkdown = "eng/scripts/pack-cli-npm-package.$(printf should-not-execute)-`printf should-not-execute`.md";
        const string patternsFile = "eng/github-ci/skip-patterns-$(printf should-not-execute)-`printf should-not-execute`.txt";

        Git("init", "-q", "-b", "main");
        Git("config", "user.email", "test@example.com");
        Git("config", "user.name", "Test");
        Git("config", "commit.gpgsign", "false");

        WriteWorkspaceFile(patternsFile, "**.md\n");
        Git("add", "-A");
        Git("commit", "-q", "-m", "base");
        var baseSha = Git("rev-parse", "HEAD");

        WriteWorkspaceFile(hostileMarkdown, "changelog\n");
        Git("add", "-A");
        Git("commit", "-q", "-m", "head");
        var headSha = Git("rev-parse", "HEAD");

        var outputs = await RunCheckChangedFilesAsync(patternsFile, hostileMarkdown, baseSha, headSha);

        Assert.Equal("false", outputs.OnlyChanged);
        Assert.Equal([hostileMarkdown], outputs.ChangedFiles);
        Assert.Empty(outputs.MatchedFiles);
        Assert.Equal([hostileMarkdown], outputs.UnmatchedFiles);
    }

    private async Task<ActionOutputs> RunCheckChangedFilesAsync(string patternsFile, string keepUnmatched, string baseSha, string headSha)
    {
        // Substitute the GitHub Actions context expressions the composite step would otherwise receive
        // from the runner. Action inputs intentionally flow through process environment variables below
        // so shell syntax in those input values stays data, matching the real composite-step wiring.
        // Everything else -- glob_to_regex, the keep_unmatched precedence loop, the git diff -- is the
        // action's own code, executed verbatim.
        var script = ExtractCheckFilesScript()
            .Replace("${{ github.event_name }}", "pull_request", StringComparison.Ordinal)
            .Replace("${{ github.event.pull_request.base.sha }}", baseSha, StringComparison.Ordinal)
            .Replace("${{ github.event.pull_request.head.sha }}", headSha, StringComparison.Ordinal);

        var scriptPath = Path.Combine(_workspace.Path, "check-changed-files.sh");
        await File.WriteAllTextAsync(scriptPath, script);

        var outputPath = Path.Combine(_workspace.Path, "github_output.txt");
        await File.WriteAllTextAsync(outputPath, string.Empty);

        using var process = new Process();
        process.StartInfo.FileName = "bash";
        process.StartInfo.ArgumentList.Add(scriptPath);
        process.StartInfo.WorkingDirectory = _workspace.Path;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.Environment["GITHUB_WORKSPACE"] = _workspace.Path;
        process.StartInfo.Environment["GITHUB_OUTPUT"] = outputPath;
        process.StartInfo.Environment["CHECK_CHANGED_FILES_PATTERNS_FILE"] = patternsFile;
        process.StartInfo.Environment["CHECK_CHANGED_FILES_KEEP_UNMATCHED"] = keepUnmatched;

        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await process.WaitForExitAsync(cts.Token);
        var combined = await stdoutTask + await stderrTask;

        Assert.True(process.ExitCode == 0, $"check-changed-files action script failed.{Environment.NewLine}{combined}");

        return ParseOutputs(await File.ReadAllTextAsync(outputPath));
    }

    private static string ExtractCheckFilesScript()
    {
        var actionPath = Path.Combine(RepoRoot.Path, ".github", "actions", "check-changed-files", "action.yml");
        var deserializer = new DeserializerBuilder().Build();
        var root = deserializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(actionPath));

        var runs = (Dictionary<object, object>)root["runs"];
        var steps = (List<object>)runs["steps"];
        foreach (var step in steps.Cast<Dictionary<object, object>>())
        {
            if (step.TryGetValue("id", out var id) && (string)id == "check_files")
            {
                return (string)step["run"];
            }
        }

        throw new InvalidOperationException("Could not find the 'check_files' step in check-changed-files/action.yml.");
    }

    private static ActionOutputs ParseOutputs(string githubOutput)
    {
        // Step outputs are written as either `key=value` or a `key<<EOF ... EOF` heredoc block (used here
        // for the pretty-printed JSON arrays, which span several lines). Parse both forms into a flat map.
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var lines = githubOutput.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var heredoc = line.IndexOf("<<EOF", StringComparison.Ordinal);
            if (heredoc >= 0)
            {
                var key = line[..heredoc];
                var body = new List<string>();
                for (i++; i < lines.Length && lines[i] != "EOF"; i++)
                {
                    body.Add(lines[i]);
                }

                values[key] = string.Join('\n', body);
                continue;
            }

            var eq = line.IndexOf('=', StringComparison.Ordinal);
            if (eq > 0)
            {
                values[line[..eq]] = line[(eq + 1)..];
            }
        }

        return new ActionOutputs(
            values["only_changed"],
            ParseJsonArray(values["changed_files"]),
            ParseJsonArray(values["matched_files"]),
            ParseJsonArray(values["unmatched_files"]));
    }

    private static string[] ParseJsonArray(string json)
        => JsonSerializer.Deserialize<string[]>(json) ?? throw new InvalidOperationException($"Could not parse JSON array: {json}");

    private void WriteWorkspaceFile(string relativePath, string contents)
    {
        var fullPath = Path.Combine(_workspace.Path, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, contents);
    }

    private string Git(params string[] args) => GitCli.Run(_workspace.Path, args);

    private sealed record ActionOutputs(string OnlyChanged, string[] ChangedFiles, string[] MatchedFiles, string[] UnmatchedFiles);
}
