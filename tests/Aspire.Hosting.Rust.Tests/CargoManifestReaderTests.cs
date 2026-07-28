// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class CargoManifestReaderTests
{
    [Fact]
    public void ReadReturnsNullWhenManifestMissing()
    {
        using var dir = new TempCrateDirectory();

        Assert.Null(CargoManifestReader.Read(dir.Path));
    }

    [Fact]
    public void ReadReturnsPackageName()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "aspire-sample-rust-app"
            version = "0.1.0"
            """);

        var manifest = CargoManifestReader.Read(dir.Path);

        Assert.NotNull(manifest);
        Assert.Equal("aspire-sample-rust-app", manifest.PackageName);
        Assert.Empty(manifest.BinTargetNames);
        Assert.False(manifest.IsVirtualManifest);
    }

    [Fact]
    public void ReadIgnoresNameFromOtherSections()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "my-app"

            [dependencies]
            name = "not-the-package"

            [package.metadata]
            name = "also-not-the-package"
            """);

        var manifest = CargoManifestReader.Read(dir.Path);

        Assert.Equal("my-app", manifest?.PackageName);
    }

    [Fact]
    public void ReadIgnoresCommentedName()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            # name = "commented-out"
            name = "real-name"
            """);

        Assert.Equal("real-name", CargoManifestReader.Read(dir.Path)?.PackageName);
    }

    [Fact]
    public void ReadSupportsLiteralStrings()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = 'single-quoted'
            """);

        Assert.Equal("single-quoted", CargoManifestReader.Read(dir.Path)?.PackageName);
    }

    [Fact]
    public void ReadCollectsDeclaredBinTargets()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [package]
            name = "rust-apphost-playground"

            [[bin]]
            name = "server"
            path = "src/server.rs"

            [[bin]]
            name = "worker"
            path = "src/worker.rs"
            """);

        var manifest = CargoManifestReader.Read(dir.Path);

        Assert.Equal(["server", "worker"], manifest?.BinTargetNames);
    }

    [Fact]
    public void ReadDetectsVirtualManifest()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [workspace]
            members = ["app"]
            """);

        var manifest = CargoManifestReader.Read(dir.Path);

        Assert.NotNull(manifest);
        Assert.Null(manifest.PackageName);
        Assert.True(manifest.IsVirtualManifest);
    }

    [Fact]
    public void ReadDoesNotTreatWorkspaceWithPackageAsVirtual()
    {
        using var dir = new TempCrateDirectory();
        dir.Write("Cargo.toml", """
            [workspace]
            members = ["app"]

            [package]
            name = "root-crate"
            """);

        var manifest = CargoManifestReader.Read(dir.Path);

        Assert.Equal("root-crate", manifest?.PackageName);
        Assert.False(manifest?.IsVirtualManifest);
    }
}
