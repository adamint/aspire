// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json.Serialization;
using Aspire.Hosting.ApplicationModel;

#pragma warning disable ASPIREEXTENSION001 // Launch configuration types are experimental.

namespace Aspire.Hosting.Java;

/// <summary>
/// The launch configuration handed to an IDE so it can run or debug a Java application itself,
/// rather than Aspire starting the process.
/// </summary>
/// <remarks>
/// <para>
/// The IDE always starts a JVM directly, even when the resource would otherwise be launched through
/// <c>mvnw spring-boot:run</c> or <c>gradlew bootRun</c>. Those wrappers fork a second JVM, so a debugger
/// attached to the wrapper process would never see application code. The build-tool invocation is declared
/// with <c>WithLaunchToolArgs(..., ownedByLaunchConfigurationType: "java")</c>, which drops those arguments
/// for exactly this launch configuration type while keeping them for normal process execution.
/// </para>
/// <para>
/// The property names match the <c>vscjava.vscode-java-debug</c> launch schema after the extension
/// translates them, and mirror the keys consumed by <c>extension/src/debugger/languages/java.ts</c>.
/// See https://github.com/microsoft/vscode-java-debug/blob/main/Configuration.md.
/// </para>
/// </remarks>
internal sealed class JavaLaunchConfiguration() : ExecutableLaunchConfiguration("java")
{
    /// <summary>
    /// The debug request type. Java applications are always launched by the IDE, never attached to.
    /// </summary>
    [JsonPropertyName("request")]
    public string Request { get; set; } = "launch";

    /// <summary>
    /// The working directory of the Java project. The IDE uses it as the debug session's working
    /// directory and to scope main class resolution to this resource's project.
    /// </summary>
    [JsonPropertyName("working_directory")]
    public string WorkingDirectory { get; set; } = string.Empty;

    /// <summary>
    /// The fully qualified main class, or the absolute path to an executable JAR whose manifest
    /// declares <c>Main-Class</c>. When omitted the IDE resolves the main class from the project's
    /// build files, and reports an actionable error if the project declares more than one.
    /// </summary>
    [JsonPropertyName("main_class")]
    public string? MainClass { get; set; }

    /// <summary>
    /// The build tool that owns the project, used by the IDE to refresh the project's classpath
    /// before starting a session. One of <c>maven</c>, <c>gradle</c>, or <see langword="null"/> when the
    /// application runs from a prebuilt JAR.
    /// </summary>
    [JsonPropertyName("build_tool")]
    public string? BuildTool { get; set; }
}
