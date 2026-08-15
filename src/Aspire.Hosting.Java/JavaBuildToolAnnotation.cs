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
/// Records the name of a build-step resource created for a <see cref="JavaAppResource"/>.
/// </summary>
/// <remarks>
/// Kept on the application resource so <c>WithWrapperPath</c> can re-point build steps that were created
/// before the override was supplied, making the builder calls order-independent.
/// </remarks>
/// <param name="ResourceName">The name of the build-step resource.</param>
internal sealed record JavaBuildStepAnnotation(string ResourceName) : IResourceAnnotation;
