// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class RustPublishImageResolverTests
{
    [Fact]
    public void UsesThePinnedDefaultVersionWhenNoToolchainIsDeclared()
    {
        using var crate = new TempCrateDirectory();

        Assert.Equal($"rust:{RustToolchainDetector.DefaultChannel}-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, "api"));
    }

    [Theory]
    [InlineData("1.89", "rust:1.89-alpine")]
    [InlineData("1.89.0", "rust:1.89.0-alpine")]
    // A version channel may carry a host suffix, which is not part of any image tag.
    [InlineData("1.89.0-x86_64-unknown-linux-gnu", "rust:1.89.0-alpine")]
    // There is no rust:stable-alpine tag; the unversioned rust:alpine tracks current stable.
    [InlineData("stable", "rust:alpine")]
    [InlineData("stable-x86_64-unknown-linux-gnu", "rust:alpine")]
    // Pre-release toolchains live in the rustlang/rust repository rather than the official rust one.
    [InlineData("nightly", "rustlang/rust:nightly-alpine")]
    [InlineData("nightly-2024-01-01", "rustlang/rust:nightly-2024-01-01-alpine")]
    public void MapsToolchainChannelsOntoRealImageTags(string channel, string expectedImage)
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain.toml", $"""
            [toolchain]
            channel = "{channel}"
            """);

        Assert.Equal(expectedImage, RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, "api"));
    }

    [Fact]
    public void ReadsTheLegacyToolchainFile()
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain", "1.85.0\n");

        Assert.Equal("rust:1.85.0-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, "api"));
    }

    [Fact]
    public void IgnoresCommentedOutChannels()
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain.toml", """
            [toolchain]
            # channel = "nightly"
            channel = '1.90'
            """);

        Assert.Equal("rust:1.90-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, "api"));
    }

    [Fact]
    public void BetaChannelFailsBecauseNoImagePublishesIt()
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain", "beta");

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, "api"));

        Assert.Equal(
            "The Rust app 'api' pins the 'beta' toolchain, but no official container image publishes the 'beta' channel. " +
            "Call WithDockerfileBaseImage(buildImage: \"...\") to supply an image that provides it, or pin an explicit version in rust-toolchain.toml.",
            exception.Message);
    }

    [Fact]
    public void DefaultsPairAMuslBuildImageWithAMuslRuntimeImage()
    {
        using var crate = new TempCrateDirectory();

        var images = RustPublishImageResolver.Resolve(null, null, crate.Path, target: null, "api");

        Assert.Equal($"rust:{RustToolchainDetector.DefaultChannel}-alpine", images.BuildImage);
        Assert.Equal(RustPublishImageResolver.DefaultRuntimeImage, images.RuntimeImage);
        Assert.True(images.BuildImageIsAlpine);
        Assert.True(images.RuntimeImageIsAlpine);
    }

    [Fact]
    public void MuslTargetIsAllowedWithTheDefaultImages()
    {
        using var crate = new TempCrateDirectory();

        var images = RustPublishImageResolver.Resolve(null, null, crate.Path, "aarch64-unknown-linux-musl", "api");

        Assert.Equal(RustPublishImageResolver.DefaultRuntimeImage, images.RuntimeImage);
    }

    [Fact]
    public void GnuTargetIsRejectedAgainstTheDefaultMuslImages()
    {
        using var crate = new TempCrateDirectory();

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustPublishImageResolver.Resolve(null, null, crate.Path, "x86_64-unknown-linux-gnu", "api"));

        Assert.Contains("produces a glibc binary", exception.Message);
        Assert.Contains("WithDockerfileBaseImage", exception.Message);
    }

    [Fact]
    public void GnuTargetIsAllowedWhenTheCallerSuppliesBothImages()
    {
        using var crate = new TempCrateDirectory();

        var images = RustPublishImageResolver.Resolve(
            "rust:1.89-bookworm",
            "debian:bookworm-slim",
            crate.Path,
            "x86_64-unknown-linux-gnu",
            "api");

        Assert.Equal("rust:1.89-bookworm", images.BuildImage);
        Assert.False(images.BuildImageIsAlpine);
        Assert.False(images.RuntimeImageIsAlpine);
    }

    [Fact]
    public void NonLinuxTargetIsRejected()
    {
        using var crate = new TempCrateDirectory();

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustPublishImageResolver.Resolve(null, null, crate.Path, "x86_64-pc-windows-msvc", "api"));

        Assert.Contains("the generated Dockerfile produces a Linux container image", exception.Message);
    }
}
