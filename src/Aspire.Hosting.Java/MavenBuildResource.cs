// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Java;

/// <summary>
/// A resource that represents a Maven build step that runs before its parent Java application starts.
/// </summary>
/// <param name="name">The name of the resource.</param>
/// <param name="wrapperScript">The full path to the Maven wrapper script.</param>
/// <param name="workingDirectory">The working directory to use for the command.</param>
internal sealed class MavenBuildResource(string name, string wrapperScript, string workingDirectory)
    : ExecutableResource(name, wrapperScript, workingDirectory);
