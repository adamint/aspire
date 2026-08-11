// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.ComponentModel;
using System.Diagnostics;
using Xunit;

namespace QuarantineTools.Tests;

public class RepoRootTests : IDisposable
{
    private static readonly TimeSpan s_processTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan s_processCleanupTimeout = TimeSpan.FromSeconds(5);
    private readonly DirectoryInfo _scratch;

    public RepoRootTests()
    {
        _scratch = new DirectoryInfo(Canonicalize(Directory.CreateTempSubdirectory("quarantine-reporoot-").FullName));
    }

    public void Dispose()
    {
        try
        {
            _scratch.Delete(recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best-effort cleanup must not replace the test failure that left files behind.
        }
    }

    [Fact]
    public async Task FindRepoRoot_FromLinkedWorktree_ReturnsWorktreeRoot_NotOuterCheckout()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");
        var (_, nested) = await CreateOuterRepoWithNestedWorktreeAsync();

        var resolved = await Program.FindRepoRootAsync(nested, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(nested), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_FromSubdirectoryOfLinkedWorktree_ReturnsWorktreeRoot()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");
        var (_, nested) = await CreateOuterRepoWithNestedWorktreeAsync();
        var deep = Directory.CreateDirectory(Path.Combine(nested, "tests", "Sample", "deep")).FullName;

        var resolved = await Program.FindRepoRootAsync(deep, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(nested), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_FromMainCheckout_ReturnsMainCheckoutRoot()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");
        var (outer, _) = await CreateOuterRepoWithNestedWorktreeAsync();

        var resolved = await Program.FindRepoRootAsync(outer, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(outer), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_OutsideAnyRepository_ReturnsNull()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");
        var loose = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "loose")).FullName;

        var resolved = await Program.FindRepoRootAsync(loose, TestContext.Current.CancellationToken);

        Assert.Null(resolved);
    }

    [Fact]
    public async Task FindRepoRoot_PreservesTrailingSpacesInRepositoryPath()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows APIs trim trailing spaces from directory names.");
        var repository = CreateTreeWithSampleTest("repo ");
        await RunGitAsync(repository, "init", "-q", ".");

        var resolved = await Program.FindRepoRootAsync(repository, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(repository), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_WhenCallerCancels_PropagatesCancellation()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");
        var (_, nested) = await CreateOuterRepoWithNestedWorktreeAsync();
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Program.FindRepoRootAsync(nested, cancelled.Token));
    }

