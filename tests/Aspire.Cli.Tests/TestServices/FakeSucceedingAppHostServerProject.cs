// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Configuration;
using Aspire.Cli.Projects;

namespace Aspire.Cli.Tests.TestServices;

/// <summary>
/// <see cref="IAppHostServerProject"/> whose <see cref="PrepareAsync"/> returns success.
/// Used with a fake codegen session (<see cref="FakeAppHostServerSession"/> via an injected
/// <see cref="IAppHostServerSessionFactory"/>) that bypasses <see cref="AppHostServerSession"/>,
/// so <see cref="RunAsync"/> is never called.
/// </summary>
internal sealed class FakeSucceedingAppHostServerProject(string appDirectoryPath) : IAppHostServerProject, IDisposable
{
    public string AppDirectoryPath { get; } = appDirectoryPath;

    /// <summary>
    /// Package names this fake reports as satisfied by a repository project. Mirrors
    /// <see cref="DotNetBasedAppHostServerProject"/> in repository dev mode, where an
    /// <c>Aspire.Hosting.*</c> package reference is replaced by the matching project under
    /// <c>src/</c> and the requested package version is discarded.
    /// </summary>
    public Dictionary<string, LocalProjectSubstitution> LocalProjectSubstitutions { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Registers a substitution whose checkout builds <paramref name="checkoutVersionPrefix"/>, or
    /// whose version cannot be established when that is <see langword="null"/>.
    /// </summary>
    public void AddLocalProjectSubstitution(string packageName, string? checkoutVersionPrefix)
        => LocalProjectSubstitutions[packageName] = new LocalProjectSubstitution(
            Path.Combine("src", packageName, $"{packageName}.csproj"),
            checkoutVersionPrefix);

    public string GetInstanceIdentifier() => AppDirectoryPath;

    public LocalProjectSubstitution? GetLocalProjectSubstitution(string packageName)
        => LocalProjectSubstitutions.TryGetValue(packageName, out var substitution) ? substitution : null;

    public Task<AppHostServerPrepareResult> PrepareAsync(
        string sdkVersion,
        IEnumerable<IntegrationReference> integrations,
        string? requestedChannel = null,
        string? packageSourceOverride = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(new AppHostServerPrepareResult(Success: true, Output: null));

    public Task<AppHostServerRunResult> RunAsync(
        int hostPid,
        IReadOnlyDictionary<string, string>? environmentVariables,
        string[]? additionalArgs,
        bool debug,
        AppHostServerRunControl? runControl) =>
        throw new NotSupportedException("Run should not be invoked when using a fake codegen session.");

    public void Dispose()
    {
    }
}
