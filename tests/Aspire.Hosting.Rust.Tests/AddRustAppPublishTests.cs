// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001
#pragma warning disable ASPIREDOCKERFILEBUILDER001

using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Utils;
using Microsoft.Extensions.DependencyInjection;
using System.Text.RegularExpressions;

namespace Aspire.Hosting.Rust.Tests;

public class AddRustAppPublishTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task VerifyPublish_DefaultsToAMuslBuildAndRuntimePair()
    {
        var content = await PublishDockerfileAsync();

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_LeavesAPinnedToolchainToRustupInsideTheImage()
    {
        // A pinned toolchain deliberately does not change the build image. rustup is present in the official
        // image and installs whatever the toolchain file names, so the pin is honoured inside the container
        // without the host having to map channel names onto image tags.
        var content = await PublishDockerfileAsync(configureSource: source =>
            File.WriteAllText(Path.Combine(source, "rust-toolchain.toml"), """
                [toolchain]
                channel = "1.89.0"
                """));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoBinTarget()
    {
        var content = await PublishDockerfileAsync(
            metadata: CargoMetadataFactory.SinglePackage("my-service", extraBins: ["worker"]),
            configureResource: app => app.WithCargoBinTarget("worker"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoExample()
    {
        // Examples land in target/<profile>/examples/, so the COPY --from path gets an extra segment.
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoExample("demo"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoProfile()
    {
        // A custom profile writes to target/<profile>/, so the COPY --from path must follow it rather than
        // assuming target/release.
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoProfile("dist"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoReleaseBuild()
    {
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoReleaseBuild());

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithCargoTarget()
    {
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoTarget("aarch64-unknown-linux-musl"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_ClearsStaleArtifactsBeforeACustomTargetProfileBuild()
    {
        var content = await PublishDockerfileAsync(
            configureResource: app => app
                .WithCargoExample("demo")
                .WithCargoProfile("dist")
                .WithCargoTarget("aarch64-unknown-linux-musl"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithDockerfileBaseImage()
    {
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithDockerfileBaseImage(buildImage: "rust:1.89-bookworm", runtimeImage: "debian:bookworm-slim"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_ForwardsCargoFeaturesAndRawArgs()
    {
        // Regression: the publish build previously hard-coded `cargo build --release`, dropping every
        // configured cargo argument, so a crate needing --no-default-features published a binary that
        // differed from the one that ran locally.
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithCargoFeatures("grpc-tonic", "tls-ring").WithCargoArgs("--no-default-features", "--locked"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_ShellQuotesArgumentsWithMetacharacters()
    {
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithCargoArgs("--config", "build.rustflags=[\"--cfg\", 'has_quote']"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_SelectsAWorkspacePackage()
    {
        var content = await PublishDockerfileAsync(
            metadata: CargoMetadataFactory.Workspace(
                new CargoPackageSpec("api", ["api"]),
                new CargoPackageSpec("worker", ["worker"])),
            configureResource: app => app.WithCargoPackage("worker"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public void PublishPrefersAHandWrittenDockerfile()
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

    [Fact]
    public async Task VerifyPublish_KeepsTheManifestPathRelative()
    {
        // Cargo runs from the app directory inside the image, so a relative manifest path names the same file
        // there as it does on the host and is passed through unchanged.
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithCargoManifestPath("crates/api/Cargo.toml"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_RewritesWindowsSeparatorsInTheManifestPath()
    {
        if (!OperatingSystem.IsWindows())
        {
            Assert.Skip("Windows manifest separator regression test.");
        }

        // A backslash is an ordinary filename character on Linux rather than a separator, so a manifest path
        // authored on Windows would name a file that does not exist in the image.
        var content = await PublishDockerfileAsync(
            configureResource: app => app.WithCargoManifestPath(@"crates\api\Cargo.toml"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task PublishPreservesBackslashesThatAreFilenameCharactersOnUnix()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("Unix filename regression test.");
        }

        var content = await PublishDockerfileAsync(
            configureSource: source =>
            {
                var manifestDirectory = Directory.CreateDirectory(Path.Combine(source, @"crates\api"));
                File.WriteAllText(Path.Combine(manifestDirectory.FullName, "Cargo.toml"), "[package]\nname = \"api\"\n");
            },
            configureResource: app => app.WithCargoManifestPath(@"crates\api/Cargo.toml"));

        Assert.Contains("""cargo build --manifest-path 'crates\api/Cargo.toml'""", content);
    }

    [Fact]
    public async Task VerifyPublish_CanonicalizesMacOSAliasesWhenValidatingTheManifestPath()
    {
        if (!OperatingSystem.IsMacOS())
        {
            Assert.Skip("macOS filesystem alias regression test.");
        }

        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");
        var canonicalSourceDir = PathNormalizer.ResolveSymlinks(sourceDir.FullName);

        if (string.Equals(sourceDir.FullName, canonicalSourceDir, StringComparison.Ordinal))
        {
            Assert.Skip("The test temporary directory does not traverse a macOS filesystem alias.");
        }

        // Cargo reports realpath-resolved paths such as /private/var/..., while the app directory can retain
        // the equivalent /var/... spelling. Express the canonical manifest as a relative path from the
        // lexical app directory to reproduce that mismatch without depending on /tmp.
        var canonicalManifest = Path.Combine(canonicalSourceDir, "crates", "api", "Cargo.toml");
        var manifestPath = Path.GetRelativePath(sourceDir.FullName, canonicalManifest);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.Services.AddSingleton<ICargoMetadataReader>(new FakeCargoMetadataReader(CargoMetadataFactory.SinglePackage("my-service")));
        builder.AddRustApp("api", sourceDir.FullName).WithCargoManifestPath(manifestPath);
        builder.Build().Run();

        var content = await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "api.Dockerfile"), TestContext.Current.CancellationToken);

        await VerifyDockerfile(content);
    }

    [Fact]
    public void PublishRejectsAnInContextSymlinkThatResolvesOutsideTheBuildContext()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outsideDir = workspace.CreateDirectory("outside");
        var outputDir = workspace.CreateDirectory("output");
        File.WriteAllText(Path.Combine(outsideDir.FullName, "Cargo.toml"), "[package]\nname = \"outside\"\n");
        CreateDirectorySymbolicLinkOrSkip(Path.Combine(sourceDir.FullName, "linked"), outsideDir.FullName);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.Services.AddSingleton<ICargoMetadataReader>(new FakeCargoMetadataReader(CargoMetadataFactory.SinglePackage("my-service")));
        builder.AddRustApp("api", sourceDir.FullName).WithCargoManifestPath("linked/Cargo.toml");
        builder.Build().Run();

        Assert.False(File.Exists(Path.Combine(outputDir.FullName, "api.Dockerfile")));
    }

    [Fact]
    public void PublishFailsClosedWhenAManifestTraversesCircularSymlinks()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");
        var firstLink = Path.Combine(sourceDir.FullName, "linked");
        var secondLink = Path.Combine(sourceDir.FullName, "loop");
        CreateDirectorySymbolicLinkOrSkip(
            firstLink,
            secondLink);
        CreateDirectorySymbolicLinkOrSkip(
            secondLink,
            firstLink);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.Services.AddSingleton<ICargoMetadataReader>(new FakeCargoMetadataReader(CargoMetadataFactory.SinglePackage("my-service")));
        builder.AddRustApp("api", sourceDir.FullName).WithCargoManifestPath("linked/Cargo.toml");
        builder.Build().Run();

        Assert.False(File.Exists(Path.Combine(outputDir.FullName, "api.Dockerfile")));
    }

    [Theory]
    [InlineData("../elsewhere/Cargo.toml")]
    [InlineData("crates/../../elsewhere/Cargo.toml")]
    [InlineData("crates/api/../../../../../../Cargo.toml")]
    [InlineData("../appsuffix/Cargo.toml")]
    public async Task PublishFailsWhenTheManifestIsOutsideTheAppDirectory(string manifestPath)
    {
        // Only the app directory is copied into the image, so a manifest above it could never be built there.
        // The .. segments are collapsed before the path is judged, so an escape buried mid-path is caught too.
        // The publish pipeline reports the failure through the host rather than rethrowing, so the observable
        // result is that no Dockerfile is produced.
        var exception = await Record.ExceptionAsync(
            () => PublishDockerfileAsync(configureResource: app => app.WithCargoManifestPath(manifestPath)));

        Assert.IsType<FileNotFoundException>(exception);
    }

    [Fact]
    public async Task PublishFailsWhenTheManifestPathIsAbsolute()
    {
        // An absolute path is fine when running, but publishing copies only the app directory into the image,
        // and an absolute path can spell that directory differently to the app host.
        var exception = await Record.ExceptionAsync(
            () => PublishDockerfileAsync(
                configureResource: app => app.WithCargoManifestPath(Path.Combine(Path.GetTempPath(), "Cargo.toml"))));

        Assert.IsType<FileNotFoundException>(exception);
    }

    [Fact]
    public async Task VerifyPublish_AddsLockedWhenTheCrateHasALockFile()
    {
        // A committed lock file is the whole point of --locked: the image must build the dependency versions
        // that were reviewed, not whatever resolves at build time.
        var content = await PublishDockerfileAsync(configureSource: source =>
            File.WriteAllText(Path.Combine(source, "Cargo.lock"), "version = 4\n"));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursOptingOutOfTheLockedAndReleaseDefaults()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => File.WriteAllText(Path.Combine(source, "Cargo.lock"), "version = 4\n"),
            configureResource: app => app.WithCargoLocked(false).WithCargoReleaseBuild(false));

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task PublishIsolatesTheTargetCacheByResourceIdentity()
    {
        var first = await PublishDockerfileAsync();
        var second = await PublishDockerfileAsync();
        const string cacheMountPattern = @"--mount=type=cache,id=(aspire-rust-[0-9a-f]{16}),target=/build/target,sharing=locked";

        var firstMatch = Regex.Match(first, cacheMountPattern);
        var secondMatch = Regex.Match(second, cacheMountPattern);

        Assert.True(firstMatch.Success);
        Assert.True(secondMatch.Success);
        Assert.NotEqual(firstMatch.Groups[1].Value, secondMatch.Groups[1].Value);
    }

    [Fact]
    public async Task VerifyPublish_DoesNotRepeatLockedWhenTheResourceAlreadyAskedForIt()
    {
        // Run mode already emitted --locked, and passing it twice makes cargo's own error messages confusing.
        var content = await PublishDockerfileAsync(configureResource: app => app.WithCargoLocked());

        await VerifyDockerfile(content);
    }

    [Fact]
    public async Task VerifyPublish_EmitsABuildContextIgnoreThatExcludesTargetDirectories()
    {
        // `COPY . .` would otherwise upload the crate's local target/ directory, which is routinely several
        // gigabytes and is rebuilt inside the image regardless.
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.Services.AddSingleton<ICargoMetadataReader>(new FakeCargoMetadataReader(CargoMetadataFactory.SinglePackage("my-service")));
        builder.AddRustApp("api", sourceDir.FullName);
        builder.Build().Run();

        var ignore = await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "api.Dockerfile.dockerignore"), TestContext.Current.CancellationToken);

        await Verify(ignore);
    }

    [Fact]
    public async Task AnAuthoredDockerignoreTakesOverFromTheDefaults()
    {
        // Docker gives <dockerfile>.dockerignore precedence over the context root's .dockerignore instead of
        // merging them, so emitting the defaults would silently discard the crate's own rules.
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        File.WriteAllText(Path.Combine(sourceDir.FullName, ".dockerignore"), "*.md\n");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.Services.AddSingleton<ICargoMetadataReader>(new FakeCargoMetadataReader(CargoMetadataFactory.SinglePackage("my-service")));
        builder.AddRustApp("api", sourceDir.FullName);
        builder.Build().Run();

        Assert.False(File.Exists(Path.Combine(outputDir.FullName, "api.Dockerfile.dockerignore")));
    }

    [Fact]
    public void PublishingFollowsWithWorkingDirectory()
    {
        // The crate is read from the resource's working directory rather than the value AddRustApp was given,
        // so a WithWorkingDirectory applied afterwards decides both what cargo is asked about and what is
        // copied into the image.
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var relocatedDir = workspace.CreateDirectory("relocated");
        var outputDir = workspace.CreateDirectory("output");

        var reader = new FakeCargoMetadataReader(CargoMetadataFactory.SinglePackage("my-service"));

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.Services.AddSingleton<ICargoMetadataReader>(reader);
        builder.AddRustApp("api", sourceDir.FullName).WithWorkingDirectory(relocatedDir.FullName);
        builder.Build().Run();

        Assert.Equal(relocatedDir.FullName, reader.LastWorkingDirectory);
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

        // Answer cargo metadata from a canned document so these tests exercise Dockerfile generation on
        // machines without a Rust toolchain installed.
        builder.Services.AddSingleton<ICargoMetadataReader>(
            new FakeCargoMetadataReader(metadata ?? CargoMetadataFactory.SinglePackage("my-service")));

        var app = builder.AddRustApp("api", sourceDir.FullName);

        configureResource?.Invoke(app);

        builder.Build().Run();

        return await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "api.Dockerfile"), TestContext.Current.CancellationToken);
    }

    private static async Task VerifyDockerfile(string content)
    {
        await Verify(content)
            .ScrubLinesWithReplace(line => Regex.Replace(
                line,
                @"id=aspire-rust-[0-9a-f]{16}",
                "id=aspire-rust-<resource-id>"));
    }

    private static void CreateDirectorySymbolicLinkOrSkip(string linkPath, string targetPath)
    {
        try
        {
            Directory.CreateSymbolicLink(linkPath, targetPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            Assert.Skip($"Symbolic links are unavailable in this test environment: {ex.Message}");
        }
    }
}
