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
    /// Gets the registry base address <c>npm install &lt;packageName&gt;</c> would resolve against.
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
    /// <see cref="RegistryUri"/> keeps whatever npm resolved, including a <c>user:token@</c>
    /// authority, because that is the address npm itself would use. This lookup is anonymous, so
    /// requests are composed from this instead: even though the handler does not turn user info
    /// into an <c>Authorization</c> header, it stays readable on
    /// <see cref="System.Net.Http.HttpRequestMessage.RequestUri"/> for every delegating handler,
    /// diagnostic listener, and exception message that reports the request.
    /// </remarks>
    public Uri RequestUri { get; } = RemoveUserInfo(RegistryUri);

    private static Uri RemoveUserInfo(Uri registryUri)
    {
        if (string.IsNullOrEmpty(registryUri.UserInfo))
        {
            return registryUri;
        }

        return new UriBuilder(registryUri)
        {
            UserName = string.Empty,
            Password = string.Empty
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
