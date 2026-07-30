// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Supplies the crate's <c>cargo metadata</c> output instead of shelling out to cargo.
/// </summary>
/// <remarks>
/// Publishing needs the crate's package/target layout to emit a correct <c>COPY</c>/<c>ENTRYPOINT</c>, which
/// normally means running <c>cargo metadata</c> on the host. This annotation lets tests exercise the
/// Dockerfile generation deterministically on machines that have no Rust toolchain installed.
/// </remarks>
/// <param name="provider">Returns the metadata for the crate.</param>
internal sealed class RustCargoMetadataProviderAnnotation(Func<CancellationToken, Task<CargoMetadata>> provider) : IResourceAnnotation
{
    public Func<CancellationToken, Task<CargoMetadata>> Provider { get; } = provider;
}