    [Fact]
    public void FindRepoRootByMarker_StopsAtGitDirectory()
    {
        var root = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "marker-repo")).FullName;
        Directory.CreateDirectory(Path.Combine(root, ".git"));
        var deep = Directory.CreateDirectory(Path.Combine(root, "tools", "deep")).FullName;

        Assert.Equal(root, Program.FindRepoRootByMarker(deep));
    }

    [Fact]
    public void FindRepoRootByMarker_ReturnsNullWithoutMarker()
    {
        var loose = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "markerless", "deep")).FullName;

        Assert.Null(Program.FindRepoRootByMarker(loose));
    }

    [Theory]
    [InlineData("a/b", "a/b", true)]
    [InlineData("a", "a/b/c", true)]
    [InlineData("a/b/c", "a", false)]
    [InlineData("a/bb", "a/b", false)]
    public void IsSameOrAncestorDirectory_MatchesWholePathSegments(string ancestor, string directory, bool expected)
    {
        var ancestorPath = Path.GetFullPath(Path.Combine(_scratch.FullName, ancestor.Replace('/', Path.DirectorySeparatorChar)));
        var directoryPath = Path.GetFullPath(Path.Combine(_scratch.FullName, directory.Replace('/', Path.DirectorySeparatorChar)));

        Assert.Equal(expected, Program.IsSameOrAncestorDirectory(ancestorPath, directoryPath));
    }

    [Fact]
    public void WrongTreeError_IsNullWhenRootMatchesNearestMarker()
    {
        var root = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "safe-repo")).FullName;
        Directory.CreateDirectory(Path.Combine(root, ".git"));
        var inside = Directory.CreateDirectory(Path.Combine(root, "tools")).FullName;

        Assert.Null(Program.TryGetWrongTreeError(root, inside));
    }

    [Fact]
    public void WrongTreeError_NamesResolvedRootAndCurrentDirectory()
    {
        var root = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "repo-a")).FullName;
        var elsewhere = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "repo-b", "tools")).FullName;

        var error = Program.TryGetWrongTreeError(root, elsewhere);

        Assert.NotNull(error);
        Assert.Contains(root, error, StringComparison.Ordinal);
        Assert.Contains(elsewhere, error, StringComparison.Ordinal);
    }

    [Fact]
    public void WrongTreeError_IsNullWhenPathsDifferOnlyBySymlink()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Creating symlinks requires elevation on Windows.");
        var realBase = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "real-base")).FullName;
        var realRepo = Directory.CreateDirectory(Path.Combine(realBase, "repo")).FullName;
        Directory.CreateDirectory(Path.Combine(realRepo, ".git"));
        Directory.CreateDirectory(Path.Combine(realRepo, "tools"));
        Directory.CreateSymbolicLink(Path.Combine(_scratch.FullName, "base-link"), "real-base");
        Directory.CreateSymbolicLink(Path.Combine(_scratch.FullName, "repo-link"), Path.Combine("base-link", "repo"));
        var viaLink = Path.Combine(_scratch.FullName, "repo-link", "tools");

        Assert.False(Program.IsSameOrAncestorDirectory(realRepo, viaLink));
        Assert.Null(Program.TryGetWrongTreeError(realRepo, viaLink));
    }

    [Theory]
    [InlineData("path\n", "path")]
    [InlineData("path\r", "path")]
    [InlineData("path", "path")]
    public void TrimSingleLineTerminator_RemovesAtMostOneTerminator(string value, string expected)
    {
        Assert.Equal(expected, Program.TrimSingleLineTerminator(value));
    }

    [Fact]
    public async Task Tool_FromNestedLinkedWorktree_UsesGitRootAndEditsNestedTree()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");

        var (outer, nested) = await CreateOuterRepoWithNestedWorktreeAsync();
        var outerSample = Path.Combine(outer, "tests", "Sample", "SampleTests.cs");
        var nestedSample = Path.Combine(nested, "tests", "Sample", "SampleTests.cs");
        var traceFile = Path.Combine(_scratch.FullName, "worktree-git-trace");
        var outerBefore = await File.ReadAllTextAsync(outerSample, TestContext.Current.CancellationToken);

        var result = await RunToolAsync(nested, new Dictionary<string, string>
        {
            ["GIT_TRACE2"] = traceFile,
        });

        Assert.Equal(0, result.ExitCode);
        Assert.True(File.Exists(traceFile), "The tool should ask git to resolve the linked worktree root.");
        Assert.Equal(outerBefore, await File.ReadAllTextAsync(outerSample, TestContext.Current.CancellationToken));
        Assert.Contains(
            "QuarantinedTest",
            await File.ReadAllTextAsync(nestedSample, TestContext.Current.CancellationToken),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Tool_RefusesGitRootOutsideCurrentTree_WithExitCode4()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");

        var metadataRepository = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "metadata")).FullName;
        var unrelatedRoot = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "unrelated")).FullName;
        var callerRoot = CreateTreeWithSampleTest("caller");
        await RunGitAsync(metadataRepository, "init", "-q", ".");
        await RunGitAsync(metadataRepository, "config", "core.worktree", ToGitPath(unrelatedRoot));
        File.WriteAllText(
            Path.Combine(callerRoot, ".git"),
            $"gitdir: {ToGitPath(Path.Combine(metadataRepository, ".git"))}{Environment.NewLine}");
        var callerSample = Path.Combine(callerRoot, "tests", "Sample", "SampleTests.cs");
        var before = await File.ReadAllTextAsync(callerSample, TestContext.Current.CancellationToken);

        var result = await RunToolAsync(callerRoot, environment: null);

        Assert.Equal(Program.ExitCodeWrongTree, result.ExitCode);
        Assert.Contains(unrelatedRoot, result.StandardError, StringComparison.Ordinal);
        Assert.Contains(callerRoot, result.StandardError, StringComparison.Ordinal);
        Assert.Equal(before, await File.ReadAllTextAsync(callerSample, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Tool_RefusesGitRootAtOuterAncestor_WithExitCode4()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");

        var outerRoot = CreateTreeWithSampleTest("outer-ancestor");
        var callerRoot = CreateTreeWithSampleTest(Path.Combine("outer-ancestor", "caller"));
        var metadataRepository = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "outer-ancestor-metadata")).FullName;
        await RunGitAsync(metadataRepository, "init", "-q", ".");
        await RunGitAsync(metadataRepository, "config", "core.worktree", ToGitPath(outerRoot));
        File.WriteAllText(
            Path.Combine(callerRoot, ".git"),
            $"gitdir: {ToGitPath(Path.Combine(metadataRepository, ".git"))}{Environment.NewLine}");
        var outerSample = Path.Combine(outerRoot, "tests", "Sample", "SampleTests.cs");
        var callerSample = Path.Combine(callerRoot, "tests", "Sample", "SampleTests.cs");
        var outerBefore = await File.ReadAllTextAsync(outerSample, TestContext.Current.CancellationToken);
        var callerBefore = await File.ReadAllTextAsync(callerSample, TestContext.Current.CancellationToken);

        var result = await RunToolAsync(callerRoot, environment: null);

        Assert.Equal(Program.ExitCodeWrongTree, result.ExitCode);
        Assert.Contains(outerRoot, result.StandardError, StringComparison.Ordinal);
        Assert.Contains(callerRoot, result.StandardError, StringComparison.Ordinal);
        Assert.Equal(outerBefore, await File.ReadAllTextAsync(outerSample, TestContext.Current.CancellationToken));
        Assert.Equal(callerBefore, await File.ReadAllTextAsync(callerSample, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Tool_WhenGitCommandFails_InvokesGitThenFallsBackToMarker()
    {
        Assert.SkipUnless(await IsGitAvailableAsync(), "git is not available on PATH");

        var callerRoot = CreateTreeWithSampleTest("broken-gitfile");
        File.WriteAllText(
            Path.Combine(callerRoot, ".git"),
            $"gitdir: {ToGitPath(Path.Combine(_scratch.FullName, "missing", ".git"))}{Environment.NewLine}");
        var traceFile = Path.Combine(_scratch.FullName, "failed-git-trace");
        var callerSample = Path.Combine(callerRoot, "tests", "Sample", "SampleTests.cs");

        var result = await RunToolAsync(callerRoot, new Dictionary<string, string>
        {
            ["GIT_TRACE2"] = traceFile,
        });

        Assert.Equal(0, result.ExitCode);
        Assert.True(File.Exists(traceFile), "The fallback should run only after the git probe fails.");
        Assert.Contains(
            "QuarantinedTest",
            await File.ReadAllTextAsync(callerSample, TestContext.Current.CancellationToken),
            StringComparison.Ordinal);
    }

    [Fact]
    public void FindRepoRoot_TreatsLinkedWorktreeGitFileAsRepositoryMarker()
    {
        var worktreeRoot = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "worktree"));
        File.WriteAllText(Path.Combine(worktreeRoot.FullName, ".git"), "gitdir: ../repo/.git/worktrees/worktree");
        var startDirectory = Directory.CreateDirectory(Path.Combine(worktreeRoot.FullName, "tests", "Sample"));

        var resolved = Program.FindRepoRootByMarker(startDirectory.FullName);

        Assert.Equal(worktreeRoot.FullName, resolved);
    }

    private string CreateTreeWithSampleTest(string name)
    {
        var root = Directory.CreateDirectory(Path.Combine(_scratch.FullName, name)).FullName;
        Directory.CreateDirectory(Path.Combine(root, "tests", "Sample"));
        File.WriteAllText(
            Path.Combine(root, "tests", "Sample", "SampleTests.cs"),
            "namespace N; public class C { public void M() { } }");
        return root;
    }

    private async Task<(string Outer, string Nested)> CreateOuterRepoWithNestedWorktreeAsync()
    {
        var outer = CreateTreeWithSampleTest("outer");
        await RunGitAsync(outer, "init", "-q", "-b", "main", ".");
        await RunGitAsync(outer, "config", "user.email", "test@example.com");
        await RunGitAsync(outer, "config", "user.name", "test");
        await RunGitAsync(outer, "config", "commit.gpgsign", "false");
        await RunGitAsync(outer, "add", "-A");
        await RunGitAsync(outer, "commit", "-q", "-m", "seed");

        var nested = Path.Combine(outer, "nested");
        await RunGitAsync(outer, "worktree", "add", "-q", "-f", nested, "-b", "nested-branch", "HEAD");

        Assert.True(File.Exists(Path.Combine(nested, ".git")), "linked worktree should have a .git file");
        Assert.True(Directory.Exists(Path.Combine(outer, ".git")), "main checkout should have a .git directory");
        return (outer, nested);
    }

    private static async Task<bool> IsGitAvailableAsync()
    {
        try
        {
            var startInfo = CreateProcessStartInfo("git", Directory.GetCurrentDirectory());
            startInfo.ArgumentList.Add("--version");
            var result = await RunProcessAsync(startInfo, TestContext.Current.CancellationToken);
            return result.ExitCode == 0;
        }
        catch (Win32Exception)
        {
            return false;
        }
    }

    private async Task RunGitAsync(string workingDirectory, params string[] arguments)
    {
        var startInfo = CreateProcessStartInfo("git", workingDirectory);
        SetIsolatedGitConfiguration(startInfo);

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        var result = await RunProcessAsync(startInfo, TestContext.Current.CancellationToken);
        Assert.True(
            result.ExitCode == 0,
            $"git {string.Join(' ', arguments)} failed:{Environment.NewLine}{result.StandardError}{result.StandardOutput}");
    }

    private async Task<ProcessResult> RunToolAsync(string workingDirectory, IDictionary<string, string>? environment)
    {
        var toolAssembly = typeof(Program).Assembly.Location;
        var appHost = Path.ChangeExtension(toolAssembly, OperatingSystem.IsWindows() ? ".exe" : null);
        var useAppHost = File.Exists(appHost);
        var startInfo = CreateProcessStartInfo(useAppHost ? appHost : "dotnet", workingDirectory);

        if (!useAppHost)
        {
            startInfo.ArgumentList.Add(toolAssembly);
        }

        startInfo.ArgumentList.Add("-q");
        startInfo.ArgumentList.Add("-i");
        startInfo.ArgumentList.Add("https://github.com/microsoft/aspire/issues/1234");
        startInfo.ArgumentList.Add("N.C.M");
        SetIsolatedGitConfiguration(startInfo);

        if (environment is not null)
        {
            foreach (var (key, value) in environment)
            {
                startInfo.Environment[key] = value;
            }
        }

        return await RunProcessAsync(startInfo, TestContext.Current.CancellationToken);
    }

    private static ProcessStartInfo CreateProcessStartInfo(string fileName, string workingDirectory)
        => new(fileName)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

    private void SetIsolatedGitConfiguration(ProcessStartInfo startInfo)
    {
        startInfo.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        startInfo.Environment["GIT_CONFIG_GLOBAL"] = Path.Combine(_scratch.FullName, "missing-global-git-config");
    }

    private static async Task<ProcessResult> RunProcessAsync(ProcessStartInfo startInfo, CancellationToken cancellationToken)
    {
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException($"Failed to start {startInfo.FileName}.");
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(s_processTimeout);
        var standardOutputTask = process.StandardOutput.ReadToEndAsync(timeoutSource.Token);
        var standardErrorTask = process.StandardError.ReadToEndAsync(timeoutSource.Token);

        try
        {
            await process.WaitForExitAsync(timeoutSource.Token);
            await Task.WhenAll(standardOutputTask, standardErrorTask).WaitAsync(timeoutSource.Token);
        }
        catch (OperationCanceledException)
        {
            await TerminateProcessAsync(process);
            cancellationToken.ThrowIfCancellationRequested();
            throw new TimeoutException($"{startInfo.FileName} did not exit within {s_processTimeout}.");
        }

        return new ProcessResult(process.ExitCode, standardOutputTask.Result, standardErrorTask.Result);
    }

    private static async Task TerminateProcessAsync(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException or Win32Exception)
        {
            // The process exited between the check and kill, or the platform cannot kill its tree.
        }

        using var cleanupSource = new CancellationTokenSource(s_processCleanupTimeout);
        try
        {
            await process.WaitForExitAsync(cleanupSource.Token);
        }
        catch (OperationCanceledException) when (cleanupSource.IsCancellationRequested)
        {
            // Disposal closes the remaining handles; cleanup is bounded so a broken child cannot hang tests.
        }
    }

    private static string Canonicalize(string path)
    {
        var info = new DirectoryInfo(Path.GetFullPath(path));
        if (info.Parent is null)
        {
            return Path.TrimEndingDirectorySeparator(info.FullName);
        }

        if (info.ResolveLinkTarget(returnFinalTarget: true) is { } target)
        {
            return Canonicalize(target.FullName);
        }

        return Path.Combine(Canonicalize(info.Parent.FullName), info.Name);
    }

    private static string ToGitPath(string path)
        => path.Replace(Path.DirectorySeparatorChar, '/');

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);
}
