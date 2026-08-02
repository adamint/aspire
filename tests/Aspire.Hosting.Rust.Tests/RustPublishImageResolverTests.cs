// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class RustPublishImageResolverTests
{
    [Fact]
    public void UsesThePinnedDefaultVersionWhenNoToolchainIsDeclared()
    {
        using var crate = new TempCrateDirectory();

        Assert.Equal($"rust:{RustToolchainDetector.DefaultChannel}-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, minimumRustVersion: null, "api"));
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
    // The date goes after the OS suffix: rustlang/rust publishes nightly-alpine-2024-01-01, and there is no
    // nightly-2024-01-01-alpine tag. https://hub.docker.com/r/rustlang/rust/tags?name=nightly-alpine
    [InlineData("nightly-2024-01-01", "rustlang/rust:nightly-alpine-2024-01-01")]
    public void MapsToolchainChannelsOntoRealImageTags(string channel, string expectedImage)
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain.toml", $"""
            [toolchain]
            channel = "{channel}"
            """);

        Assert.Equal(expectedImage, RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, minimumRustVersion: null, "api"));
    }

    [Fact]
    public void ReadsTheLegacyToolchainFile()
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain", "1.85.0\n");

        Assert.Equal("rust:1.85.0-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, minimumRustVersion: null, "api"));
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

        Assert.Equal("rust:1.90-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, minimumRustVersion: null, "api"));
    }

    [Fact]
    public void BetaChannelFailsBecauseNoImagePublishesIt()
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain", "beta");

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, minimumRustVersion: null, "api"));

        Assert.Equal(
            "The Rust app 'api' pins the 'beta' toolchain, but no official container image publishes the 'beta' channel. " +
            "Call WithDockerfileBaseImage(buildImage: \"...\") to supply an image that provides it, or pin an explicit version in rust-toolchain.toml.",
            exception.Message);
    }

    [Theory]
    // Older or equal MSRVs keep the pinned default, so a generated Dockerfile stays reproducible.
    [InlineData("1.70", null)]
    [InlineData("1.89", null)]
    [InlineData("1.89.0", null)]
    // A crate that needs something newer than the default cannot build with it, so the MSRV wins.
    [InlineData("1.90", "rust:1.90-alpine")]
    [InlineData("1.90.1", "rust:1.90.1-alpine")]
    public void MsrvOnlyRaisesTheDefaultVersion(string minimumRustVersion, string? expectedImage)
    {
        using var crate = new TempCrateDirectory();

        Assert.Equal(
            expectedImage ?? $"rust:{RustToolchainDetector.DefaultChannel}-alpine",
            RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, minimumRustVersion, "api"));
    }

    [Fact]
    public void MsrvDoesNotOverrideAPinnedToolchain()
    {
        using var crate = new TempCrateDirectory();
        crate.Write("rust-toolchain.toml", """
            [toolchain]
            channel = "1.85.0"
            """);

        Assert.Equal("rust:1.85.0-alpine", RustPublishImageResolver.ResolveDefaultBuildImage(crate.Path, "1.90", "api"));
    }

    [Fact]
    public void DefaultsPairAMuslBuildImageWithAMuslRuntimeImage()
    {
        using var crate = new TempCrateDirectory();

        var images = RustPublishImageResolver.Resolve(null, null, crate.Path, minimumRustVersion: null, "api");

        Assert.Equal($"rust:{RustToolchainDetector.DefaultChannel}-alpine", images.BuildImage);
        Assert.Equal(RustPublishImageResolver.DefaultRuntimeImage, images.RuntimeImage);
        Assert.True(images.BuildImageIsPossiblyAlpine);
        Assert.True(images.RuntimeImageIsPossiblyAlpine);
    }

    [Fact]
    public void SuppliedImagesAreUsedVerbatim()
    {
        using var crate = new TempCrateDirectory();

        var images = RustPublishImageResolver.Resolve("rust:1.89-bookworm", "debian:bookworm-slim", crate.Path, minimumRustVersion: null, "api");

        Assert.Equal("rust:1.89-bookworm", images.BuildImage);
        Assert.Equal("debian:bookworm-slim", images.RuntimeImage);
        Assert.False(images.BuildImageIsPossiblyAlpine);
        Assert.False(images.RuntimeImageIsPossiblyAlpine);
    }
}
