// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Represents a Bacon-based Rust application resource in the distributed application model.
/// </summary>
/// <param name="name">The name of the resource in the application model.</param>
/// <param name="workingDirectory">The working directory for the Rust application.</param>
[AspireExport(ExposeProperties = true)]
public class BaconAppResource(string name, string workingDirectory)
    : ExecutableResource(name, "bacon", workingDirectory), IResourceWithServiceDiscovery, IContainerFilesDestinationResource;
