// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Utils.EnvironmentChecker;
using Semver;

namespace Aspire.Cli.Tests.Utils;

internal sealed class TestVsCodeExtensionMarketplaceClient : IVsCodeExtensionMarketplaceClient
{
    public required Func<CancellationToken, Task<SemVersion>> GetLatestStableVersionAsyncCallback { get; init; }

    public int CallCount { get; private set; }

    public Task<SemVersion> GetLatestStableVersionAsync(CancellationToken cancellationToken)
    {
        CallCount++;
        return GetLatestStableVersionAsyncCallback(cancellationToken);
    }
}
