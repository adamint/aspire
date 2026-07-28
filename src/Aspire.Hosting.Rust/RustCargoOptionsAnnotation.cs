// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Captures the cargo build/run options configured through the <c>WithCargoReleaseBuild</c>, <c>WithCargoFeatures</c>,
/// and <c>WithCargoBinTarget</c> fluent APIs, so that a single default <see cref="RustCargoArgsCallbackAnnotation"/>
/// registered by <c>AddRustApp</c> can translate them into cargo command-line arguments at execution time, regardless
/// of the order the WithCargo* methods were called relative to each other.
/// </summary>
internal sealed class RustCargoOptionsAnnotation : IResourceAnnotation
{
    /// <summary>
    /// Gets or sets a value indicating whether cargo should build/run using the <c>--release</c> profile.
    /// </summary>
    public bool ReleaseBuild { get; set; }

    /// <summary>
    /// Gets or sets the cargo features to enable via <c>--features</c>.
    /// </summary>
    public IReadOnlyList<string>? Features { get; set; }

    /// <summary>
    /// Gets or sets the cargo bin target to run via <c>--bin</c>.
    /// </summary>
    public string? BinTarget { get; set; }
}
