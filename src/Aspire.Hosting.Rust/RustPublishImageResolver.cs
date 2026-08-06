// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust;

/// <summary>
/// The build and runtime base images used by a generated Rust Dockerfile.
/// </summary>
/// <param name="BuildImage">The image the crate is compiled in.</param>
/// <param name="RuntimeImage">The image the compiled binary is copied into.</param>
/// <remarks>
/// Both are used exactly as given. Neither is inspected to work out what it contains, and nothing is
/// installed into either: a name is free-form, so a musl-based image can be called anything and an image
/// whose name says otherwise can be glibc-based underneath, and what belongs in an image is a decision for
/// whoever built it.
/// </remarks>
internal sealed record RustPublishImages(string BuildImage, string RuntimeImage);

/// <summary>
/// Chooses the base images for a generated Rust Dockerfile.
/// </summary>
/// <remarks>
/// <para>
/// The default pairing is <c>rust:alpine</c> for the build stage and <c>alpine:&lt;version&gt;</c> for the
/// runtime stage. Both are musl-based, so the produced binary and the runtime image share a libc by
/// construction and there is no glibc-version skew to reason about. That is the main reason the default is a
/// musl pair rather than a glibc one, where a binary built against a newer glibc silently fails at startup on
/// an older runtime image.
/// </para>
/// <para>
/// Callers who need glibc (proprietary crates shipping <c>-gnu</c> binaries, or crates that build materially
/// faster against glibc) can pair the images themselves through <c>WithDockerfileBaseImage</c>, for example
/// <c>rust:bookworm</c> with <c>debian:bookworm-slim</c>. Pairing a <c>--target</c> triple with images that
/// can run the result is then theirs to get right.
/// </para>
/// </remarks>
internal static class RustPublishImageResolver
{
    /// <summary>
    /// The build image used when no explicit one is configured.
    /// </summary>
    /// <remarks>
    /// The unversioned tag tracks current stable, and the toolchain it carries is only a starting point:
    /// rustup is present in the official image and installs whatever the crate pins, so a
    /// <c>rust-toolchain.toml</c> naming an older version, a date-stamped nightly or beta is honoured from
    /// this one image. Selecting a version-matched tag here would only duplicate that pin, and picking one
    /// from the crate's <c>rust-version</c> would actively fight it, because that field is the oldest
    /// toolchain the crate supports rather than a request for one.
    /// </remarks>
    public const string DefaultBuildImage = "rust:alpine";

    /// <summary>
    /// The runtime image paired with the default musl build image. Pinned rather than <c>alpine:latest</c>
    /// so a generated Dockerfile keeps producing the same image over time.
    /// </summary>
    public const string DefaultRuntimeImage = "alpine:3.22";

    public static RustPublishImages Resolve(string? explicitBuildImage, string? explicitRuntimeImage)
        => new(explicitBuildImage ?? DefaultBuildImage, explicitRuntimeImage ?? DefaultRuntimeImage);
}
