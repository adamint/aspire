// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001

using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Tests.Utils;
using Aspire.Hosting.Utils;

namespace Aspire.Hosting.Java.Tests;

public class AddJavaAppTests
{
    // An absolute path on the current platform. A POSIX-style literal would be rewritten to C:\opt\...
    // by Path.GetFullPath on Windows, so the expected value has to be platform-specific.
    private static readonly string s_absoluteAgentPath =
        OperatingSystem.IsWindows() ? @"C:\opt\otel\agent.jar" : "/opt/otel/agent.jar";

    private static string AbsoluteAgentPath => s_absoluteAgentPath;

    // ---- Launch mode -------------------------------------------------------

    [Fact]
    public async Task AddJavaApp_MavenGoal_LaunchesThroughTheWrapper()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path).WithMavenGoal("spring-boot:run");

        // The command has to become the wrapper. Leaving it as "java" while the goal was still contributed
        // as an argument produced the uninvokable command line "java spring-boot:run".
        Assert.Equal(Path.Combine(tempDir.Path, JavaHostingExtensions.s_defaultMavenWrapper), app.Resource.Command);
        Assert.Equal(["spring-boot:run"], await ArgumentEvaluator.GetArgumentListAsync(app.Resource));
    }

    [Fact]
    public async Task AddJavaApp_GradleTask_LaunchesThroughTheWrapper()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path).WithGradleTask("bootRun", "--no-daemon");

        Assert.Equal(Path.Combine(tempDir.Path, JavaHostingExtensions.s_defaultGradleWrapper), app.Resource.Command);
        Assert.Equal(["bootRun", "--no-daemon"], await ArgumentEvaluator.GetArgumentListAsync(app.Resource));
    }

    [Fact]
    public async Task VerifyManifest_AddJavaAppWithJar()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "app.jar");

        var manifest = await ManifestUtils.GetManifest(app.Resource);

        var expected = """
            {
              "type": "executable.v0",
              "workingDirectory": ".",
              "command": "java",
              "args": [
                "-jar",
                "app.jar"
              ]
            }
            """;
        Assert.Equal(expected, manifest.ToString());
    }

    [Fact]
    public async Task VerifyManifest_AddJavaAppWithJarAndArgs()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "app.jar", ["--server.port=8080"]);

        var manifest = await ManifestUtils.GetManifest(app.Resource);

        var expected = """
            {
              "type": "executable.v0",
              "workingDirectory": ".",
              "command": "java",
              "args": [
                "-jar",
                "app.jar",
                "--server.port=8080"
              ]
            }
            """;
        Assert.Equal(expected, manifest.ToString());
    }

    // ---- Resource properties ------------------------------------------------

    [Fact]
    public void AddJavaApp_SetsResourceName()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("myapi", AppContext.BaseDirectory);

        Assert.Equal("myapi", app.Resource.Name);
    }

    [Fact]
    public void AddJavaApp_UsesJavaAsCommand()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        Assert.Equal("java", app.Resource.Command);
    }

    [Fact]
    public void AddJavaApp_ResolvesWorkingDirectoryFullPath()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path);

        var expectedPath = Path.GetFullPath(tempDir.Path, builder.AppHostDirectory);
        Assert.Equal(expectedPath, app.Resource.WorkingDirectory);
    }

    [Fact]
    public void AddJavaApp_ImplementsIResourceWithServiceDiscovery()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        Assert.IsAssignableFrom<IResourceWithServiceDiscovery>(app.Resource);
    }

    [Fact]
    public void AddJavaApp_ImplementsIContainerFilesDestinationResource()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        Assert.IsAssignableFrom<IContainerFilesDestinationResource>(app.Resource);
    }

    [Fact]
    public async Task AddJavaApp_WithoutLaunchMode_ThrowsWhenArgumentsAreGathered()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        // A bare "java" with no arguments prints the JVM usage text and exits, so the failure is raised
        // where it can name the resource and the fix.
        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            async () => await ArgumentEvaluator.GetArgumentListAsync(app.Resource));

        Assert.Equal(
            "Java application 'api' has no launch mode configured. Call WithMavenGoal or WithGradleTask to run it through a build tool, or use the AddJavaApp overload that takes a jarPath to run a prebuilt JAR.",
            exception.Message);
    }

    [Fact]
    public async Task AddJavaAppWithJar_ArgsAreJarAndUserArgs()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "app.jar", ["--port=9090"]);

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Equal(["-jar", "app.jar", "--port=9090"], args);
    }

    [Fact]
    public async Task AddJavaAppWithJar_NoUserArgs_OnlyJarArgs()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "app.jar");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Equal(["-jar", "app.jar"], args);
    }

    // ---- WithMavenGoal ------------------------------------------------------

    [Fact]
    public void WithMavenGoalShouldThrowWhenBuilderIsNull()
    {
        IResourceBuilder<JavaAppResource> builder = null!;

        var action = () => builder.WithMavenGoal("spring-boot:run");

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal(nameof(builder), exception.ParamName);
    }

    [Fact]
    public void WithMavenGoalShouldThrowWhenGoalIsNullOrEmpty()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var nullAction = () => app.WithMavenGoal(null!);
        var emptyAction = () => app.WithMavenGoal(string.Empty);

        var nullEx = Assert.Throws<ArgumentNullException>(nullAction);
        Assert.Equal("goal", nullEx.ParamName);

        var emptyEx = Assert.Throws<ArgumentException>(emptyAction);
        Assert.Equal("goal", emptyEx.ParamName);
    }

    [Fact]
    public async Task WithMavenGoal_PassesGoalAsArgument()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithMavenGoal("spring-boot:run");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Contains("spring-boot:run", args);
    }

    [Fact]
    public async Task WithMavenGoal_WithArgs_IncludesGoalAndArgs()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithMavenGoal("spring-boot:run", "-DskipTests");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Contains("spring-boot:run", args);
        Assert.Contains("-DskipTests", args);
    }

    // ---- WithGradleTask -----------------------------------------------------

    [Fact]
    public void WithGradleTaskShouldThrowWhenBuilderIsNull()
    {
        IResourceBuilder<JavaAppResource> builder = null!;

        var action = () => builder.WithGradleTask("bootRun");

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal(nameof(builder), exception.ParamName);
    }

    [Fact]
    public void WithGradleTaskShouldThrowWhenTaskIsNullOrEmpty()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var nullAction = () => app.WithGradleTask(null!);
        var emptyAction = () => app.WithGradleTask(string.Empty);

        var nullEx = Assert.Throws<ArgumentNullException>(nullAction);
        Assert.Equal("task", nullEx.ParamName);

        var emptyEx = Assert.Throws<ArgumentException>(emptyAction);
        Assert.Equal("task", emptyEx.ParamName);
    }

    [Fact]
    public async Task WithGradleTask_PassesTaskAsArgument()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithGradleTask("bootRun");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Contains("bootRun", args);
    }

    [Fact]
    public async Task WithGradleTask_WrapperPathIsResolved()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithGradleTask("bootRun");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        // WithCommand sets the wrapper as the command, args contain only the task
        var expectedWrapper = Path.GetFullPath(Path.Combine(tempDir.Path, JavaHostingExtensions.s_defaultGradleWrapper));
        Assert.Equal(expectedWrapper, app.Resource.Command);
        Assert.Contains("bootRun", args);
    }

    [Fact]
    public async Task WithMavenGoal_WrapperPathIsResolved()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithMavenGoal("spring-boot:run");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        // WithCommand sets the wrapper as the command, args contain only the goal
        var expectedWrapper = Path.GetFullPath(Path.Combine(tempDir.Path, JavaHostingExtensions.s_defaultMavenWrapper));
        Assert.Equal(expectedWrapper, app.Resource.Command);
        Assert.Contains("spring-boot:run", args);
    }

    [Fact]
    public async Task WithGradleTask_WithArgs_IncludesTaskAndArgs()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithGradleTask("bootRun", "--no-daemon");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Contains("bootRun", args);
        Assert.Contains("--no-daemon", args);
    }

    [Fact]
    public void WithGradleTask_ThrowsWhenJarPathIsSet()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "app.jar");

        var action = () => app.WithGradleTask("bootRun");

        var exception = Assert.Throws<InvalidOperationException>(action);
        Assert.Equal(
            "WithGradleTask cannot be used when a JAR path has been specified. Use either the AddJavaApp overload that takes a jarPath, or WithGradleTask, not both.",
            exception.Message);
    }

    [Fact]
    public void WithMavenGoal_ThrowsWhenJarPathIsSet()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "app.jar");

        var action = () => app.WithMavenGoal("spring-boot:run");

        var exception = Assert.Throws<InvalidOperationException>(action);
        Assert.Equal(
            "WithMavenGoal cannot be used when a JAR path has been specified. Use either the AddJavaApp overload that takes a jarPath, or WithMavenGoal, not both.",
            exception.Message);
    }

    [Fact]
    public void WithGradleTask_ThrowsWhenMavenGoalIsAlreadyConfigured()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory).WithMavenGoal("spring-boot:run");

        var action = () => app.WithGradleTask("bootRun");

        var exception = Assert.Throws<InvalidOperationException>(action);
        Assert.Equal(
            "WithGradleTask cannot be used when the application is already configured to launch with Maven. A Java application is launched by a single build tool.",
            exception.Message);
    }

    [Fact]
    public void WithMavenGoal_ThrowsWhenGradleTaskIsAlreadyConfigured()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory).WithGradleTask("bootRun");

        var action = () => app.WithMavenGoal("spring-boot:run");

        var exception = Assert.Throws<InvalidOperationException>(action);
        Assert.Equal(
            "WithMavenGoal cannot be used when the application is already configured to launch with Gradle. A Java application is launched by a single build tool.",
            exception.Message);
    }

    // ---- WithWrapperPath ----------------------------------------------------

    [Fact]
    public void WithWrapperPathShouldThrowWhenBuilderIsNull()
    {
        IResourceBuilder<JavaAppResource> builder = null!;

        var action = () => builder.WithWrapperPath("custom-mvnw");

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal(nameof(builder), exception.ParamName);
    }

    [Fact]
    public void WithWrapperPathShouldThrowWhenWrapperScriptIsNullOrEmpty()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var nullAction = () => app.WithWrapperPath(null!);
        var emptyAction = () => app.WithWrapperPath(string.Empty);

        var nullEx = Assert.Throws<ArgumentNullException>(nullAction);
        Assert.Equal("wrapperScript", nullEx.ParamName);

        var emptyEx = Assert.Throws<ArgumentException>(emptyAction);
        Assert.Equal("wrapperScript", emptyEx.ParamName);
    }

    [Fact]
    public async Task WithWrapperPath_OverridesMavenDefaultWrapper()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithWrapperPath("scripts/custom-mvnw")
            .WithMavenGoal("spring-boot:run");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        // WithCommand sets the custom wrapper as the command
        var expectedWrapper = Path.GetFullPath(Path.Combine(tempDir.Path, "scripts/custom-mvnw"));
        Assert.Equal(expectedWrapper, app.Resource.Command);
        Assert.Contains("spring-boot:run", args);
    }

    [Fact]
    public async Task WithWrapperPath_OverridesGradleDefaultWrapper()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithWrapperPath("scripts/custom-gradlew")
            .WithGradleTask("bootRun");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        // WithCommand sets the custom wrapper as the command
        var expectedWrapper = Path.GetFullPath(Path.Combine(tempDir.Path, "scripts/custom-gradlew"));
        Assert.Equal(expectedWrapper, app.Resource.Command);
        Assert.Contains("bootRun", args);
    }

    // ---- WithJvmArgs --------------------------------------------------------

    [Fact]
    public void WithJvmArgsShouldThrowWhenBuilderIsNull()
    {
        IResourceBuilder<JavaAppResource> builder = null!;

        var action = () => builder.WithJvmArgs(["-Xmx512m"]);

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal(nameof(builder), exception.ParamName);
    }

    [Fact]
    public void WithJvmArgsShouldThrowWhenArgsIsNull()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var action = () => app.WithJvmArgs(null!);

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal("args", exception.ParamName);
    }

    [Fact]
    public async Task WithJvmArgs_SetsJavaToolOptions()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithJvmArgs(["-Xmx512m", "-Xms256m"]);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        Assert.Equal("-Xmx512m -Xms256m", envVars["JAVA_TOOL_OPTIONS"]);
    }

    [Fact]
    public async Task WithJvmArgs_EmptyArgs_DoesNotSetJavaToolOptions()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithJvmArgs([]);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        Assert.False(envVars.ContainsKey("JAVA_TOOL_OPTIONS"));
    }

    [Fact]
    public async Task WithJvmArgs_MultipleCalls_MergeValues()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithJvmArgs(["-Xmx512m"])
            .WithJvmArgs(["-Xms256m"]);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        Assert.Equal("-Xmx512m -Xms256m", envVars["JAVA_TOOL_OPTIONS"]);
    }

    // ---- WithOtelAgent ------------------------------------------------------

    [Fact]
    public void WithOtelAgentShouldThrowWhenBuilderIsNull()
    {
        IResourceBuilder<JavaAppResource> builder = null!;

        var action = () => builder.WithOtelAgent("/opt/otel/agent.jar");

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal(nameof(builder), exception.ParamName);
    }

    [Fact]
    public void WithOtelAgentShouldThrowWhenAgentPathIsNullOrWhiteSpace()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        Assert.Throws<ArgumentException>(() => app.WithOtelAgent("  "));
    }

    [Fact]
    public async Task AddJavaApp_ConfiguresOtlpExporterWithoutAnAgent()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        // The OTLP exporter is wired by AddJavaApp itself, so a Java application reports telemetry
        // through Micrometer/OTel SDK instrumentation even when the Java agent is not used.
        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        Assert.True(envVars.ContainsKey("OTEL_EXPORTER_OTLP_ENDPOINT"));
    }

    [Fact]
    public async Task WithOtelAgent_WithAgentPath_SetsJavaAgentInToolOptions()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithOtelAgent(AbsoluteAgentPath);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        Assert.Equal($"-javaagent:{AbsoluteAgentPath}", envVars["JAVA_TOOL_OPTIONS"]);
    }

    [Fact]
    public async Task WithOtelAgent_WithAgentPath_CombinedWithJvmArgs()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithJvmArgs(["-Xmx512m"])
            .WithOtelAgent(AbsoluteAgentPath);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        Assert.Equal($"-Xmx512m -javaagent:{AbsoluteAgentPath}", envVars["JAVA_TOOL_OPTIONS"]);
    }

    [Fact]
    public async Task WithOtelAgent_RelativeAgentPath_IsMadeAbsoluteInRunMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithOtelAgent(Path.Combine("target", "agent", "opentelemetry-javaagent.jar"));

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);

        // JAVA_TOOL_OPTIONS is inherited by every JVM started beneath the resource, and build tools start
        // JVMs from directories other than the application directory. The Gradle daemon in particular
        // starts from its own distribution directory, so a relative -javaagent: path fails to resolve and
        // the daemon dies during VM initialization rather than reporting a normal build failure.
        var expected = Path.GetFullPath(
            Path.Combine(app.Resource.WorkingDirectory, "target", "agent", "opentelemetry-javaagent.jar"));

        Assert.Equal($"-javaagent:{expected}", envVars["JAVA_TOOL_OPTIONS"]);
        Assert.True(Path.IsPathFullyQualified(expected));
    }

    [Fact]
    public async Task WithOtelAgent_RelativeAgentPath_PointsAtContainerPathInPublishMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithOtelAgent("target/agent/opentelemetry-javaagent.jar");

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Publish, TestServiceProvider.Instance);

        // The path has to be interpreted inside the container, so a build-machine path would be wrong.
        // The generated Dockerfile copies the build-produced agent to a fixed location, and this has to
        // agree with it or the container starts a JVM pointing at a JAR that is not in the image.
        Assert.Equal("-javaagent:/app/agent.jar", envVars["JAVA_TOOL_OPTIONS"]);
    }

    [Fact]
    public async Task WithOtelAgent_AbsoluteAgentPath_IsLeftUnchangedInPublishMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithOtelAgent(AbsoluteAgentPath);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Publish, TestServiceProvider.Instance);

        // An absolute path cannot have come out of the build context, so it is the base image's or a
        // mount's responsibility and rewriting it would break that arrangement.
        Assert.Equal($"-javaagent:{AbsoluteAgentPath}", envVars["JAVA_TOOL_OPTIONS"]);
    }

    // ---- WithMavenBuild / WithGradleBuild -----------------------------------

    [Fact]
    public void WithMavenBuild_CreatesMavenBuildResourceInRunMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        builder.AddJavaApp("api", tempDir.Path)
            .WithMavenBuild();

        Assert.Contains(builder.Resources, r => r.Name == "api-maven-build");
        Assert.IsType<MavenBuildResource>(builder.Resources.First(r => r.Name == "api-maven-build"));
    }

    [Fact]
    public void WithMavenBuild_CustomArgs_CreatesBuildResource()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        builder.AddJavaApp("api", tempDir.Path)
            .WithMavenBuild("clean", "install", "-DskipTests");

        var buildResource = builder.Resources.First(r => r.Name == "api-maven-build");
        Assert.IsType<MavenBuildResource>(buildResource);
    }

    [Fact]
    public void WithGradleBuild_CreatesGradleBuildResourceInRunMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        builder.AddJavaApp("api", tempDir.Path)
            .WithGradleBuild();

        Assert.Contains(builder.Resources, r => r.Name == "api-gradle-build");
        Assert.IsType<GradleBuildResource>(builder.Resources.First(r => r.Name == "api-gradle-build"));
    }

    [Fact]
    public void WithGradleBuild_CustomArgs_CreatesBuildResource()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        builder.AddJavaApp("api", tempDir.Path)
            .WithGradleBuild("clean", "assemble", "--info");

        var buildResource = builder.Resources.First(r => r.Name == "api-gradle-build");
        Assert.IsType<GradleBuildResource>(buildResource);
    }

    [Fact]
    public void WithMavenBuild_DoesNotCreateBuildResourceInPublishMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        builder.AddJavaApp("api", tempDir.Path)
            .WithMavenBuild();

        Assert.DoesNotContain(builder.Resources, r => r.Name == "api-maven-build");
    }

    [Fact]
    public void WithGradleBuild_DoesNotCreateBuildResourceInPublishMode()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        builder.AddJavaApp("api", tempDir.Path)
            .WithGradleBuild();

        Assert.DoesNotContain(builder.Resources, r => r.Name == "api-gradle-build");
    }

    [Fact]
    public void WithMavenBuild_BuildResourceHasParentRelationship()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithMavenBuild();

        var buildResource = builder.Resources.First(r => r.Name == "api-maven-build");
        Assert.True(buildResource.TryGetAnnotationsOfType<ResourceRelationshipAnnotation>(out var relationships));
        Assert.Contains(relationships, r => r.Type == "Parent" && r.Resource == app.Resource);
    }

    [Fact]
    public void WithGradleBuild_BuildResourceHasParentRelationship()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithGradleBuild();

        var buildResource = builder.Resources.First(r => r.Name == "api-gradle-build");
        Assert.True(buildResource.TryGetAnnotationsOfType<ResourceRelationshipAnnotation>(out var relationships));
        Assert.Contains(relationships, r => r.Type == "Parent" && r.Resource == app.Resource);
    }

    // ---- JAR path -----------------------------------------------------------

    [Fact]
    public async Task AddJavaApp_WithJarPath_LaunchesTheJar()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory, "target/app.jar");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Equal("java", app.Resource.Command);
        Assert.Equal(["-jar", "target/app.jar"], args);
    }

    // ---- VS Code debugging --------------------------------------------------

    [Fact]
    public void AddJavaApp_InRunMode_SupportsDebugging()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Run).WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var annotation = app.Resource.Annotations.OfType<SupportsDebuggingAnnotation>().SingleOrDefault();
        Assert.NotNull(annotation);
        Assert.Equal("java", annotation!.LaunchConfigurationType);
    }

    [Fact]
    public void AddJavaApp_InPublishMode_DoesNotAddDebuggingAnnotation()
    {
        using var builder = TestDistributedApplicationBuilder.Create(DistributedApplicationOperation.Publish).WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory);

        var annotation = app.Resource.Annotations.OfType<SupportsDebuggingAnnotation>().SingleOrDefault();
        Assert.Null(annotation);
    }

    // ---- Chaining multiple methods ------------------------------------------

    [Fact]
    public async Task WithMavenGoal_ThenWithJvmArgs_SetsBothConfigurations()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithMavenGoal("spring-boot:run")
            .WithJvmArgs(["-Xmx1g"]);

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);
        Assert.Contains("spring-boot:run", args);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);
        Assert.Equal("-Xmx1g", envVars["JAVA_TOOL_OPTIONS"]);
    }

    [Fact]
    public async Task WithGradleTask_ThenWithOtelAgent_SetsBothConfigurations()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);

        var app = builder.AddJavaApp("api", AppContext.BaseDirectory)
            .WithGradleTask("bootRun")
            .WithOtelAgent(AbsoluteAgentPath);

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);
        Assert.Contains("bootRun", args);

        var envVars = await EnvironmentVariableEvaluator.GetEnvironmentVariablesAsync(
            app.Resource, DistributedApplicationOperation.Run, TestServiceProvider.Instance);
        Assert.Equal($"-javaagent:{AbsoluteAgentPath}", envVars["JAVA_TOOL_OPTIONS"]);
    }

    [Fact]
    public async Task WithWrapperPath_ThenWithMavenGoal_UsesCustomWrapper()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithWrapperPath("tools/mvn")
            .WithMavenGoal("spring-boot:run");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        // WithCommand sets the custom wrapper as the command
        var expectedWrapper = Path.GetFullPath(Path.Combine(tempDir.Path, "tools/mvn"));
        Assert.Equal(expectedWrapper, app.Resource.Command);
        Assert.Contains("spring-boot:run", args);
    }

    // ---- Manifest with Maven/Gradle goals -----------------------------------

    [Fact]
    public async Task VerifyManifest_WithMavenGoal()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithMavenGoal("spring-boot:run");

        var manifest = await ManifestUtils.GetManifest(app.Resource);

        // The manifest should show the maven wrapper as the command with the goal as args.
        var args = manifest?["args"]?.AsArray();
        Assert.NotNull(args);
        Assert.Contains("spring-boot:run", args!.Select(a => a?.ToString()));
    }

    [Fact]
    public async Task VerifyManifest_WithGradleTask()
    {
        using var builder = TestDistributedApplicationBuilder.Create().WithResourceCleanUp(true);
        using var tempDir = new TempJavaAppDirectory();

        var app = builder.AddJavaApp("api", tempDir.Path)
            .WithGradleTask("bootRun");

        var manifest = await ManifestUtils.GetManifest(app.Resource);

        var args = manifest?["args"]?.AsArray();
        Assert.NotNull(args);
        Assert.Contains("bootRun", args!.Select(a => a?.ToString()));
    }
}
