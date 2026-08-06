// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Semver;

namespace Aspire.Cli.Utils.EnvironmentChecker;

/// <summary>
/// Retrieves the latest stable Aspire VS Code extension version from the Marketplace.
/// </summary>
internal interface IVsCodeExtensionMarketplaceClient
{
    /// <summary>
    /// Gets the latest stable extension version.
    /// </summary>
    /// <param name="cancellationToken">A token to cancel the request.</param>
    /// <returns>The latest stable extension version.</returns>
    Task<SemVersion> GetLatestStableVersionAsync(CancellationToken cancellationToken);
}
