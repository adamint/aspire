// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Hosting.Tests.Utils;

public static class LaunchConfigurationTestHelpers
{
    public static LaunchConfigurationCallbackContext CreateCallbackContext(
        IResource resource,
        string mode = ExecutableLaunchMode.Debug,
        IExecutionConfigurationResult? executionConfiguration = null,
        DistributedApplicationExecutionContext? executionContext = null,
        ILogger? logger = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(resource);

        executionConfiguration ??= CreateExecutionConfigurationResult();
        return new LaunchConfigurationCallbackContext(
            mode,
            resource,
            executionConfiguration,
            executionConfiguration,
            executionContext ?? new DistributedApplicationExecutionContext(DistributedApplicationOperation.Run),
            logger ?? NullLogger.Instance,
            cancellationToken);
    }

    /// <summary>
    /// Invokes <paramref name="resource"/>'s launch configuration producer.
    /// </summary>
    /// <remarks>
    /// The underlying <c>CreateLaunchConfigurationAsync</c> overload is internal because the only legal caller is
    /// the resource's own producer, so it exists for tests and for hosting integrations that ship inside this
    /// repository. This wrapper lives in <c>Aspire.Hosting.TestUtilities</c> -- which already has
    /// <c>InternalsVisibleTo</c> from <c>Aspire.Hosting</c> -- so test projects can reach it without each one
    /// taking its own <c>InternalsVisibleTo</c> grant. Granting it directly to an integration's test project makes
    /// the internal types that integration links from <c>Aspire.Hosting</c> (for example <c>KnownResourceNames</c>)
    /// visible from two assemblies at once and breaks the build with CS0433.
    /// </remarks>
    public static Task<object> InvokeLaunchConfigurationProducerAsync(
        IResource resource,
        LaunchConfigurationCallbackContext callbackContext)
    {
        ArgumentNullException.ThrowIfNull(resource);
        ArgumentNullException.ThrowIfNull(callbackContext);

        return resource.CreateLaunchConfigurationAsync(callbackContext);
    }

    public static IExecutionConfigurationResult CreateExecutionConfigurationResult(
        IEnumerable<string>? arguments = null,
        IEnumerable<KeyValuePair<string, string>>? environmentVariables = null,
        Exception? exception = null)
    {
        return new ExecutionConfigurationResult
        {
            References = [],
            ArgumentsWithUnprocessed = (arguments ?? [])
                .Select(value => ((object)value, value, false))
                .ToArray(),
            EnvironmentVariablesWithUnprocessed = (environmentVariables ?? [])
                .Select(pair => new KeyValuePair<string, (object Unprocessed, string Processed)>(
                    pair.Key,
                    (pair.Value, pair.Value)))
                .ToArray(),
            AdditionalConfigurationData = [],
            Exception = exception
        };
    }
}
