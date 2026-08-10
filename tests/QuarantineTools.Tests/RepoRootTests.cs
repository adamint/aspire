// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Xunit;

namespace QuarantineTools.Tests;

public class RepoRootTests
{
    [Fact]
    public void FindRepoRoot_TreatsLinkedWorktreeGitFileAsRepositoryMarker()
    {
        var tempDirectory = Directory.CreateTempSubdirectory("quarantine-reporoot-");

        try
        {
            var worktreeRoot = Directory.CreateDirectory(Path.Combine(tempDirectory.FullName, "worktree"));
            File.WriteAllText(Path.Combine(worktreeRoot.FullName, ".git"), "gitdir: ../repo/.git/worktrees/worktree");
            var startDirectory = Directory.CreateDirectory(Path.Combine(worktreeRoot.FullName, "tests", "Sample"));

            var resolved = Program.FindRepoRoot(startDirectory.FullName);

            Assert.Equal(worktreeRoot.FullName, resolved);
        }
        finally
        {
            tempDirectory.Delete(recursive: true);
        }
    }
}
