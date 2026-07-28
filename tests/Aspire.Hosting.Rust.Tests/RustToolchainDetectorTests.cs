// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class RustToolchainDetectorTests
{
    [Fact]
    public void DetectReturnsNullWhenNoToolchainFileExists()
    {
        using var dir = new TempCrateDirectory();

        Assert.Null(RustToolchainDetector.Detect(dir.Path));
    }

    [Fact]
    public void DetectReadsChannelFromToolchainToml()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain.toml", """
            [toolchain]
            channel = "1.89.0"
            """);

        Assert.Equal("1.89.0", RustToolchainDetector.Detect(dir.Path));
    }

    [Fact]
    public void DetectIgnoresCommentedChannel()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain.toml", """
            [toolchain]
            # channel = "nightly"
            channel = "1.89"
            """);

        Assert.Equal("1.89", RustToolchainDetector.Detect(dir.Path));
    }

    [Fact]
    public void DetectReadsSingleQuotedChannel()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain.toml", """
            [toolchain]
            channel = 'nightly-2024-01-01'
            """);

        Assert.Equal("nightly-2024-01-01", RustToolchainDetector.Detect(dir.Path));
    }

    [Fact]
    public void DetectReadsLegacyToolchainFile()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain", "  1.75.0\n");

        Assert.Equal("1.75.0", RustToolchainDetector.Detect(dir.Path));
    }

    [Fact]
    public void DetectPrefersToolchainTomlOverLegacyFile()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain.toml", """
            [toolchain]
            channel = "1.89"
            """);
        dir.Write("rust-toolchain", "1.75.0");

        Assert.Equal("1.89", RustToolchainDetector.Detect(dir.Path));
    }

    [Theory]
    [InlineData("stable", "stable")]
    [InlineData("STABLE", "stable")]
    [InlineData("beta", "beta")]
    [InlineData("nightly", "nightly")]
    [InlineData("nightly-2024-01-01", "nightly")]
    [InlineData("stable-x86_64-unknown-linux-gnu", "stable")]
    public void GetChannelNameReturnsNamedChannel(string channel, string expected)
    {
        Assert.Equal(expected, RustToolchainDetector.GetChannelName(channel));
        Assert.True(RustToolchainDetector.IsNamedChannel(channel));
    }

    [Theory]
    [InlineData("1.89")]
    [InlineData("1.89.0")]
    public void GetChannelNameReturnsNullForVersions(string channel)
    {
        Assert.Null(RustToolchainDetector.GetChannelName(channel));
        Assert.False(RustToolchainDetector.IsNamedChannel(channel));
    }
}
