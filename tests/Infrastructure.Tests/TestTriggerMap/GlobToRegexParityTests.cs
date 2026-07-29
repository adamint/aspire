// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.Text;
using Aspire.SelectTests;
using Aspire.TestUtilities;
using Xunit;
using YamlDotNet.Serialization;

namespace Infrastructure.Tests.TestTriggerMap;

/// <summary>
/// Pins the two independent implementations of the CI skip-gate glob syntax to each other:
/// <c>glob_to_regex</c> in <c>.github/actions/check-changed-files/action.yml</c> (bash, decides whether a
/// PR skips the ENTIRE CI workflow) and its port in <c>tools/SelectTests/ChangedFileFilter.cs</c> (C#,
/// decides which changed files the test selector drops before selection).
///
/// Both read the SAME patterns file, so the selector's "excluded" set must equal the gate's "skip" set.
/// Nothing enforced that: the port is only documented as verbatim, and a change to one side's escape set
/// alone still compiled and still passed every other test, because no pattern in the file currently
/// contains a character the two treat differently. This runs both engines over a corpus that exercises
/// every regex metacharacter and asserts an identical match matrix, so the next divergence fails here
/// instead of silently desynchronizing the gate from the selector.
/// </summary>
public sealed class GlobToRegexParityTests(ITestOutputHelper outputHelper) : IDisposable
{
    private readonly TemporaryWorkspace _workspace = TemporaryWorkspace.Create(outputHelper);

    public void Dispose() => _workspace.Dispose();

    // Every metacharacter either engine escapes, plus the glob operators and the real carve-out pattern.
    // A pattern is only meaningful here if some path can distinguish "escaped" from "not escaped": for
    // `docs/a{2}.md`, an unescaped `{2}` is an ERE quantifier that fails to match its own filename.
    private static readonly string[] s_patterns =
    [
        "**.md",
        "eng/scripts/pack-cli-npm-package.*.md",
        "src/**/*.cs",
        "localhive.*",
        "docs/a{2}.md",
        "docs/v{1,3}.txt",
        "docs/x^y.md",
        "docs/p$q.md",
        "docs/c(1).md",
        "docs/d[x].md",
        "docs/e+f.md",
        "docs/g?h.md",
        "docs/i|j.md",
        "docs/k.l.md",
    ];

    // Plain strings, never written to disk: several are illegal filenames on Windows, and the matching
    // under test is pure string matching in both engines.
    private static readonly string[] s_paths =
    [
        "docs/notes.md",
        "eng/scripts/pack-cli-npm-package.CHANGELOG.md",
        "eng/scripts/pack-cli-npm-package.pointer.README.md",
        "eng/scripts/pack-cli-npm-package.FUTURE.md",
        "eng/scripts/pack-cli-npm-package.ps1",
        "eng/scripts/other.md",
        "src/Aspire.Cli/Program.cs",
        "localhive.ps1",
        "docs/a{2}.md",
        "docs/aa.md",
        "docs/v{1,3}.txt",
        "docs/vvv.txt",
        "docs/x^y.md",
        "docs/p$q.md",
        "docs/c(1).md",
        "docs/d[x].md",
        "docs/dx.md",
        "docs/e+f.md",
        "docs/g?h.md",
        "docs/gh.md",
        "docs/i|j.md",
        "docs/kXlYmd",
    ];

    [Fact]
    [RequiresTools(["bash"])]
    public async Task ActionBashAndChangedFileFilterAgreeOnEveryPattern()
    {
        var bashMatrix = await RunActionGlobMatcherAsync();
        var portMatrix = RunChangedFileFilter();

        // Compare per pattern so a failure names the exact glob that diverged rather than a wall of bits.
        for (var i = 0; i < s_patterns.Length; i++)
        {
            Assert.True(
                string.Equals(bashMatrix[i].Bits, portMatrix[i], StringComparison.Ordinal),
                $"""
                glob_to_regex parity broken for pattern: {s_patterns[i]}
                  action.yml (bash) compiled : {bashMatrix[i].Regex}
                  action.yml (bash) matches  : {bashMatrix[i].Bits}
                  ChangedFileFilter matches  : {portMatrix[i]}
                  paths (in order)           : {string.Join(", ", s_paths)}

                The C# port in tools/SelectTests/ChangedFileFilter.cs must use the same escape set as
                glob_to_regex in .github/actions/check-changed-files/action.yml. Update both together.
                """);
        }
    }

