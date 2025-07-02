// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting;

/// <summary>
/// A resource that represents a node application.
/// </summary>
public class NodeAppResource : ExecutableResource, IResourceWithServiceDiscovery
{
    /// <summary>
    /// A resource that represents a node application.
    /// </summary>
    /// <param name="name">The name of the resource.</param>
    /// <param name="command">The command to execute.</param>
    /// <param name="workingDirectory">The working directory to use for the command. If null, the working directory of the current process is used.</param>
    public NodeAppResource(string name, string command, string workingDirectory) : base(name, command, workingDirectory)
    {
#pragma warning disable ASPIREEXTENSION001
        Annotations.Add(new ExtensionRunnableResourceAnnotation());
#pragma warning restore ASPIREEXTENSION001
    }
}
