// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001
#pragma warning disable ASPIREDOCKERFILEBUILDER001

using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Utils;

namespace Aspire.Hosting.Rust.Tests;

public class AddRustAppPublishTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task VerifyPublish_UsesVersionFromToolchainToml_AndPackageNameForBinary()
    {
        // A patch-level pin must be preserved verbatim: rust:1.89.0-alpine is a real tag, so rewriting
        // it to 1.89 would silently float the patch version the user deliberately pinned.
        var content = await PublishDockerfileAsync(source =>
        {
            WriteCargoToml(source, "aspire-sample-rust-app");
            File.WriteAllText(Path.Combine(source, "rust-toolchain.toml"), """
                [toolchain]
                channel = "1.89.0"
                """);
        });

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_UsesDefaultVersion_WhenNoToolchainFile()
    {
        var content = await PublishDockerfileAsync(source => WriteCargoToml(source, "my-service"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_MapsStableChannelToUnversionedRustAlpine()
    {
        // There is no rust:stable-alpine tag; rust:alpine is the image that tracks current stable.
        var content = await PublishDockerfileAsync(source =>
        {
            WriteCargoToml(source, "my-service");
            File.WriteAllText(Path.Combine(source, "rust-toolchain"), "stable");
        });

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithDockerfileBaseImage()
    {
        var content = await PublishDockerfileAsync(
            source =>
            {
                WriteCargoToml(source, "my-service");
                File.WriteAllText(Path.Combine(source, "rust-toolchain"), "nightly");
            },
            app => app.WithDockerfileBaseImage(buildImage: "rustlang/rust:nightly-bookworm", runtimeImage: "debian:bookworm-slim"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_ForwardsCargoFeaturesAndRawArgs()
    {
        // Regression: the publish build previously hard-coded `cargo build --release`, dropping every
        // configured cargo argument, so a crate needing --no-default-features published a binary that
        // differed from the one that ran locally.
        var content = await PublishDockerfileAsync(
            source => WriteCargoToml(source, "my-service"),
            app => app.WithCargoFeatures("grpc-tonic", "tls-ring").WithCargoArgs("--no-default-features", "--locked"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_UsesSingleDeclaredBinTarget()
    {
        var content = await PublishDockerfileAsync(source => File.WriteAllText(Path.Combine(source, "Cargo.toml"), """
            [package]
            name = "rust-apphost-playground"

            [[bin]]
            name = "server"
            path = "src/server.rs"
            """));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_CustomProfileChangesCopyPath()
    {
        // A custom profile writes to target/<profile>/, so the COPY --from path must follow it rather
        // than assuming target/release.
        var content = await PublishDockerfileAsync(
            source => WriteCargoToml(source, "my-service"),
            app => app.WithCargoArgs("--profile", "dist"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_ShellQuotesArgumentsWithMetacharacters()
    {
        var content = await PublishDockerfileAsync(
            source => WriteCargoToml(source, "my-service"),
            app => app.WithCargoArgs("--config", "build.rustflags=[\"--cfg\", 'has_quote']"));

        await Verify(content);
    }

    private static void WriteCargoToml(string sourceDirectory, string packageName)
        => File.WriteAllText(Path.Combine(sourceDirectory, "Cargo.toml"), $"""
            [package]
            name = "{packageName}"
            version = "0.1.0"
            """);

    private async Task<string> PublishDockerfileAsync(
        Action<string> configureSource,
        Func<IResourceBuilder<RustAppResource>, IResourceBuilder<RustAppResource>>? configureResource = null)
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        configureSource(sourceDir.FullName);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        var app = builder.AddRustApp("api", sourceDir.FullName);
        configureResource?.Invoke(app);

        builder.Build().Run();

        return await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "api.Dockerfile"));
    }
}
