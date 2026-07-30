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
    public void TargetAddsATripleDirectoryToThePath()
    {
        var options = new RustCargoOptionsAnnotation { Target = "aarch64-unknown-linux-musl" };

        var target = Resolve(CargoMetadataFactory.SinglePackage("my-service"), options);

        Assert.Equal("target/aarch64-unknown-linux-musl/release/my-service", target.RelativeBinaryPath);
    }

    [Fact]
    public void MultipleBinTargetsWithoutSelectionFail()
    {
        // `cargo run` can still succeed here (with a raw --bin that publish deliberately does not interpret),
        // so this is one of the few cases publish has to report rather than pass through.
        var metadata = CargoMetadataFactory.SinglePackage("my-service", extraBins: ["worker"]);

        var exception = Assert.Throws<DistributedApplicationException>(() => Resolve(metadata, new RustCargoOptionsAnnotation()));

        Assert.Equal(
            "Unable to work out which binary the Rust app 'api' publishes: the package 'my-service' declares 2 binary targets. " +
            "Call WithCargoBinTarget(\"<name>\") so the generated Dockerfile copies the right one.",
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
            "Unable to work out which binary the Rust app 'api' publishes: 'cargo metadata' reported 2 default workspace members. " +
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
    public void ABinTargetCargoDoesNotReportIsPassedThrough()
    {
        // Publishing runs after the app already ran, so cargo has already had its say on whether the
        // selection is valid. Re-validating here would only turn a working app into a publish-time failure
        // when metadata and the selection disagree for a reason cargo accepts.
        var metadata = CargoMetadataFactory.SinglePackage("my-service");

        var target = Resolve(metadata, new RustCargoOptionsAnnotation { BinTarget = "worker" });

        Assert.Equal("worker", target.BinaryName);
    }

    private static RustPublishTarget Resolve(string metadataJson, RustCargoOptionsAnnotation options)
        => RustPublishTargetResolver.Resolve(CargoMetadata.Parse(metadataJson), options, "api");
}
