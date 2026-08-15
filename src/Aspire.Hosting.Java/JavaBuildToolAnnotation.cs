// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Java;

/// <summary>
/// Identifies the build tool that launches a <see cref="JavaAppResource"/>.
/// </summary>
internal enum JavaBuildTool
{
    /// <summary>Apache Maven, invoked through the <c>mvnw</c> wrapper.</summary>
    Maven,

    /// <summary>Gradle, invoked through the <c>gradlew</c> wrapper.</summary>
    Gradle
}

/// <summary>
/// Records that a Java application is launched through a build tool wrapper rather than through <c>java -jar</c>.
/// </summary>
/// <param name="tool">The build tool that launches the application.</param>
/// <param name="args">The arguments to pass to the build tool (the goal or task name, plus any extra arguments).</param>
internal sealed class JavaBuildToolAnnotation(JavaBuildTool tool, string[] args) : IResourceAnnotation
{
    /// <summary>
    /// The build tool that launches the application.
    /// </summary>
    public JavaBuildTool Tool { get; } = tool;

    /// <summary>
    /// The arguments to pass to the build tool.
    /// </summary>
    public string[] Args { get; } = args;
}

/// <summary>
/// Records how a <see cref="JavaAppResource"/> is built before it runs.
/// </summary>
/// <remarks>
/// Recorded in every execution context, not only where the build actually runs. In run mode the
/// <see cref="ResourceName"/> lets <c>WithWrapperPath</c> re-point a build step that was created before
/// the override was supplied, which is what makes the builder calls order-independent. In publish mode
/// there is no build-step resource, but the tool and arguments still describe how to produce a deployable
/// JAR and are what the generated Dockerfile runs.
/// </remarks>
/// <param name="ResourceName">The name of the build-step resource, or <see langword="null"/> outside run mode.</param>
/// <param name="Tool">The build tool that produces the artifact.</param>
/// <param name="Args">The arguments passed to the build tool.</param>
internal sealed record JavaBuildStepAnnotation(string? ResourceName, JavaBuildTool Tool, string[] Args) : IResourceAnnotation;
