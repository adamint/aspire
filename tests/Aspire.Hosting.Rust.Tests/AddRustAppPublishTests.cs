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
    public async Task VerifyPublish_DefaultsToAMuslBuildAndRuntimePair()
    {
        var content = await PublishDockerfileAsync();

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_UsesVersionFromToolchainToml()
    {
        // A patch-level pin must be preserved verbatim: rust:1.89.0-alpine is a real tag, so rewriting it to
        // 1.89 would silently float the patch version the user deliberately pinned.
        var content = await PublishDockerfileAsync(configureSource: source =>
            File.WriteAllText(Path.Combine(source, "rust-toolchain.toml"), """
                [toolchain]
                channel = "1.89.0"
                """));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoBinTarget()
    {
        var content = await PublishDockerfileAsync(
            metadata: CargoMetadataFactory.SinglePackage("my-service", extraBins: ["worker"]),
            configureResource: app => app.WithCargoBinTarget("worker"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoProfile()
    {
        // A custom profile writes to target/<profile>/, so the COPY --from path must follow it rather than
        // assuming target/release.
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoProfile("dist"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoReleaseBuild()
    {
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoReleaseBuild());

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoTarget()
    {
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoTarget("aarch64-unknown-linux-musl"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithDockerfileBaseImage()
    {
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithDockerfileBaseImage(buildImage: "rust:1.89-bookworm", runtimeImage: "debian:bookworm-slim"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_ForwardsCargoFeaturesAndRawArgs()
    {
        // Regression: the publish build previously hard-coded `cargo build --release`, dropping every
        // configured cargo argument, so a crate needing --no-default-features published a binary that
        // differed from the one that ran locally.
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithCargoFeatures("grpc-tonic", "tls-ring").WithCargoArgs("--no-default-features", "--locked"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_ShellQuotesArgumentsWithMetacharacters()
    {
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithCargoArgs("--config", "build.rustflags=[\"--cfg\", 'has_quote']"));

        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_SelectsAWorkspacePackage()
    {
        var content = await PublishDockerfileAsync(
            metadata: CargoMetadataFactory.Workspace(
                new CargoPackageSpec("api", ["api"]),
                new CargoPackageSpec("worker", ["worker"])),
            configureResource: app => app.WithCargoPackage("worker"));

        await Verify(content);
    }

    [Fact]
    public async Task PublishPrefersAHandWrittenDockerfile()
    {
        // A crate that already has a Dockerfile owns its own container build; generating one would silently
        // shadow it.
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        File.WriteAllText(Path.Combine(sourceDir.FullName, "Dockerfile"), "FROM scratch\n");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.AddRustApp("api", sourceDir.FullName);
        builder.Build().Run();

        Assert.False(File.Exists(Path.Combine(outputDir.FullName, "api.Dockerfile")));
    }

    private async Task<string> PublishDockerfileAsync(
        Action<string>? configureSource = null,
        string? metadata = null,
        Func<IResourceBuilder<RustAppResource>, IResourceBuilder<RustAppResource>>? configureResource = null)
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        configureSource?.Invoke(sourceDir.FullName);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        var app = builder.AddRustApp("api", sourceDir.FullName);

        // Supply the cargo metadata directly so these tests exercise Dockerfile generation on machines
        // without a Rust toolchain installed.
        var metadataJson = metadata ?? CargoMetadataFactory.SinglePackage("my-service");
        app.WithAnnotation(new RustCargoMetadataProviderAnnotation(_ => Task.FromResult(CargoMetadata.Parse(metadataJson))));

        configureResource?.Invoke(app);

        builder.Build().Run();

        return await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "api.Dockerfile"), TestContext.Current.CancellationToken);
    }
}
