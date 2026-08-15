// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREDOCKERFILEBUILDER001

#pragma warning disable ASPIRECERTIFICATES001
#pragma warning disable ASPIREEXTENSION001 // WithDebugSupport and WithLaunchToolArgs are experimental but used internally for debug support.

using System.Diagnostics.CodeAnalysis;
using System.Formats.Asn1;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Java;
using Aspire.Hosting.Utils;

namespace Aspire.Hosting;

/// <summary>
/// Provides extension methods for adding Java applications to an <see cref="IDistributedApplicationBuilder"/>.
/// </summary>
public static class JavaHostingExtensions
{
    private const string JavaToolOptions = "JAVA_TOOL_OPTIONS";

    // The icon Java resources and their build steps show in the dashboard, matching
    // CommunityToolkit.Aspire.Hosting.Java so migrating users see the same thing.
    private const string JavaIconName = "DrinkCoffee";

    internal static readonly string s_defaultMavenWrapper = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "mvnw.cmd" : "mvnw";
    internal static readonly string s_defaultGradleWrapper = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "gradlew.bat" : "gradlew";

    /// <summary>
    /// Adds a Java application to the application model, launched with <c>java</c>.
    /// </summary>
    /// <param name="builder">The <see cref="IDistributedApplicationBuilder"/> to add the resource to.</param>
    /// <param name="name">The name of the resource.</param>
    /// <param name="workingDirectory">The working directory to use for the command. Relative paths are resolved against the AppHost directory.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="name"/> or <paramref name="workingDirectory"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <remarks>
    /// Combine with <see cref="WithMavenGoal{T}(IResourceBuilder{T}, string, string[])"/> or
    /// <see cref="WithGradleTask{T}(IResourceBuilder{T}, string, string[])"/> to run the application through a build tool,
    /// or use the overload that accepts a <c>jarPath</c> to run a prebuilt JAR with <c>java -jar</c>.
    /// Exactly one of those three launch modes must be configured.
    /// </remarks>
    /// <example>
    /// Run a Spring Boot application through the Maven wrapper:
    /// <code language="csharp">
    /// var builder = DistributedApplication.CreateBuilder(args);
    ///
    /// builder.AddJavaApp("catalog", "../catalog")
    ///        .WithMavenGoal("spring-boot:run")
    ///        .WithHttpEndpoint(env: "SERVER_PORT")
    ///        .WithHttpHealthCheck("/actuator/health");
    ///
    /// builder.Build().Run();
    /// </code>
    /// </example>
    [AspireExport]
    public static IResourceBuilder<JavaAppResource> AddJavaApp(
        this IDistributedApplicationBuilder builder,
        [ResourceName] string name,
        string workingDirectory)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(workingDirectory);

        // Accept both slash styles so an AppHost authored on Windows resolves the same paths on Linux.
        workingDirectory = PathNormalizer.NormalizePathForCurrentPlatform(
            Path.Combine(builder.AppHostDirectory, workingDirectory));

        var resource = new JavaAppResource(name, workingDirectory);

