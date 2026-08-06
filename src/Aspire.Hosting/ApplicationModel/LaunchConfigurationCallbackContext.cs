// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Hosting.ApplicationModel;

/// <summary>
/// Provides the runtime data used to create a launch configuration for a resource.
/// </summary>
/// <remarks>
/// Aspire creates a new context for each executable creation, including restarts and replicas.
/// <see cref="ExecutionConfiguration"/> is the same resolved configuration used to populate the
/// underlying executable's arguments and environment variables. Only the launch configuration returned
/// by the producer is serialized for the IDE. Processed environment values can contain secrets.
/// </remarks>
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
public sealed class LaunchConfigurationCallbackContext
{
    /// <summary>
    /// Gets the requested launch mode, one of the values on <see cref="ExecutableLaunchMode"/>.
    /// </summary>
    public required string Mode { get; init; }

    /// <summary>
    /// Gets the resource being launched.
    /// </summary>
    public required IResource Resource { get; init; }

    /// <summary>
    /// Gets the resolved execution configuration used for the executable.
    /// </summary>
    /// <remarks>
    /// Processed environment values can contain secrets. Aspire serializes only the launch configuration
    /// returned by the producer; integrations should copy values from this result only when the IDE requires them.
    /// </remarks>
    public required IExecutionConfigurationResult ExecutionConfiguration { get; init; }

    /// <summary>
    /// Gets the execution context for the current AppHost invocation.
    /// </summary>
    public required DistributedApplicationExecutionContext ExecutionContext { get; init; }

    /// <summary>
    /// Gets the resource logger for this executable creation.
    /// </summary>
    public ILogger Logger { get; init; } = NullLogger.Instance;

    /// <summary>
    /// Gets the cancellation token for this executable creation.
    /// </summary>
    public CancellationToken CancellationToken { get; init; }
}
