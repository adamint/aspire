// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class RustPublishResolverTests
{
    [Fact]
    public void ResolveBuildImageUsesDefaultWhenNoToolchainPinned()
    {
        using var dir = new TempCrateDirectory();

        Assert.Equal(
            $"rust:{RustToolchainDetector.DefaultChannel}-alpine",
            RustHostingExtensions.ResolveBuildImage(explicitBuildImage: null, dir.Path, "api"));
    }

    [Theory]
    [InlineData("1.89", "rust:1.89-alpine")]
    // A patch-level pin must survive: rust:1.89.0-alpine is a published tag, so rewriting it to 1.89
    // would silently float the patch version the user deliberately pinned.
    [InlineData("1.89.0", "rust:1.89.0-alpine")]
    // There is no rust:stable-alpine tag; rust:alpine is the image that tracks current stable.
    [InlineData("stable", "rust:alpine")]
    [InlineData("stable-x86_64-unknown-linux-gnu", "rust:alpine")]
    public void ResolveBuildImageMapsChannelToTag(string channel, string expected)
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain", channel);

        Assert.Equal(expected, RustHostingExtensions.ResolveBuildImage(explicitBuildImage: null, dir.Path, "api"));
    }

    [Theory]
    [InlineData("nightly")]
    [InlineData("nightly-2024-01-01")]
    [InlineData("beta")]
    public void ResolveBuildImageThrowsForChannelsWithoutOfficialImage(string channel)
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain", channel);

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustHostingExtensions.ResolveBuildImage(explicitBuildImage: null, dir.Path, "api"));

        Assert.Contains(channel, exception.Message, StringComparison.Ordinal);
        Assert.Contains("WithDockerfileBaseImage", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolveBuildImagePrefersExplicitImageOverUnmappableChannel()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("rust-toolchain", "nightly");

        Assert.Equal(
            "rustlang/rust:nightly-bookworm",
            RustHostingExtensions.ResolveBuildImage("rustlang/rust:nightly-bookworm", dir.Path, "api"));
    }

    [Fact]
    public void ResolvePublishBinaryNamePrefersExplicitBinTarget()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "my-service"
            """);

        Assert.Equal("worker", RustHostingExtensions.ResolvePublishBinaryName("worker", dir.Path, "api"));
    }

    [Fact]
    public void ResolvePublishBinaryNameUsesPackageNameVerbatim()
    {
        // Regression: the binary name must not be derived from the Aspire resource name, and hyphens
        // must not be translated to underscores (that rule applies to library targets only).
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "aspire-sample-rust-app"
            """);

        Assert.Equal(
            "aspire-sample-rust-app",
            RustHostingExtensions.ResolvePublishBinaryName(explicitBinTarget: null, dir.Path, "app"));
    }

    [Fact]
    public void ResolvePublishBinaryNameUsesSingleDeclaredBinTarget()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "my-service"

            [[bin]]
            name = "server"
            """);

        Assert.Equal("server", RustHostingExtensions.ResolvePublishBinaryName(explicitBinTarget: null, dir.Path, "api"));
    }

    [Fact]
    public void ResolvePublishBinaryNameThrowsWhenMultipleBinTargetsDeclared()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "my-service"

            [[bin]]
            name = "server"

            [[bin]]
            name = "worker"
            """);

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustHostingExtensions.ResolvePublishBinaryName(explicitBinTarget: null, dir.Path, "api"));

        Assert.Contains("2 [[bin]] targets", exception.Message, StringComparison.Ordinal);
        Assert.Contains("WithCargoBinTarget", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvePublishBinaryNameThrowsWhenManifestMissing()
    {
        using var dir = new TempCrateDirectory();

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustHostingExtensions.ResolvePublishBinaryName(explicitBinTarget: null, dir.Path, "api"));

        Assert.Contains("was not found", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvePublishBinaryNameThrowsForVirtualWorkspaceManifest()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [workspace]
            members = ["app"]
            """);

        var exception = Assert.Throws<DistributedApplicationException>(
            () => RustHostingExtensions.ResolvePublishBinaryName(explicitBinTarget: null, dir.Path, "api"));

        Assert.Contains("does not declare a [package] name", exception.Message, StringComparison.Ordinal);
    }
}