        return builder.AddResource(resource)
            .WithIconName(JavaIconName)
            .WithRequiredCommand("java", "https://adoptium.net/")
            // Declared as launch tool arguments rather than through WithArgs for two reasons: they are
            // pinned ahead of any caller-supplied WithArgs no matter the order the builder methods are
            // called in, and they are omitted when an IDE launches the resource through a "java" launch
            // configuration, which starts the JVM directly instead of going through the build tool.
            .WithLaunchToolArgs(ctx => AddLaunchArgs(resource, ctx), ownedByLaunchConfigurationType: "java")
            .WithOtlpExporter()
            .WithCertificateTrustConfiguration(JavaCertificateTrustCallback)
            .WithVSCodeDebugging()
            .PublishAsDockerFile(containerBuilder =>
            {
                // An authored Dockerfile in the application directory is the author's deployment contract.
                // Generating over it would silently discard base image pins, extra runtime packages, and
                // anything else the project depends on.
                if (File.Exists(Path.Combine(workingDirectory, "Dockerfile")))
                {
                    return;
                }

                containerBuilder.WithDockerfileBuilder(
                    workingDirectory,
                    ctx => JavaDockerfileGenerator.Write(resource, workingDirectory, ctx));
            });
    }

    /// <summary>
    /// Adds a Java application that runs a prebuilt JAR with <c>java -jar</c>.
    /// </summary>
    /// <param name="builder">The <see cref="IDistributedApplicationBuilder"/> to add the resource to.</param>
    /// <param name="name">The name of the resource.</param>
    /// <param name="workingDirectory">The working directory for the Java application. Relative paths are resolved against the AppHost directory.</param>
    /// <param name="jarPath">The path to the JAR file to execute. Relative paths are resolved against <paramref name="workingDirectory"/>.</param>
    /// <param name="args">Optional arguments passed to the Java application after the JAR path.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="name"/>, <paramref name="workingDirectory"/>, or <paramref name="jarPath"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <example>
    /// Build the JAR with Maven, then run it:
    /// <code language="csharp">
    /// builder.AddJavaApp("worker", "../worker", "target/worker.jar")
    ///        .WithMavenBuild();
    /// </code>
    /// </example>
    [AspireExport("addJavaAppWithJar")]
    public static IResourceBuilder<JavaAppResource> AddJavaApp(
        this IDistributedApplicationBuilder builder,
        [ResourceName] string name,
        string workingDirectory,
        string jarPath,
        string[]? args = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(workingDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(jarPath);

        var rb = builder.AddJavaApp(name, workingDirectory);

        rb.WithAnnotation(
            // Only the separators are normalized. The path is deliberately not made absolute: the process
            // runs with the working directory as its cwd, so a relative path resolves correctly at
            // runtime, and keeping it relative keeps the published manifest free of machine-specific paths.
            new JavaJarPathAnnotation(jarPath.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar)),
            ResourceAnnotationMutationBehavior.Replace);

        if (args is { Length: > 0 })
        {
            rb.WithArgs(args);
        }

        return rb;
    }

    /// <summary>
    /// Launches the Java application through a Maven goal instead of <c>java</c>, for example <c>spring-boot:run</c>.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder for the Java application.</param>
    /// <param name="goal">The Maven goal to execute.</param>
    /// <param name="args">Additional arguments passed to the Maven wrapper after the goal.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> or <paramref name="args"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="goal"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <exception cref="InvalidOperationException">The application is already configured to run a prebuilt JAR or a Gradle task.</exception>
    /// <remarks>
    /// The wrapper defaults to <c>mvnw</c> (<c>mvnw.cmd</c> on Windows) in the resource's working directory
    /// and can be overridden with <see cref="WithWrapperPath{T}(IResourceBuilder{T}, string)"/>.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithMavenGoal<T>(
        this IResourceBuilder<T> builder,
        string goal,
        params string[] args) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(goal);
        ArgumentNullException.ThrowIfNull(args);

        return builder.WithBuildToolLaunch(JavaBuildTool.Maven, goal, args, nameof(WithMavenGoal));
    }

    /// <summary>
    /// Launches the Java application through a Gradle task instead of <c>java</c>, for example <c>bootRun</c>.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder for the Java application.</param>
    /// <param name="task">The Gradle task to execute.</param>
    /// <param name="args">Additional arguments passed to the Gradle wrapper after the task.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> or <paramref name="args"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="task"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <exception cref="InvalidOperationException">The application is already configured to run a prebuilt JAR or a Maven goal.</exception>
    /// <remarks>
    /// The wrapper defaults to <c>gradlew</c> (<c>gradlew.bat</c> on Windows) in the resource's working
    /// directory and can be overridden with <see cref="WithWrapperPath{T}(IResourceBuilder{T}, string)"/>.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithGradleTask<T>(
        this IResourceBuilder<T> builder,
        string task,
        params string[] args) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(task);
        ArgumentNullException.ThrowIfNull(args);

        return builder.WithBuildToolLaunch(JavaBuildTool.Gradle, task, args, nameof(WithGradleTask));
    }

    private static IResourceBuilder<T> WithBuildToolLaunch<T>(
        this IResourceBuilder<T> builder,
        JavaBuildTool tool,
        string goalOrTask,
        string[] args,
        string methodName) where T : JavaAppResource
    {
        // A prebuilt JAR and a build-tool launch are mutually exclusive: the build tool decides what to
        // run, so -jar would be ignored. CommunityToolkit rejects both combinations; this port only
        // rejected the Gradle half, letting a Maven+JAR application silently drop its JAR.
        if (builder.Resource.HasAnnotationOfType<JavaJarPathAnnotation>())
        {
            throw new InvalidOperationException(
                $"{methodName} cannot be used when a JAR path has been specified. Use either the " +
                $"{nameof(AddJavaApp)} overload that takes a jarPath, or {methodName}, not both.");
        }

        if (builder.Resource.TryGetLastAnnotation<JavaBuildToolAnnotation>(out var existing) && existing.Tool != tool)
        {
            throw new InvalidOperationException(
                $"{methodName} cannot be used when the application is already configured to launch with " +
                $"{existing.Tool}. A Java application is launched by a single build tool.");
        }

        builder.WithAnnotation(
            new JavaBuildToolAnnotation(tool, args.Length > 0 ? [goalOrTask, .. args] : [goalOrTask]),
            ResourceAnnotationMutationBehavior.Replace);

        // Set the command in every execution context. Setting it only in run mode left publish emitting
        // "java" as the command while the goal was still contributed as an argument, producing the
        // uninvokable command line "java spring-boot:run".
        return builder.WithCommand(ResolveWrapperPath(builder.Resource, tool));
    }

    /// <summary>
    /// Runs a Maven build before the Java application starts.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder for the Java application.</param>
    /// <param name="args">Arguments passed to the Maven wrapper. Defaults to <c>clean package</c>.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> or <paramref name="args"/> is <see langword="null"/>.</exception>
    /// <remarks>
    /// The build step is a child resource that the application waits for. It is created only in run mode:
    /// when publishing, the generated container image performs the build, so a host-side build step would
    /// build the application twice.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithMavenBuild<T>(
        this IResourceBuilder<T> builder,
        params string[] args) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(args);

        return builder.WithJavaBuildStep(
            JavaBuildTool.Maven,
            buildResourceName: $"{builder.Resource.Name}-maven-build",
            createResource: static (name, wrapperScript, workingDirectory) => new MavenBuildResource(name, wrapperScript, workingDirectory),
            buildArgs: args.Length > 0 ? args : ["clean", "package"]);
    }

    /// <summary>
    /// Runs a Gradle build before the Java application starts.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder for the Java application.</param>
    /// <param name="args">Arguments passed to the Gradle wrapper. Defaults to <c>clean build</c>.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> or <paramref name="args"/> is <see langword="null"/>.</exception>
    /// <remarks>
    /// The build step is a child resource that the application waits for. It is created only in run mode:
    /// when publishing, the generated container image performs the build, so a host-side build step would
    /// build the application twice.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithGradleBuild<T>(
        this IResourceBuilder<T> builder,
        params string[] args) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(args);

        return builder.WithJavaBuildStep(
            JavaBuildTool.Gradle,
            buildResourceName: $"{builder.Resource.Name}-gradle-build",
            createResource: static (name, wrapperScript, workingDirectory) => new GradleBuildResource(name, wrapperScript, workingDirectory),
            buildArgs: args.Length > 0 ? args : ["clean", "build"]);
    }

    private static IResourceBuilder<T> WithJavaBuildStep<T, TBuildResource>(
        this IResourceBuilder<T> builder,
        JavaBuildTool tool,
        string buildResourceName,
        Func<string, string, string, TBuildResource> createResource,
        string[] buildArgs)
        where T : JavaAppResource
        where TBuildResource : ExecutableResource
    {
        // Building with both tools would produce two artifacts and leave the container build with no way
        // to choose between them, so it is rejected the same way conflicting launch modes are.
        if (builder.Resource.TryGetLastAnnotation<JavaBuildStepAnnotation>(out var existing) && existing.Tool != tool)
        {
            throw new InvalidOperationException(
                $"Resource '{builder.Resource.Name}' is already configured to build with {existing.Tool}. " +
                $"Call either WithMavenBuild or WithGradleBuild, not both.");
        }

        // Recorded in every execution context: in publish mode there is no build-step resource, but the
        // generated Dockerfile still runs this tool and these arguments to produce the deployable JAR.
        builder.WithAnnotation(
            new JavaBuildStepAnnotation(
                builder.ApplicationBuilder.ExecutionContext.IsRunMode ? buildResourceName : null,
                tool,
                buildArgs),
            ResourceAnnotationMutationBehavior.Replace);

        if (!builder.ApplicationBuilder.ExecutionContext.IsRunMode)
        {
            return builder;
        }

        // Calling the same method twice must not add a second resource under the same name. The
        // annotation was just replaced, and the arguments are read from it on every run, so the existing
        // resource already reflects the new arguments.
        if (existing is not null)
        {
            return builder;
        }

        var resource = builder.Resource;
        var buildResource = createResource(buildResourceName, ResolveWrapperPath(resource, tool), resource.WorkingDirectory);

        var buildBuilder = builder.ApplicationBuilder.AddResource(buildResource)
            .WithArgs(ctx =>
            {
                if (resource.TryGetLastAnnotation<JavaBuildStepAnnotation>(out var buildStep))
                {
                    foreach (var arg in buildStep.Args)
                    {
                        ctx.Args.Add(arg);
                    }
                }
            })
            .WithIconName(JavaIconName)
            .WithParentRelationship(resource)
            .ExcludeFromManifest();

        return builder.WaitForCompletion(buildBuilder);
    }

    /// <summary>
    /// Overrides the build tool wrapper script path, for repositories whose wrapper is not in the
    /// default location or does not use the default name.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The <see cref="IResourceBuilder{T}"/> to configure.</param>
    /// <param name="wrapperScript">The path to the wrapper script, absolute or relative to the resource's working directory.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="wrapperScript"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <remarks>
    /// May be called before or after the build tool is configured. A later call re-points anything that
    /// already resolved the default wrapper, so the result does not depend on the order of builder calls.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithWrapperPath<T>(
        this IResourceBuilder<T> builder,
        string wrapperScript) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(wrapperScript);

        var wrapperPath = PathNormalizer.NormalizePathForCurrentPlatform(
            Path.Combine(builder.Resource.WorkingDirectory, wrapperScript));

        builder.WithAnnotation(new WrapperAnnotation(wrapperPath), ResourceAnnotationMutationBehavior.Replace);

        // Re-point anything that already captured the default wrapper. Without this, calling
        // WithWrapperPath after WithMavenGoal was silently ignored.
        if (builder.Resource.HasAnnotationOfType<JavaBuildToolAnnotation>())
        {
            builder.WithCommand(wrapperPath);
        }

        foreach (var buildStep in builder.Resource.Annotations.OfType<JavaBuildStepAnnotation>())
        {
            // Null outside run mode, where no build-step resource is created.
            if (buildStep.ResourceName is not { } buildStepName)
            {
                continue;
            }

            var buildResource = builder.ApplicationBuilder.Resources
                .OfType<ExecutableResource>()
                .FirstOrDefault(r => string.Equals(r.Name, buildStepName, StringComparisons.ResourceName));

            if (buildResource is not null)
            {
                builder.ApplicationBuilder.CreateResourceBuilder(buildResource).WithCommand(wrapperPath);
            }
        }

        return builder;
    }

    /// <summary>
    /// Sets the class the IDE launches when running or debugging the application.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder for the Java application.</param>
    /// <param name="mainClass">The fully qualified name of the class declaring <c>main</c>, for example <c>com.example.Application</c>.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="mainClass"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <remarks>
    /// Only affects IDE execution. When omitted, the IDE resolves the main class from the project's build
    /// files; set it explicitly when a project declares more than one class with a <c>main</c> method.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithMainClass<T>(
        this IResourceBuilder<T> builder,
        string mainClass) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(mainClass);

        return builder.WithAnnotation(new JavaMainClassAnnotation(mainClass), ResourceAnnotationMutationBehavior.Replace);
    }

    /// <summary>
    /// Selects the JAR the generated container image runs, for projects whose build produces more than one.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder for the Java application.</param>
    /// <param name="relativePath">The path to the JAR produced by the build, relative to the application directory, for example <c>target/app.jar</c>.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="relativePath"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <remarks>
    /// Only affects publishing. Without it the container build selects the single JAR that is not a
    /// <c>-plain</c>, <c>-sources</c>, or <c>-javadoc</c> artifact, and fails the build if that is ambiguous.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithJarArtifact<T>(
        this IResourceBuilder<T> builder,
        string relativePath) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);

        return builder.WithAnnotation(new JavaJarArtifactAnnotation(relativePath), ResourceAnnotationMutationBehavior.Replace);
    }

    /// <summary>
    /// Adds arguments to the Java Virtual Machine that runs the application.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="args">The JVM arguments, for example <c>-Xmx512m</c>.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> or <paramref name="args"/> is <see langword="null"/>.</exception>
    /// <remarks>
    /// Arguments are passed through the <c>JAVA_TOOL_OPTIONS</c> environment variable, which the JVM reads
    /// however it was started — <c>java -jar</c>, a Maven goal, or a Gradle task, including the JVM those
    /// build tools fork. Values containing spaces are quoted, because the JVM splits this variable on
    /// whitespace.
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithJvmArgs<T>(
        this IResourceBuilder<T> builder,
        params string[] args) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(args);

        if (args.Length == 0)
        {
            return builder;
        }

        return builder.WithEnvironment(context => AppendJavaToolOptions(context.EnvironmentVariables, args));
    }

    /// <summary>
    /// Runs the application with the OpenTelemetry Java agent so it exports traces, metrics, and logs to Aspire.
    /// </summary>
    /// <typeparam name="T">The Java application resource type.</typeparam>
    /// <param name="builder">The resource builder.</param>
    /// <param name="agentPath">The path to the <c>opentelemetry-javaagent.jar</c> file.</param>
    /// <returns>A reference to the <see cref="IResourceBuilder{T}"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="builder"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException"><paramref name="agentPath"/> is <see langword="null"/>, empty, or whitespace.</exception>
    /// <remarks>
    /// The agent is not downloaded. Obtain it as a build dependency, or from
    /// https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases, and point this at the
    /// resulting file. The OTLP exporter is configured by <c>AddJavaApp</c> regardless of whether an agent
    /// is used, so call this only when you want the agent's automatic instrumentation.
    /// <para>
    /// A relative <paramref name="agentPath"/> is resolved against the application directory and made absolute
    /// when running locally. This is required, not cosmetic: <c>JAVA_TOOL_OPTIONS</c> is inherited by every JVM
    /// started beneath the resource, and build tools start JVMs whose working directory is not the application
    /// directory. The Gradle daemon, for example, starts from its own distribution directory, so a relative
    /// <c>-javaagent:</c> path fails to resolve and the daemon dies during VM initialization with
    /// "Error opening zip file or JAR manifest missing".
    /// </para>
    /// <para>
    /// In publish mode a relative path is rewritten to the location the generated Dockerfile copies the
    /// agent to, because the path has to be interpreted inside the container rather than on the build
    /// machine. An absolute path is emitted unchanged, since it cannot have come from the build context
    /// and must be supplied by the base image or a mount.
    /// </para>
    /// </remarks>
    [AspireExport]
    public static IResourceBuilder<T> WithOtelAgent<T>(
        this IResourceBuilder<T> builder,
        string agentPath) where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(agentPath);

        // Recorded so the container build can copy the agent forward. The environment variable alone
        // would leave a published image pointing at a JAR that is not in it.
        builder.WithAnnotation(new JavaOtelAgentAnnotation(agentPath), ResourceAnnotationMutationBehavior.Replace);

        return builder.WithEnvironment(context =>
        {
            string resolved;

            if (context.ExecutionContext.IsRunMode)
            {
                resolved = Path.GetFullPath(Path.Combine(builder.Resource.WorkingDirectory, agentPath));
            }
            else if (JavaDockerfileGenerator.TryGetBuildProducedAgentPath(builder.Resource, out _))
            {
                resolved = JavaDockerfileGenerator.ContainerAgentPath;
            }
            else
            {
                resolved = agentPath;
            }

            AppendJavaToolOptions(context.EnvironmentVariables, [$"-javaagent:{resolved}"]);
        });
    }

    /// <summary>
    /// Contributes the arguments that turn the resource's command into a complete invocation:
    /// <c>-jar &lt;path&gt;</c> for a prebuilt JAR, or the goal/task for a build tool launch.
    /// </summary>
    private static void AddLaunchArgs(JavaAppResource resource, CommandLineArgsCallbackContext ctx)
    {
        if (resource.TryGetLastAnnotation<JavaBuildToolAnnotation>(out var buildTool))
        {
            foreach (var arg in buildTool.Args)
            {
                ctx.Args.Add(arg);
            }

            return;
        }

        if (resource.TryGetLastAnnotation<JavaJarPathAnnotation>(out var jar))
        {
            ctx.Args.Add("-jar");
            ctx.Args.Add(jar.JarPath);

            return;
        }

        // Reached when AddJavaApp was called without a jar path and without a Maven goal or Gradle task.
        // The resource would otherwise start as a bare "java" with no arguments, which prints the JVM
        // usage text and exits.
        throw new InvalidOperationException(
            $"Java application '{resource.Name}' has no launch mode configured. Call {nameof(WithMavenGoal)} " +
            $"or {nameof(WithGradleTask)} to run it through a build tool, or use the {nameof(AddJavaApp)} " +
            "overload that takes a jarPath to run a prebuilt JAR.");
    }

    /// <summary>
    /// Resolves the wrapper script for <paramref name="tool"/>, honouring an override set by
    /// <see cref="WithWrapperPath{T}(IResourceBuilder{T}, string)"/>.
    /// </summary>
    private static string ResolveWrapperPath(JavaAppResource resource, JavaBuildTool tool)
    {
        if (resource.TryGetLastAnnotation<WrapperAnnotation>(out var wrapper))
        {
            return wrapper.WrapperPath;
        }

        var wrapperName = tool switch
        {
            JavaBuildTool.Maven => s_defaultMavenWrapper,
            JavaBuildTool.Gradle => s_defaultGradleWrapper,
            _ => throw new ArgumentOutOfRangeException(nameof(tool), tool, null)
        };

        return PathNormalizer.NormalizePathForCurrentPlatform(Path.Combine(resource.WorkingDirectory, wrapperName));
    }

    /// <summary>
    /// Appends <paramref name="values"/> to the <c>JAVA_TOOL_OPTIONS</c> environment variable, preserving
    /// whatever is already there.
    /// </summary>
    /// <remarks>
    /// The existing value may be any expression Aspire supports — a plain string, a
    /// <see cref="ReferenceExpression"/>, a parameter, or an endpoint reference — so a non-string value is
    /// folded into a new <see cref="ReferenceExpression"/> rather than being read as a string. An earlier
    /// string-only implementation silently discarded non-string values.
    /// </remarks>
    private static void AppendJavaToolOptions(Dictionary<string, object> environmentVariables, string[] values)
    {
        var appended = string.Join(' ', values.Select(QuoteIfNeeded));

        if (!environmentVariables.TryGetValue(JavaToolOptions, out var existing) || existing is null)
        {
            environmentVariables[JavaToolOptions] = appended;
            return;
        }

        environmentVariables[JavaToolOptions] = existing switch
        {
            string s when string.IsNullOrEmpty(s) => appended,
            string s => $"{s} {appended}",
            ReferenceExpression re => ReferenceExpression.Create($"{re} {appended}"),
            IValueProvider valueProvider when existing is IManifestExpressionProvider manifestProvider
                => ReferenceExpression.Create($"{new ComposableValue(valueProvider, manifestProvider)} {appended}"),
            // Anything else is a plain value (a number, a bool, a string-convertible object) that the
            // environment layer would format the same way.
            _ => $"{existing} {appended}"
        };
    }

    /// <summary>
    /// Pairs the two facets Aspire needs to compose a value into a <see cref="ReferenceExpression"/>.
    /// </summary>
    /// <remarks>
    /// <see cref="ReferenceExpression.ExpressionInterpolatedStringHandler.AppendFormatted{T}(T)"/> is
    /// constrained to a single type implementing both interfaces, which a value typed as <c>object</c>
    /// cannot satisfy without this adapter.
    /// </remarks>
    private sealed class ComposableValue(IValueProvider valueProvider, IManifestExpressionProvider manifestExpressionProvider)
        : IValueProvider, IManifestExpressionProvider
    {
        public string ValueExpression => manifestExpressionProvider.ValueExpression;

        public ValueTask<string?> GetValueAsync(CancellationToken cancellationToken) => valueProvider.GetValueAsync(cancellationToken);
    }

    /// <summary>
    /// Quotes a JVM option whose value contains whitespace.
    /// </summary>
    /// <remarks>
    /// The JVM tokenizes <c>JAVA_TOOL_OPTIONS</c> on whitespace, so an unquoted
    /// <c>-Djavax.net.ssl.trustStore=C:\Users\First Last\AppData\...\bundle.p12</c> arrives as two
    /// unrelated options and TLS fails with no useful diagnostic. Only the value after the first
    /// <c>=</c> is quoted, because the JVM does not accept a quoted <c>-Dkey=value</c> as a whole.
    /// </remarks>
    private static string QuoteIfNeeded(string option)
    {
        if (!option.Any(char.IsWhiteSpace) || option.Contains('"'))
        {
            return option;
        }

        var separatorIndex = option.IndexOf('=');

        return separatorIndex < 0
            ? $"\"{option}\""
            : $"{option[..(separatorIndex + 1)]}\"{option[(separatorIndex + 1)..]}\"";
    }

    /// <summary>
    /// Builds a PKCS#12 trust store containing Aspire's development certificate and any configured
    /// certificate authorities, and points the JVM at it through <c>JAVA_TOOL_OPTIONS</c>.
    /// </summary>
    /// <remarks>
    /// The JVM ignores the <c>SSL_CERT_DIR</c> and <c>SSL_CERT_FILE</c> variables Aspire sets for other
    /// languages, so without this a Java application fails to export telemetry over HTTPS with
    /// <c>PKIX path building failed</c>. See https://github.com/CommunityToolkit/Aspire/issues/1517.
    /// </remarks>
    private static async Task JavaCertificateTrustCallback(CertificateTrustConfigurationCallbackAnnotationContext ctx)
    {
        var bundlePath = ctx.CreateCustomBundle((certificates, ct) =>
        {
            var pkcs12Builder = new Pkcs12Builder();
            var safeContents = new Pkcs12SafeContents();

            // Oracle/OpenJDK trusted cert bag attribute OID. Without it the JDK reads the entries as
            // key entry candidates rather than trustedCertEntry, and the store trusts nothing.
            // See sun.security.pkcs12.PKCS12KeyStore in the OpenJDK sources.
            var trustAnchorOid = new Oid("2.16.840.1.113894.746875.1.1");
            var asnWriter = new AsnWriter(AsnEncodingRules.DER);
            asnWriter.WriteObjectIdentifier("2.5.29.37.0"); // anyExtendedKeyUsage
            var trustAnchorValue = asnWriter.Encode();

            for (var i = 0; i < certificates.Count; i++)
            {
                // Re-import the public part only so no private key can reach the trust store.
                using var publicCert = X509CertificateLoader.LoadCertificate(certificates[i].Export(X509ContentType.Cert));
                var certBag = safeContents.AddCertificate(publicCert);
                certBag.Attributes.Add(
                    new CryptographicAttributeObject(
                        trustAnchorOid,
                        new AsnEncodedDataCollection(new AsnEncodedData(trustAnchorOid, trustAnchorValue))));
            }

            pkcs12Builder.AddSafeContentsUnencrypted(safeContents);

            // Sealed with an empty password on purpose. The MAC still protects integrity, and a trust
            // store holds only public certificates, so a password would protect nothing while appearing
            // in JAVA_TOOL_OPTIONS — which the dashboard shows unmasked, which every process the build
            // tool forks inherits, and which the JVM itself echoes to stderr as
            // "Picked up JAVA_TOOL_OPTIONS: ...".
            pkcs12Builder.SealWithMac(string.Empty, HashAlgorithmName.SHA256, iterationCount: 2048);

            return Task.FromResult(pkcs12Builder.Encode());
        });

        var bundlePathValue = await bundlePath.GetValueAsync(ctx.CancellationToken).ConfigureAwait(false);

        if (string.IsNullOrEmpty(bundlePathValue))
        {
            return;
        }

        AppendJavaToolOptions(
            ctx.EnvironmentVariables,
            [
                $"-Djavax.net.ssl.trustStore={bundlePathValue}",
                "-Djavax.net.ssl.trustStoreType=PKCS12"
            ]);
    }

    [Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
    internal static IResourceBuilder<T> WithVSCodeDebugging<T>(this IResourceBuilder<T> builder)
        where T : JavaAppResource
    {
        ArgumentNullException.ThrowIfNull(builder);

        return builder.WithDebugSupport(
            mode => new JavaLaunchConfiguration
            {
                Mode = mode,
                WorkingDirectory = builder.Resource.WorkingDirectory,
                MainClass = ResolveMainClassForIde(builder.Resource),
                BuildTool = builder.Resource.TryGetLastAnnotation<JavaBuildToolAnnotation>(out var buildTool)
                    ? buildTool.Tool.ToString().ToLowerInvariant()
                    : null
            },
            "java");
    }

    /// <summary>
    /// Determines what the IDE should launch, or <see langword="null"/> to let it resolve the main class
    /// from the project's build files.
    /// </summary>
    private static string? ResolveMainClassForIde(JavaAppResource resource)
    {
        if (resource.TryGetLastAnnotation<JavaMainClassAnnotation>(out var mainClass))
        {
            return mainClass.MainClass;
        }

        // The Java debug adapter accepts a path to an executable JAR wherever it accepts a main class,
        // and reads Main-Class from the archive's manifest itself.
        // See https://github.com/microsoft/vscode-java-debug/blob/main/Configuration.md.
        // Resolved to an absolute path here because the adapter reads the archive before the debuggee's
        // working directory exists. Path.Combine returns jar.JarPath unchanged when it is already absolute.
        return resource.TryGetLastAnnotation<JavaJarPathAnnotation>(out var jar)
            ? Path.GetFullPath(Path.Combine(resource.WorkingDirectory, jar.JarPath))
            : null;
    }
}

#pragma warning restore ASPIREDOCKERFILEBUILDER001