    // Runs the action's own glob_to_regex, then applies the result exactly as the action does
    // (`[[ "$file" =~ $pattern ]]`, bash ERE), producing one row of '1'/'0' per pattern.
    private async Task<List<(string Regex, string Bits)>> RunActionGlobMatcherAsync()
    {
        var patternsPath = Path.Combine(_workspace.Path, "patterns.txt");
        var pathsPath = Path.Combine(_workspace.Path, "paths.txt");
        await File.WriteAllTextAsync(patternsPath, string.Join('\n', s_patterns) + "\n");
        await File.WriteAllTextAsync(pathsPath, string.Join('\n', s_paths) + "\n");

        var driver = $$"""
            set -u
            {{ExtractGlobToRegexFunction()}}

            while IFS= read -r pattern; do
              [ -z "$pattern" ] && continue
              regex="$(glob_to_regex "$pattern")"
              bits=""
              while IFS= read -r path; do
                [ -z "$path" ] && continue
                if [[ "$path" =~ $regex ]] 2>/dev/null; then bits="${bits}1"; else bits="${bits}0"; fi
              done < "$2"
              printf '%s\t%s\n' "$bits" "$regex"
            done < "$1"
            """;

        var driverPath = Path.Combine(_workspace.Path, "glob-parity.sh");
        await File.WriteAllTextAsync(driverPath, driver);

        using var process = new Process();
        process.StartInfo.FileName = "bash";
        process.StartInfo.ArgumentList.Add(driverPath);
        process.StartInfo.ArgumentList.Add(patternsPath);
        process.StartInfo.ArgumentList.Add(pathsPath);
        process.StartInfo.WorkingDirectory = _workspace.Path;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;
        process.StartInfo.UseShellExecute = false;

        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        await process.WaitForExitAsync(cts.Token);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        Assert.True(process.ExitCode == 0, $"glob parity driver failed.{Environment.NewLine}{stdout}{stderr}");

        var rows = stdout.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line =>
            {
                var tab = line.IndexOf('\t', StringComparison.Ordinal);
                return (Regex: line[(tab + 1)..], Bits: line[..tab]);
            })
            .ToList();

        Assert.Equal(s_patterns.Length, rows.Count);
        return rows;
    }

    // Same matrix through the C# port. One pattern per filter so a broad pattern (**.md) cannot mask a
    // divergence in a narrow one.
    private List<string> RunChangedFileFilter()
    {
        var matrix = new List<string>(s_patterns.Length);
        for (var i = 0; i < s_patterns.Length; i++)
        {
            var relativePatternsFile = $"single-pattern-{i}.txt";
            File.WriteAllText(Path.Combine(_workspace.Path, relativePatternsFile), s_patterns[i] + "\n");

            var filter = ChangedFileFilter.Create(
                _workspace.Path,
                new Aspire.SelectTests.PrefilterConfig { PatternsFile = relativePatternsFile });

            var bits = new StringBuilder(s_paths.Length);
            foreach (var path in s_paths)
            {
                bits.Append(filter.IsExcluded(path) ? '1' : '0');
            }

            matrix.Add(bits.ToString());
        }

        return matrix;
    }

    // Slices glob_to_regex out of the action's check_files step. The YAML block scalar is already
    // dedented by the parser, so the function opens at column 0 and closes at the first bare '}'.
    private static string ExtractGlobToRegexFunction()
    {
        var actionPath = Path.Combine(RepoRoot.Path, ".github", "actions", "check-changed-files", "action.yml");
        var deserializer = new DeserializerBuilder().Build();
        var root = deserializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(actionPath));

        var runs = (Dictionary<object, object>)root["runs"];
        var steps = (List<object>)runs["steps"];
        var script = steps.Cast<Dictionary<object, object>>()
            .Where(step => step.TryGetValue("id", out var id) && (string)id == "check_files")
            .Select(step => (string)step["run"])
            .FirstOrDefault()
            ?? throw new InvalidOperationException("Could not find the 'check_files' step in check-changed-files/action.yml.");

        var lines = script.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var start = Array.FindIndex(lines, line => line.StartsWith("glob_to_regex()", StringComparison.Ordinal));
        Assert.True(start >= 0, "Could not find glob_to_regex() in the check_files step.");

        var end = Array.FindIndex(lines, start, line => line == "}");
        Assert.True(end > start, "Could not find the end of glob_to_regex() in the check_files step.");

        return string.Join('\n', lines[start..(end + 1)]);
    }
}
