// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.ApplicationModel;

/// <summary>
/// The outcome of resolving a single gathered argument, recorded one entry per occurrence so callers can
/// replay a resolution instead of repeating it.
/// </summary>
/// <param name="Unprocessed">The gathered argument, before resolution.</param>
/// <param name="Processed">The resolved value, or <see langword="null"/> when the argument resolved to null or failed.</param>
/// <param name="IsSensitive">Whether the resolved value is sensitive.</param>
/// <param name="Exception">The failure that occurred while resolving, or <see langword="null"/> when resolution succeeded.</param>
internal readonly record struct ArgumentResolution(object Unprocessed, string? Processed, bool IsSensitive, Exception? Exception);

/// <summary>
/// Represents the configuration (arguments and environment variables) to apply to a specific resource.
/// </summary>
internal sealed class ExecutionConfigurationResult : IExecutionConfigurationResult
{
    /// <inheritdoc/>
    public required IEnumerable<object> References { get; init; }

    /// <inheritdoc/>
    public required IEnumerable<(object Unprocessed, string Processed, bool IsSensitive)> ArgumentsWithUnprocessed { get; init; }

    /// <summary>
    /// Gets the outcome of every gathered argument, including the ones that resolved to null or failed and are
    /// therefore absent from <see cref="ArgumentsWithUnprocessed"/>.
    /// </summary>
    internal IReadOnlyList<ArgumentResolution> ArgumentResolutions { get; init; } = [];

    /// <inheritdoc/>
    public IEnumerable<(string Value, bool IsSensitive)> Arguments => ArgumentsWithUnprocessed.Select(arg => (arg.Processed, arg.IsSensitive));

    /// <inheritdoc/>
    public required IEnumerable<KeyValuePair<string, (object Unprocessed, string Processed)>> EnvironmentVariablesWithUnprocessed { get; init; }

    /// <summary>
    /// Gets the failures that occurred while resolving environment variables, kept separate from argument
    /// failures so a caller that rewrites the argument list can decide which failures still apply.
    /// </summary>
    internal IReadOnlyList<Exception> EnvironmentVariableExceptions { get; init; } = [];

    /// <inheritdoc/>
    public IEnumerable<KeyValuePair<string, string>> EnvironmentVariables => EnvironmentVariablesWithUnprocessed.Select(kvp => new KeyValuePair<string, string>(kvp.Key, kvp.Value.Processed));

    /// <inheritdoc/>
    public required IEnumerable<IExecutionConfigurationData> AdditionalConfigurationData { get; init; }

    /// <inheritdoc/>
    public Exception? Exception { get; init; }

    /// <summary>
    /// Builds the aggregate failure for a resolution, ordering argument failures before environment variable
    /// failures so the aggregate matches the order the values were resolved in.
    /// </summary>
    internal static Exception? CombineResolutionExceptions(IEnumerable<ArgumentResolution> argumentResolutions, IEnumerable<Exception> environmentVariableExceptions)
    {
        List<Exception> exceptions = [
            .. argumentResolutions.Select(resolution => resolution.Exception).OfType<Exception>(),
            .. environmentVariableExceptions];

        return exceptions.Count == 0
            ? null
            : new AggregateException("One or more errors occurred while resolving resource configuration.", exceptions);
    }

    /// <summary>
    /// Reads the per-occurrence argument resolutions from a result.
    /// </summary>
    /// <remarks>
    /// <see cref="IExecutionConfigurationResult"/> is public, so a result can come from an implementation that
    /// records only the arguments that resolved successfully. Reconstructing the resolutions from that public
    /// surface keeps such a result usable, at the cost of not knowing which arguments failed.
    /// </remarks>
    internal static IReadOnlyList<ArgumentResolution> GetArgumentResolutions(IExecutionConfigurationResult result)
    {
        return result is ExecutionConfigurationResult { ArgumentResolutions: var resolutions }
            ? resolutions
            : [.. result.ArgumentsWithUnprocessed.Select(argument => new ArgumentResolution(argument.Unprocessed, argument.Processed, argument.IsSensitive, Exception: null))];
    }

    /// <summary>
    /// Reads the environment variable failures from a result.
    /// </summary>
    /// <remarks>
    /// For an implementation that does not separate them, the whole failure is reported as an environment
    /// variable failure. That is the conservative choice: it keeps a failure that cannot be attributed to a
    /// specific argument rather than discarding it.
    /// </remarks>
    internal static IReadOnlyList<Exception> GetEnvironmentVariableExceptions(IExecutionConfigurationResult result)
    {
        return result switch
        {
            ExecutionConfigurationResult concrete => concrete.EnvironmentVariableExceptions,
            { Exception: { } exception } => [exception],
            _ => []
        };
    }
}
