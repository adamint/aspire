// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class RustPublishTargetResolverTests
{
    [Fact]
    public void ResolvesTheSingleBinTargetOfADefaultPackage()
    {
        var target = Resolve(CargoMetadataFactory.SinglePackage("my-service"), new RustCargoOptionsAnnotation());

        Assert.Equal("my-service", target.BinaryName);
        Assert.Equal("target/release/my-service", target.RelativeBinaryPath);
    }

    [Fact]
    public void BinTargetNamesKeepHyphensVerbatim()
    {
        // Library target names have hyphens replaced with underscores; binary target names do not, so the
        // COPY path must use the name exactly as cargo reports it.
        var target = Resolve(CargoMetadataFactory.SinglePackage("aspire-sample-rust-app"), new RustCargoOptionsAnnotation());

        Assert.Equal("aspire-sample-rust-app", target.BinaryName);
    }

    [Fact]
    public void WithCargoBinTargetSelectsTheBinary()
    {
        var metadata = CargoMetadataFactory.SinglePackage("my-service", extraBins: ["worker"]);

        var target = Resolve(metadata, new RustCargoOptionsAnnotation { BinTarget = "worker" });

        Assert.Equal("worker", target.BinaryName);
        Assert.Equal("target/release/worker", target.RelativeBinaryPath);
    }

    [Fact]
    public void WithCargoPackageSelectsTheWorkspaceMember()
    {
        var metadata = CargoMetadataFactory.Workspace(
            new CargoPackageSpec("api", ["api"]),
            new CargoPackageSpec("worker", ["worker"]));

        var target = Resolve(metadata, new RustCargoOptionsAnnotation { Package = "worker" });

        Assert.Equal("worker", target.BinaryName);
    }

    [Fact]
    public void DefaultRunWinsOverMultipleBinTargets()
    {
        // `cargo run` honours default-run, so publish must produce the same binary rather than reporting the
        // package as ambiguous.
        var metadata = CargoMetadataFactory.SinglePackage("my-service", defaultRun: "server", extraBins: ["server", "worker"]);

        var target = Resolve(metadata, new RustCargoOptionsAnnotation());

        Assert.Equal("server", target.BinaryName);
    }

    [Fact]
    public void ExplicitBinTargetWinsOverDefaultRun()
    {
        var metadata = CargoMetadataFactory.SinglePackage("my-service", defaultRun: "server", extraBins: ["server", "worker"]);

        var target = Resolve(metadata, new RustCargoOptionsAnnotation { BinTarget = "worker" });

        Assert.Equal("worker", target.BinaryName);
    }

    [Theory]
    [InlineData(null, false, "target/release/my-service")]
    [InlineData(null, true, "target/release/my-service")]
    [InlineData("release", false, "target/release/my-service")]
    [InlineData("dev", false, "target/debug/my-service")]
    [InlineData("test", false, "target/debug/my-service")]
    [InlineData("bench", false, "target/release/my-service")]
    [InlineData("dist", false, "target/dist/my-service")]
    public void ProfileDeterminesTheOutputDirectory(string? profile, bool releaseBuild, string expectedPath)
    {
        var options = new RustCargoOptionsAnnotation { Profile = profile, ReleaseBuild = releaseBuild };

        var target = Resolve(CargoMetadataFactory.SinglePackage("my-service"), options);

        Assert.Equal(expectedPath, target.RelativeBinaryPath);
    }

    [Fact]
    public void TargetTripleAddsATripleDirectoryToThePath()
    {
        var options = new RustCargoOptionsAnnotation { TargetTriple = "aarch64-unknown-linux-musl" };

        var target = Resolve(CargoMetadataFactory.SinglePackage("my-service"), options);

        Assert.Equal("target/aarch64-unknown-linux-musl/release/my-service", target.RelativeBinaryPath);
    }

    [Fact]
    public void MultipleBinTargetsWithoutSelectionFail()
    {
        var metadata = CargoMetadataFactory.SinglePackage("my-service", extraBins: ["worker"]);

        var exception = Assert.Throws<DistributedApplicationException>(() => Resolve(metadata, new RustCargoOptionsAnnotation()));

        Assert.Equal(
            "The package 'my-service' used by the Rust app 'api' declares 2 binary targets ('my-service', 'worker'), so the binary to publish is " +
            "ambiguous. Call WithCargoBinTarget(\"<name>\") to select one, or set default-run in Cargo.toml.",
            exception.Message);
    }

    [Fact]
    public void NoBinTargetsFails()
    {
        var metadata = CargoMetadataFactory.Workspace(new CargoPackageSpec("my-lib", []));

        var exception = Assert.Throws<DistributedApplicationException>(() => Resolve(metadata, new RustCargoOptionsAnnotation()));

        Assert.Equal(
            "The package 'my-lib' used by the Rust app 'api' declares no binary targets, so there is nothing to run in a container. " +
            "Add a src/main.rs or a [[bin]] section to Cargo.toml.",
            exception.Message);
    }

    [Fact]
    public void MultipleWorkspaceDefaultMembersWithoutSelectionFail()
    {
        var metadata = CargoMetadataFactory.Workspace(
            new CargoPackageSpec("api", ["api"]),
            new CargoPackageSpec("worker", ["worker"]));

        var exception = Assert.Throws<DistributedApplicationException>(() => Resolve(metadata, new RustCargoOptionsAnnotation()));

        Assert.Equal(
            "The Rust app 'api' points at a cargo workspace with 2 default members ('api', 'worker'), so the binary to publish is ambiguous. " +
            "Call WithCargoPackage(\"<name>\") to select one.",
            exception.Message);
    }

    [Fact]
    public void WorkspaceDefaultMembersNarrowTheAmbiguity()
    {
        // [workspace] default-members = ["api"] makes a bare `cargo run` unambiguous even though the
        // workspace has several members.
        var metadata = CargoMetadataFactory.Workspace(
            [new CargoPackageSpec("api", ["api"]), new CargoPackageSpec("worker", ["worker"])],
            defaultMembers: ["api"]);

        var target = Resolve(metadata, new RustCargoOptionsAnnotation());

        Assert.Equal("api", target.BinaryName);
    }

    [Fact]
    public void UnknownBinTargetFails()
    {
        var metadata = CargoMetadataFactory.SinglePackage("my-service");

        var exception = Assert.Throws<DistributedApplicationException>(
            () => Resolve(metadata, new RustCargoOptionsAnnotation { BinTarget = "nope" }));

        Assert.Equal(
            "The Rust app 'api' selects the cargo binary 'nope', which the package 'my-service' does not declare. Available binaries: 'my-service'.",
            exception.Message);
    }

    [Fact]
    public void UnknownPackageFails()
    {
        var metadata = CargoMetadataFactory.Workspace(new CargoPackageSpec("api", ["api"]));

        var exception = Assert.Throws<DistributedApplicationException>(
            () => Resolve(metadata, new RustCargoOptionsAnnotation { Package = "nope" }));

        Assert.Equal(
            "The Rust app 'api' selects the cargo package 'nope', which does not exist in this workspace. Available packages: 'api'.",
            exception.Message);
    }

    [Fact]
    public void DefaultRunPointingAtAMissingBinaryFails()
    {
        var metadata = CargoMetadataFactory.SinglePackage("my-service", defaultRun: "ghost");

        var exception = Assert.Throws<DistributedApplicationException>(() => Resolve(metadata, new RustCargoOptionsAnnotation()));

        Assert.Equal(
            "The package 'my-service' used by the Rust app 'api' sets default-run = \"ghost\", but declares no such binary. " +
            "Available binaries: 'my-service'.",
            exception.Message);
    }

    private static RustPublishTarget Resolve(string metadataJson, RustCargoOptionsAnnotation options)
        => RustPublishTargetResolver.Resolve(CargoMetadata.Parse(metadataJson), options, "api");
}
