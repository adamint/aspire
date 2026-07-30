// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;

namespace Aspire.Hosting.Rust.Tests;

/// <summary>
/// Answers <c>cargo metadata</c> queries from a canned document instead of shelling out to cargo, so tests
/// can exercise publishing and debugging on machines with no Rust toolchain installed.
/// </summary>
/// <param name="metadataJson">The document to answer with.</param>
/// <param name="workspaceRootRelativePath">
/// Where the workspace's root manifest sits relative to the app directory. Real cargo reports absolute host
/// paths, and publishing turns the workspace root into the container's target directory, so the canned
/// document's placeholder root is rebased onto the directory the reader is actually asked about.
/// </param>
internal sealed class FakeCargoMetadataReader(string metadataJson, string workspaceRootRelativePath = ".") : ICargoMetadataReader
{
    public Task<CargoMetadata> ReadAsync(string appDirectory, string? manifestPath, string resourceName, CancellationToken cancellationToken)
    {
        var workspaceRoot = Path.GetFullPath(workspaceRootRelativePath, appDirectory);
        var rebased = metadataJson.Replace(
            "\"workspace_root\": \"/app\"",
            $"\"workspace_root\": {JsonSerializer.Serialize(workspaceRoot)}",
            StringComparison.Ordinal);

        return Task.FromResult(CargoMetadata.Parse(rebased));
    }
}
