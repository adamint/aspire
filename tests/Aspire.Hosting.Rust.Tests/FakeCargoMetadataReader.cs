// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

/// <summary>
/// Answers <c>cargo metadata</c> queries from a canned document instead of shelling out to cargo, so tests
/// can exercise publishing and debugging on machines with no Rust toolchain installed.
/// </summary>
internal sealed class FakeCargoMetadataReader(string metadataJson) : ICargoMetadataReader
{
    public Task<CargoMetadata> ReadAsync(string appDirectory, string? manifestPath, string resourceName, CancellationToken cancellationToken)
        => Task.FromResult(CargoMetadata.Parse(metadataJson));
}
