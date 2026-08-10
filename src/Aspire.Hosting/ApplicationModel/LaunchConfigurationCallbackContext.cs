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
/// Aspire creates a new context only when the resource's active debug-support annotation produces a launch
/// configuration for a specific executable creation, restart, or replica. This is not a general resource
/// lifecycle callback: the producer is not invoked when the annotation is inactive, unsupported by the
/// current debug session, or skipped because a
/// <see cref="ProjectLaunchArgsOverrideAnnotation"/> already supplied a <see cref="KnownLaunchConfigurationTypes.Project"/>
/// launch configuration.
/// The context is framework-owned and both execution snapshots are bound to <see cref="Resource"/> when Aspire
/// constructs it.
/// <see cref="OriginalExecutionConfiguration"/> contains the resolved resource configuration before an active
/// debug-support argument rewrite runs. <see cref="ExecutableExecutionConfiguration"/> contains the copy used to
/// populate the underlying executable after that rewrite. When a <see cref="ProjectLaunchArgsOverrideAnnotation"/>
/// pins a project executable to process execution, the debug argument rewrite is suppressed so the process command
/// line remains runnable. Only the launch configuration returned by the producer is serialized for the IDE.
/// <see cref="IExecutionConfigurationResult.Exception"/> on <see cref="OriginalExecutionConfiguration"/> can include
/// argument failures that the debug rewrite removed from <see cref="ExecutableExecutionConfiguration"/>; producers
/// should check it before copying values from the original snapshot.
/// Processed arguments and environment values can both contain secrets: <see cref="IExecutionConfigurationResult.Arguments"/>
/// carries an <c>IsSensitive</c> flag for exactly this reason, so a resolved parameter can arrive as an argument as
/// readily as an environment value. Anything a producer copies into the launch configuration is written to the IDE.
/// </remarks>
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
public sealed class LaunchConfigurationCallbackContext
{
    internal LaunchConfigurationCallbackContext(
        string mode,
        IResource resource,
        IExecutionConfigurationResult originalExecutionConfiguration,
        IExecutionConfigurationResult executableExecutionConfiguration,
        DistributedApplicationExecutionContext executionContext,
        ILogger? logger = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(mode);
        ArgumentNullException.ThrowIfNull(resource);
        ArgumentNullException.ThrowIfNull(originalExecutionConfiguration);
        ArgumentNullException.ThrowIfNull(executableExecutionConfiguration);
        ArgumentNullException.ThrowIfNull(executionContext);

        ValidateExecutionConfigurationResource(resource, originalExecutionConfiguration, nameof(originalExecutionConfiguration));
        ValidateExecutionConfigurationResource(resource, executableExecutionConfiguration, nameof(executableExecutionConfiguration));

        Mode = mode;
        Resource = resource;
        OriginalExecutionConfiguration = originalExecutionConfiguration;
        ExecutableExecutionConfiguration = executableExecutionConfiguration;
        ExecutionContext = executionContext;
        Logger = logger ?? NullLogger.Instance;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the requested launch mode, one of the values on <see cref="ExecutableLaunchMode"/>.
    /// </summary>
    public string Mode { get; }

    /// <summary>
    /// Gets the resource being launched.
    /// </summary>
    public IResource Resource { get; }

    /// <summary>
    /// Gets the resolved execution configuration before the active debug-support argument rewrite runs.
    /// </summary>
    /// <remarks>
    /// Processed environment values can contain secrets. Aspire serializes only the launch configuration
    /// returned by the producer; integrations should copy values from this result only when the IDE requires them.
    /// </remarks>
    public IExecutionConfigurationResult OriginalExecutionConfiguration { get; }

    /// <summary>
    /// Gets the resolved execution configuration used to populate the executable after the active debug-support argument rewrite runs.
    /// </summary>
    /// <remarks>
    /// This is a copy of <see cref="OriginalExecutionConfiguration"/> with the active <c>argsCallback</c> applied.
    /// When debug support does not rewrite arguments, or a project launch-args override keeps the executable in
    /// process mode, this is the same instance as <see cref="OriginalExecutionConfiguration"/>.
    /// </remarks>
    public IExecutionConfigurationResult ExecutableExecutionConfiguration { get; }

    /// <summary>
    /// Gets the execution context for the current AppHost invocation.
    /// </summary>
    public DistributedApplicationExecutionContext ExecutionContext { get; }

    /// <summary>
    /// Gets the resource logger for this executable creation.
    /// </summary>
    public ILogger Logger { get; }

    /// <summary>
    /// Gets the cancellation token for this executable creation.
    /// </summary>
    public CancellationToken CancellationToken { get; }

    private static void ValidateExecutionConfigurationResource(
        IResource resource,
        IExecutionConfigurationResult executionConfiguration,
        string parameterName)
    {
        if (executionConfiguration is not ExecutionConfigurationResult { Resource: var configurationResource })
        {
            throw new ArgumentException(
                $"The launch configuration callback context for resource '{resource.Name}' requires an execution configuration resolved by Aspire for that resource.",
                parameterName);
        }

        if (!ReferenceEquals(resource, configurationResource))
        {
            throw new ArgumentException(
                $"The execution configuration belongs to resource '{configurationResource.Name}', " +
                $"but the launch configuration callback context is being created for resource '{resource.Name}'.",
                parameterName);
        }
    }
}
