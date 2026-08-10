// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Cli.Npm;

/// <summary>
/// Resolves the registry that npm would use to install a given package, following
/// npm's own configuration precedence.
/// </summary>
internal interface INpmRegistryResolver
{
    /// <summary>
    /// Gets the registry base address <c>npm install -g &lt;packageName&gt;</c> would resolve
    /// against. The global command is the one the update notice prints, and it is what makes the
    /// project <c>.npmrc</c> irrelevant here: a global install does not consult one.
    /// </summary>
    /// <param name="packageName">The npm package name (e.g., "@microsoft/aspire-cli").</param>
    NpmRegistryResolution Resolve(string packageName);
}

/// <summary>
/// The registry selected for a package, along with the configuration layer it came from.
/// </summary>
/// <param name="RegistryUri">
/// The registry base address. Always carries a trailing slash so it can be used directly as a
/// <see cref="Uri"/> base.
/// </param>
/// <param name="Source">
/// A human-readable description of the layer the value came from, for diagnostics
/// (e.g., "the npm_config_registry environment variable" or a <c>.npmrc</c> path).
/// </param>
internal sealed record NpmRegistryResolution(Uri RegistryUri, string Source)
{
    /// <summary>
    /// Gets the registry address with any embedded credentials removed, for logs and error
    /// messages.
    /// </summary>
    /// <remarks>
    /// npm accepts <c>https://user:token@host/</c> in a <c>.npmrc</c> <c>registry</c> value, so the
    /// resolved address is not automatically safe to print. Every message that names the registry
    /// must use this instead of <see cref="RegistryUri"/>.
    /// </remarks>
    public string DisplayUri { get; } = Redact(RegistryUri);

    /// <summary>
    /// Gets the registry address to compose requests from, with any embedded credentials removed.
    /// </summary>
    /// <remarks>
    /// <see cref="RegistryUri"/> keeps whatever npm resolved, credentials included, because that is
    /// the address npm itself would use. Requests are composed from this instead.
    /// </remarks>
    public Uri RequestUri { get; } = RemoveCredentials(RegistryUri);

    private static Uri RemoveCredentials(Uri registryUri)
    {
        // Drops the same two credential carriers Redact does - the "user:token@" authority and a
        // query token such as a SAS "?sv=...&sig=..." - so the property matches its documented
        // contract on its own. Relative composition in NpmRegistryClient happens to discard the
        // base query today, but this lookup is anonymous and the invariant has to hold for anything
        // that reads the property: the request URI stays readable on every delegating handler,
        // diagnostic listener, and exception message that reports the request.
        if (string.IsNullOrEmpty(registryUri.UserInfo)
            && string.IsNullOrEmpty(registryUri.Query)
            && string.IsNullOrEmpty(registryUri.Fragment))
        {
            return registryUri;
        }

        return new UriBuilder(registryUri)
        {
            UserName = string.Empty,
            Password = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty
        }.Uri;
    }

    private static string Redact(Uri registryUri)
    {
        // A registry address hides a credential in two places, so both are dropped: the
        // "user:token@" authority npm accepts in a .npmrc, and a query token such as the
        // "?sv=...&sig=..." of a SAS URL. PackageSourceRedactor applies exactly this rule to NuGet
        // feeds (see PackageSourceRedactor.RedactForDisplay); keeping the two consistent means one
        // display path cannot be safe while the other leaks. The fragment goes with them because
        // it is never part of a registry address and is trivially attacker- or user-supplied.
        if (string.IsNullOrEmpty(registryUri.UserInfo)
            && string.IsNullOrEmpty(registryUri.Query)
            && string.IsNullOrEmpty(registryUri.Fragment))
        {
            return registryUri.AbsoluteUri;
        }

        return new UriBuilder(registryUri)
        {
            UserName = string.Empty,
            Password = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty
        }.Uri.AbsoluteUri;
    }
}
