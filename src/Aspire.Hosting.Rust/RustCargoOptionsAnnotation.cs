// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Captures the cargo build/run options configured through the <c>WithCargo*</c> fluent APIs, so that a single
/// default <see cref="RustCargoArgsCallbackAnnotation"/> registered by <c>AddRustApp</c> can translate them
/// into cargo command-line arguments at execution time, regardless of the order the WithCargo* methods were
/// called relative to each other.
/// </summary>
/// <remarks>
/// This annotation is also the single source of truth for publishing. Every property here changes which file
/// cargo writes into <c>target/</c>, so the generated Dockerfile reads these properties rather than trying to
/// re-interpret the raw argument list produced by <c>WithCargoArgs</c>.
/// </remarks>
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
    /// Gets or sets the binary target selected with <c>--bin</c>.
    /// </summary>
    public string? BinTarget { get; set; }

    /// <summary>
    /// Gets or sets the workspace package selected with <c>--package</c>.
    /// </summary>
    public string? Package { get; set; }

    /// <summary>
    /// Gets or sets the target triple selected with <c>--target</c>.
    /// </summary>
    public string? TargetTriple { get; set; }

    /// <summary>
    /// Gets or sets the named profile selected with <c>--profile</c>.
    /// </summary>
    /// <remarks>
    /// When set, this wins over <see cref="ReleaseBuild"/> because cargo rejects <c>--release</c> and
    /// <c>--profile</c> together.
    /// </remarks>
    public string? Profile { get; set; }

    /// <summary>
    /// The profile a publish build uses. Publishing defaults to an optimized build, so an app that configured
    /// neither a profile nor a release build still publishes <c>release</c>.
    /// </summary>
    public string PublishProfile => Profile ?? "release";

    /// <summary>
    /// The directory under <c>target/</c> (or <c>target/&lt;triple&gt;/</c>) that a publish build writes to.
    /// </summary>
    /// <remarks>
    /// The directory is not always the profile name: the built-in <c>dev</c> and <c>test</c> profiles both
    /// emit to <c>target/debug</c> and <c>bench</c> emits to <c>target/release</c>. Custom profiles use their
    /// own name. See https://doc.rust-lang.org/cargo/reference/profiles.html
    /// </remarks>
    public string PublishProfileDirectory => PublishProfile switch
    {
        "dev" or "test" => "debug",
        "bench" => "release",
        var profile => profile
    };
}
