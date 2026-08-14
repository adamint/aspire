// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Packaging;
using Aspire.Cli.Utils;

namespace Aspire.Cli.Tests.Packaging;

public class PackageSourceOverrideMappingsTests(ITestOutputHelper outputHelper)
{
    [Fact]
    [PlatformSpecific(TestPlatforms.AnyUnix)]
    public void ResolveForWorkingDirectory_RelativePathContainingColon_ResolvesAgainstWorkingDirectory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var result = PackageSourceOverrideMappings.ResolveForWorkingDirectory("relative:feed", workspace.WorkspaceRoot);

        Assert.Equal(Path.Combine(workspace.WorkspaceRoot.FullName, "relative:feed"), result);
    }

    [Theory]
    [InlineData("C:/feed")]
    [InlineData("a:/feed")]
    [PlatformSpecific(TestPlatforms.AnyUnix)]
    public void ResolveForWorkingDirectory_DosShapedRelativePath_ResolvesAgainstWorkingDirectory(string source)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var result = PackageSourceOverrideMappings.ResolveForWorkingDirectory(source, workspace.WorkspaceRoot);

        Assert.Equal(Path.Combine(workspace.WorkspaceRoot.FullName, source), result);
    }

    [Fact]
    public void ResolveForWorkingDirectory_FileUri_ReturnsUnchanged()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        const string source = "file:///tmp/feed";

        var result = PackageSourceOverrideMappings.ResolveForWorkingDirectory(source, workspace.WorkspaceRoot);

        Assert.Equal(source, result);
    }

    [Fact]
    [PlatformSpecific(TestPlatforms.Windows)]
    public void ResolveForWorkingDirectory_WindowsFullyQualifiedPath_ReturnsUnchanged()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        const string source = @"C:\feed";

        var result = PackageSourceOverrideMappings.ResolveForWorkingDirectory(source, workspace.WorkspaceRoot);

        Assert.Equal(source, result);
    }

    [Theory]
    [InlineData("file:///local/feed", false)]
    [InlineData("file://localhost/local/feed", false)]
    [InlineData("file://example.test/share", true)]
    [InlineData("file:///%5C%5Cexample.test%5Cshare", true)]
    [InlineData("file:///%2F%2Fexample.test/share", true)]
    [InlineData("file:///%2Fattacker.example/share", true)]
    [InlineData("file:///%2F%3F%2FUNC/example.test/share", true)]
    [InlineData("file:///%3F%3F/UNC/attacker/share", true)]
    [InlineData("file:///%3F%3F%5CUNC%5Cattacker%5Cshare", true)]
    [InlineData("file:///C:/feed", false)]
    [InlineData("file:///usr/feed", false)]
    public void IsRemoteFileSystemSource_FileUri_ReturnsExpectedResult(string source, bool expected)
    {
        Assert.Equal(expected, PackageSourceOverrideMappings.IsRemoteFileSystemSource(source));
    }

    [Theory]
    [InlineData(@"C:\feed", false)]
    [InlineData("/usr/feed", false)]
    [InlineData(@"\\example.test\share", true)]
    [InlineData("//example.test/share", true)]
    [InlineData(@"/\attacker\share", true)]
    [InlineData(@"\/attacker/share", true)]
    [InlineData(@"\??\UNC\attacker\share", true)]
    [InlineData("/??/UNC/attacker/share", true)]
    [InlineData(@"\??/UNC\attacker\share", true)]
    [InlineData(@"/??\UNC/attacker/share", true)]
    public void IsRemoteFileSystemSource_LocalPath_ReturnsExpectedResult(string source, bool expected)
    {
        Assert.Equal(expected, PackageSourceOverrideMappings.IsRemoteFileSystemSource(source));
    }

    [Fact]
    public void GetFirstReparsePoint_RelativeSourceRootIsLink_ReturnsLink()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var target = workspace.CreateDirectory("target");
        var link = Path.Combine(workspace.WorkspaceRoot.FullName, "feed");
        ReparsePoint.CreateOrReplace(link, target.FullName);

        var result = PackageSourceOverrideMappings.GetFirstReparsePoint("feed", workspace.WorkspaceRoot);

        Assert.Equal(link, result);
    }

    [Fact]
    public void GetFirstReparsePoint_RelativeSourceContainsLink_ReturnsFirstLink()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var target = workspace.CreateDirectory("target");
        Directory.CreateDirectory(Path.Combine(target.FullName, "subdir"));
        var feed = workspace.CreateDirectory("feed");
        var link = Path.Combine(feed.FullName, "link");
        ReparsePoint.CreateOrReplace(link, target.FullName);

        var result = PackageSourceOverrideMappings.GetFirstReparsePoint(
            Path.Combine("feed", "link", "subdir"),
            workspace.WorkspaceRoot);

        Assert.Equal(link, result);
    }
}
