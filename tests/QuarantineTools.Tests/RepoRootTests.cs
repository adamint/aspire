// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using Xunit;

namespace QuarantineTools.Tests;

/// <summary>
/// Covers repository-root resolution. The tool rewrites source files in bulk, so resolving the wrong
/// root silently edits a different checkout instead of failing.
/// </summary>
public class RepoRootTests : IDisposable
{
    private readonly DirectoryInfo _scratch;

    public RepoRootTests()
    {
        // Canonicalize up front so every derived path is already symlink-free. On macOS the temp
        // directory lives under /var, which is a symlink to /private/var, and git reports the resolved
        // form - comparing the two without this would fail for reasons unrelated to root resolution.
        _scratch = new DirectoryInfo(Canonicalize(Directory.CreateTempSubdirectory("quarantine-reporoot-").FullName));
    }

    public void Dispose()
    {
        // The nested worktree must be unregistered before the outer repo is deleted, otherwise git
        // leaves administrative files behind under .git/worktrees.
        var outer = Path.Combine(_scratch.FullName, "outer");
        if (Directory.Exists(Path.Combine(outer, "nested")))
        {
            RunGit(outer, "worktree", "remove", "--force", "nested");
        }

        try
        {
            _scratch.Delete(recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup; a leftover temp directory must not fail the test run.
        }
    }

    [Fact]
    public async Task FindRepoRoot_FromLinkedWorktree_ReturnsWorktreeRoot_NotOuterCheckout()
    {
        var (_, nested) = CreateOuterRepoWithNestedWorktree();

        var resolved = await Program.FindRepoRootAsync(nested, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(nested), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_FromSubdirectoryOfLinkedWorktree_ReturnsWorktreeRoot()
    {
        var (_, nested) = CreateOuterRepoWithNestedWorktree();
        var deep = Directory.CreateDirectory(Path.Combine(nested, "tests", "Sample", "deep")).FullName;

        var resolved = await Program.FindRepoRootAsync(deep, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(nested), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_FromMainCheckout_ReturnsMainCheckoutRoot()
    {
        var (outer, _) = CreateOuterRepoWithNestedWorktree();

        var resolved = await Program.FindRepoRootAsync(outer, TestContext.Current.CancellationToken);

        Assert.Equal(Path.TrimEndingDirectorySeparator(outer), Path.TrimEndingDirectorySeparator(resolved!));
    }

    [Fact]
    public async Task FindRepoRoot_OutsideAnyRepository_ReturnsNull()
    {
        var loose = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "loose")).FullName;

        var resolved = await Program.FindRepoRootAsync(loose, TestContext.Current.CancellationToken);

        Assert.Null(resolved);
    }

    [Theory]
    [InlineData("/a/b", "/a/b", true)]
    [InlineData("/a", "/a/b/c", true)]
    [InlineData("/a/b/c", "/a", false)]
    [InlineData("/a/bb", "/a/b", false)]
    public void IsSameOrAncestorDirectory_MatchesOnPathSegments(string ancestor, string directory, bool expected)
    {
        // Windows cannot resolve rooted POSIX paths, so anchor the cases under the scratch directory.
        var a = Path.GetFullPath(Path.Combine(_scratch.FullName, ancestor.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
        var d = Path.GetFullPath(Path.Combine(_scratch.FullName, directory.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));

        Assert.Equal(expected, Program.IsSameOrAncestorDirectory(a, d));
    }

    /// <summary>
    /// Creates a main checkout with a linked worktree nested inside it. The nesting is the point: the
    /// worktree's <c>.git</c> is a file, so a probe that only looks for a <c>.git</c> directory walks
    /// past it and lands on the outer checkout.
    /// </summary>
    private (string Outer, string Nested) CreateOuterRepoWithNestedWorktree()
    {
        var outer = Directory.CreateDirectory(Path.Combine(_scratch.FullName, "outer")).FullName;
        Directory.CreateDirectory(Path.Combine(outer, "tests", "Sample"));
        File.WriteAllText(Path.Combine(outer, "tests", "Sample", "SampleTests.cs"), "namespace N; public class C { public void M() { } }");

        RunGit(outer, "init", "-q", "-b", "main", ".");
        RunGit(outer, "config", "user.email", "test@example.com");
        RunGit(outer, "config", "user.name", "test");
        RunGit(outer, "config", "commit.gpgsign", "false");
        RunGit(outer, "add", "-A");
        RunGit(outer, "commit", "-q", "-m", "seed");

        var nested = Path.Combine(outer, "nested");
        RunGit(outer, "worktree", "add", "-q", "-f", nested, "-b", "nested-branch", "HEAD");

        Assert.True(File.Exists(Path.Combine(nested, ".git")), "linked worktree should have a .git file, not a directory");
        Assert.True(Directory.Exists(Path.Combine(outer, ".git")), "main checkout should have a .git directory");

        return (outer, nested);
    }

    private static void RunGit(string workingDirectory, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, $"git {string.Join(' ', arguments)} failed: {stderr.Result}{stdout.Result}");
    }

    /// <summary>
    /// Resolves every symlinked component of <paramref name="path"/>. <see cref="FileSystemInfo.ResolveLinkTarget"/>
    /// only resolves the final component, so ancestors are walked explicitly.
    /// </summary>
    private static string Canonicalize(string path)
    {
        var info = new DirectoryInfo(Path.GetFullPath(path));

        if (info.ResolveLinkTarget(returnFinalTarget: true) is { } target)
        {
            return Canonicalize(target.FullName);
        }

        return info.Parent is { } parent
            ? Path.Combine(Canonicalize(parent.FullName), info.Name)
            : Path.TrimEndingDirectorySeparator(info.FullName);
    }
}
