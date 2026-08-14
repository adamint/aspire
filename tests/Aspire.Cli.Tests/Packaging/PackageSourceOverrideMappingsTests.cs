// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Packaging;

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
    public void IsRemoteFileSystemSource_FileUri_ReturnsExpectedResult(string source, bool expected)
    {
        Assert.Equal(expected, PackageSourceOverrideMappings.IsRemoteFileSystemSource(source));
    }

    [Theory]
    [InlineData(@"C:\feed", false)]
    [InlineData(@"\\example.test\share", true)]
    [PlatformSpecific(TestPlatforms.Windows)]
    public void IsRemoteFileSystemSource_WindowsPath_ReturnsExpectedResult(string source, bool expected)
    {
        Assert.Equal(expected, PackageSourceOverrideMappings.IsRemoteFileSystemSource(source));
    }
}
