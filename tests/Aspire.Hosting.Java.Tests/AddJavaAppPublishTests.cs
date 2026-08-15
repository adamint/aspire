// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001
#pragma warning disable ASPIREDOCKERFILEBUILDER001
#pragma warning disable ASPIREPIPELINES001
#pragma warning disable ASPIREPIPELINES003

using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Utils;

namespace Aspire.Hosting.Java.Tests;

public class AddJavaAppPublishTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task VerifyPublish_GeneratesAMavenBuildAndJreRuntimePair()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        Assert.StartsWith("FROM docker.io/library/maven:3-eclipse-temurin-21 AS build", content);
        Assert.Contains("\nFROM docker.io/library/eclipse-temurin:21-jre\n", content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_GeneratesAGradleBuild()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WriteGradleBuild(source, """
                java {
                    toolchain {
                        languageVersion = JavaLanguageVersion.of(17)
                    }
                }
                """),
            configureResource: app => app.WithGradleTask("bootRun"));

        Assert.StartsWith("FROM docker.io/library/gradle:8-jdk17 AS build", content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_CopiesABuildProducedOtelAgentIntoTheRuntimeImage()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app
                .WithMavenGoal("spring-boot:run")
                .WithOtelAgent("target/agent/opentelemetry-javaagent.jar"));

        // The agent is produced by the build, so it exists only in the build stage. Without this COPY the
        // published container starts a JVM pointing at a JAR that is not in the image and dies during VM
        // initialization with "Error opening zip file or JAR manifest missing".
        Assert.Contains(
            "COPY --from=build /app/target/agent/opentelemetry-javaagent.jar /app/agent.jar",
            content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_DoesNotCopyAnAbsoluteOtelAgentPath()
    {
        var agentPath = OperatingSystem.IsWindows() ? @"C:\opt\otel\agent.jar" : "/opt/otel/agent.jar";

        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app
                .WithMavenGoal("spring-boot:run")
                .WithOtelAgent(agentPath));

        // An absolute path cannot have come out of the build context, so there is nothing to copy from.
        Assert.DoesNotContain("/app/agent.jar", content);
    }

    [Fact]
    public async Task VerifyPublish_UsesTheWrapperWhenTheProjectShipsOne()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source =>
            {
                WritePom(source, javaVersion: "21");
                File.WriteAllText(Path.Combine(source, "mvnw"), "#!/bin/sh\n");
            },
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        // sh ./mvnw rather than ./mvnw: a wrapper checked out from a Windows clone arrives without the
        // executable bit, and invoking the interpreter directly does not depend on the file mode.
        Assert.StartsWith("FROM docker.io/library/eclipse-temurin:21-jdk AS build", content);
        Assert.Contains("sh ./mvnw -B -ntp -DskipTests package", content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_FallsBackToTheImageToolWhenNoWrapperIsPresent()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WriteGradleBuild(source, ""),
            configureResource: app => app.WithGradleTask("bootRun"));

        Assert.Contains("gradle --no-daemon -x test build", content);
        Assert.DoesNotContain("sh ./gradlew", content);
    }

    [Fact]
    public async Task VerifyPublish_ReusesTheArgumentsConfiguredForTheHostBuildStep()
    {
        // The host-side build step only runs in run mode, but the arguments it was given describe how this
        // project produces a deployable artifact, so the container build runs the same ones.
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run").WithMavenBuild("-Pprod", "package"));

        Assert.Contains("mvn -Pprod package", content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_DetectsTheBuildToolFromDiskWhenOnlyAJarPathWasGiven()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            jarPath: "target/worker.jar");

        Assert.Contains("mvn -B -ntp -DskipTests package", content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_CopiesTheExplicitArtifactWhenWithJarArtifactIsUsed()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run").WithJarArtifact("target/custom-name.jar"));

        Assert.Contains("cp 'target/custom-name.jar' /build/app.jar", content);
        // The glob selection is what WithJarArtifact exists to replace, so it must not also be emitted.
        Assert.DoesNotContain("expected exactly one application JAR", content);
    }

    [Fact]
    public async Task VerifyPublish_FailsTheContainerBuildWhenTheJarIsAmbiguous()
    {
        // Spring Boot's plugin writes app.jar next to the base plugin's app-plain.jar. The -plain suffix is
        // filtered, but anything still ambiguous has to stop the build rather than pick one arbitrarily and
        // produce an image that exits with "no main manifest attribute".
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        Assert.Contains("grep -Ev '(-plain|-sources|-javadoc)\\.jar$'", content);
        Assert.Contains("exit 1", content);
    }

    [Fact]
    public async Task VerifyPublish_HonoursWithDockerfileBaseImage()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app
                .WithMavenGoal("spring-boot:run")
                .WithDockerfileBaseImage("docker.io/library/amazoncorretto:21", "docker.io/library/amazoncorretto:21-alpine"));

        Assert.StartsWith("FROM docker.io/library/amazoncorretto:21 AS build", content);
        Assert.Contains("\nFROM docker.io/library/amazoncorretto:21-alpine\n", content);
        // Alpine's busybox tools take different switches than the glibc images the JRE default uses.
        Assert.Contains("addgroup -S app && adduser -S -G app app", content);
        await Verify(content);
    }

    [Fact]
    public async Task VerifyPublish_RunsAsANonRootUser()
    {
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        Assert.Contains("useradd --system --gid 999 --uid 999 --no-create-home app", content);
        Assert.Contains("\nUSER app\n", content);
    }

    [Fact]
    public async Task VerifyPublish_UsesTheExecFormEntrypointSoTheJvmReceivesSigterm()
    {
        // With the shell form the JVM is not PID 1 and never sees SIGTERM, so Spring's shutdown hooks are
        // skipped and the container is killed after the stop timeout instead.
        var content = await PublishDockerfileAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        Assert.Contains("""ENTRYPOINT ["java","-jar","/app/app.jar"]""", content);
    }

    [Fact]
    public async Task VerifyPublish_EmitsABuildContextIgnoreThatExcludesBuildOutputDirectories()
    {
        var ignore = await PublishBuildContextIgnoreAsync(
            configureSource: source => WritePom(source, javaVersion: "21"),
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        Assert.NotNull(ignore);
        await Verify(ignore);
    }

    [Fact]
    public async Task VerifyPublish_LeavesAnAuthoredDockerignoreAlone()
    {
        // A <dockerfile>.dockerignore replaces the context root's .dockerignore rather than merging with it,
        // so generating one would silently drop every rule the author wrote.
        var ignore = await PublishBuildContextIgnoreAsync(
            configureSource: source =>
            {
                WritePom(source, javaVersion: "21");
                File.WriteAllText(Path.Combine(source, ".dockerignore"), "secrets/\n");
            },
            configureResource: app => app.WithMavenGoal("spring-boot:run"));

        Assert.Null(ignore);
    }

    [Fact]
    public async Task VerifyPublish_LeavesAnAuthoredDockerfileAlone()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        WritePom(sourceDir.FullName, javaVersion: "21");
        File.WriteAllText(Path.Combine(sourceDir.FullName, "Dockerfile"), "FROM scratch\n");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.AddJavaApp("api", sourceDir.FullName).WithMavenGoal("spring-boot:run");
        builder.Build().Run();

        Assert.False(File.Exists(Path.Combine(outputDir.FullName, "api.Dockerfile")));
    }

    [Fact]
    public async Task VerifyPublish_ProducesAContainerManifestEntry()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        WritePom(sourceDir.FullName, javaVersion: "21");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");
        builder.AddJavaApp("api", sourceDir.FullName)
               .WithMavenGoal("spring-boot:run")
               .WithHttpEndpoint(targetPort: 8080, env: "SERVER_PORT");

        builder.Build().Run();

        var manifest = await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "aspire-manifest.json"), TestContext.Current.CancellationToken);

        await Verify(manifest, "json")
            .ScrubLinesWithReplace(line => line.Contains("\"context\"", StringComparison.Ordinal) ? "      \"context\": \"{sourceDirectory}\"," : line);
    }

    [Theory]
    [InlineData("<java.version>17</java.version>", "17")]
    [InlineData("<maven.compiler.release>21</maven.compiler.release>", "21")]
    [InlineData("<maven.compiler.target>1.8</maven.compiler.target>", "8")]
    // A property reference cannot be expanded here and must not reach a FROM instruction, so it falls back.
    [InlineData("<maven.compiler.target>${java.version}</maven.compiler.target>", JavaVersionDetector.DefaultJavaVersion)]
    [InlineData("", JavaVersionDetector.DefaultJavaVersion)]
    public void JavaVersionDetector_ReadsTheTargetReleaseFromAPom(string properties, string expected)
    {
        using var appDirectory = new TempJavaAppDirectory();

        File.WriteAllText(Path.Combine(appDirectory.Path, "pom.xml"), $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <project xmlns="http://maven.apache.org/POM/4.0.0">
              <modelVersion>4.0.0</modelVersion>
              <artifactId>demo</artifactId>
              <properties>
                {properties}
              </properties>
            </project>
            """);

        Assert.Equal(expected, JavaVersionDetector.Detect(appDirectory.Path));
    }

    [Theory]
    [InlineData("java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }", "21")]
    [InlineData("java.toolchain.languageVersion.set(JavaLanguageVersion.of(17))", "17")]
    [InlineData("sourceCompatibility = JavaVersion.VERSION_1_8", "8")]
    [InlineData("sourceCompatibility = JavaVersion.VERSION_21", "21")]
    [InlineData("sourceCompatibility = '17'", "17")]
    [InlineData("targetCompatibility = 1.8", "8")]
    [InlineData("", JavaVersionDetector.DefaultJavaVersion)]
    public void JavaVersionDetector_ReadsTheTargetReleaseFromAGradleBuildScript(string script, string expected)
    {
        using var appDirectory = new TempJavaAppDirectory();

        File.WriteAllText(Path.Combine(appDirectory.Path, "build.gradle"), script);

        Assert.Equal(expected, JavaVersionDetector.Detect(appDirectory.Path));
    }

    [Fact]
    public void JavaVersionDetector_PrefersThePomWhenBothBuildFilesArePresent()
    {
        using var appDirectory = new TempJavaAppDirectory();

        File.WriteAllText(Path.Combine(appDirectory.Path, "pom.xml"), """
            <project><properties><java.version>17</java.version></properties></project>
            """);
        File.WriteAllText(Path.Combine(appDirectory.Path, "build.gradle"), "sourceCompatibility = '21'");

        Assert.Equal("17", JavaVersionDetector.Detect(appDirectory.Path));
    }

    [Fact]
    public void JavaVersionDetector_FallsBackWhenThePomCannotBeParsed()
    {
        // A malformed POM is the build tool's problem to report; publishing must not fail before the
        // container build has even started.
        using var appDirectory = new TempJavaAppDirectory();

        File.WriteAllText(Path.Combine(appDirectory.Path, "pom.xml"), "<project>");

        Assert.Equal(JavaVersionDetector.DefaultJavaVersion, JavaVersionDetector.Detect(appDirectory.Path));
    }

    [Fact]
    public void ResolveBuildTool_ThrowsWhenNoBuildToolCanBeFound()
    {
        using var appDirectory = new TempJavaAppDirectory();

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish);
        var app = builder.AddJavaApp("api", appDirectory.Path, "target/api.jar");

        var exception = Assert.Throws<DistributedApplicationException>(
            () => JavaDockerfileGenerator.ResolveBuildTool(app.Resource, appDirectory.Path));

        Assert.Equal(
            $"The Java application 'api' cannot be published because no build tool was found. " +
            $"Add a pom.xml or build.gradle to '{appDirectory.Path}', or call WithMavenBuild or WithGradleBuild " +
            "to state how the deployable JAR is produced.",
            exception.Message);
    }

    [Theory]
    [InlineData("build.gradle")]
    [InlineData("build.gradle.kts")]
    [InlineData("settings.gradle")]
    [InlineData("settings.gradle.kts")]
    public void ResolveBuildTool_DetectsGradleFromAnyOfItsBuildFiles(string fileName)
    {
        using var appDirectory = new TempJavaAppDirectory();
        File.WriteAllText(Path.Combine(appDirectory.Path, fileName), "");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish);
        var app = builder.AddJavaApp("api", appDirectory.Path, "build/libs/api.jar");

        var (tool, args) = JavaDockerfileGenerator.ResolveBuildTool(app.Resource, appDirectory.Path);

        Assert.Equal(JavaBuildTool.Gradle, tool);
        Assert.Equal(["--no-daemon", "-x", "test", "build"], args);
    }

    [Fact]
    public void ResolveBuildTool_PrefersTheConfiguredBuildStepOverWhatIsOnDisk()
    {
        // A pom.xml can sit next to a build.gradle in a repository that is mid-migration, so an explicit
        // WithGradleBuild has to win over the file that happens to be checked first.
        using var appDirectory = new TempJavaAppDirectory();
        File.WriteAllText(Path.Combine(appDirectory.Path, "pom.xml"), "<project />");
        File.WriteAllText(Path.Combine(appDirectory.Path, "build.gradle"), "");

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish);
        var app = builder.AddJavaApp("api", appDirectory.Path).WithGradleTask("bootRun").WithGradleBuild("bootJar");

        var (tool, args) = JavaDockerfileGenerator.ResolveBuildTool(app.Resource, appDirectory.Path);

        Assert.Equal(JavaBuildTool.Gradle, tool);
        Assert.Equal(["bootJar"], args);
    }

    private async Task<string> PublishDockerfileAsync(
        Action<string>? configureSource = null,
        string? jarPath = null,
        Func<IResourceBuilder<JavaAppResource>, IResourceBuilder<JavaAppResource>>? configureResource = null)
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        configureSource?.Invoke(sourceDir.FullName);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");

        var app = jarPath is null
            ? builder.AddJavaApp("api", sourceDir.FullName)
            : builder.AddJavaApp("api", sourceDir.FullName, jarPath);

        configureResource?.Invoke(app);

        builder.Build().Run();

        return await File.ReadAllTextAsync(Path.Combine(outputDir.FullName, "api.Dockerfile"), TestContext.Current.CancellationToken);
    }

    private async Task<string?> PublishBuildContextIgnoreAsync(
        Action<string>? configureSource = null,
        Func<IResourceBuilder<JavaAppResource>, IResourceBuilder<JavaAppResource>>? configureResource = null)
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var sourceDir = workspace.CreateDirectory("source");
        var outputDir = workspace.CreateDirectory("output");

        configureSource?.Invoke(sourceDir.FullName);

        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish, outputDir.FullName, step: "publish-manifest");

        var app = builder.AddJavaApp("api", sourceDir.FullName);
        configureResource?.Invoke(app);

        builder.Build().Run();

        var ignorePath = Path.Combine(outputDir.FullName, "api.Dockerfile.dockerignore");

        return File.Exists(ignorePath)
            ? await File.ReadAllTextAsync(ignorePath, TestContext.Current.CancellationToken)
            : null;
    }

    private static void WritePom(string sourceDirectory, string javaVersion)
    {
        File.WriteAllText(Path.Combine(sourceDirectory, "pom.xml"), $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <project xmlns="http://maven.apache.org/POM/4.0.0">
              <modelVersion>4.0.0</modelVersion>
              <groupId>com.example</groupId>
              <artifactId>api</artifactId>
              <version>0.0.1-SNAPSHOT</version>
              <properties>
                <java.version>{javaVersion}</java.version>
              </properties>
            </project>
            """);
    }

    private static void WriteGradleBuild(string sourceDirectory, string contents)
    {
        File.WriteAllText(Path.Combine(sourceDirectory, "build.gradle"), contents);
    }
}
