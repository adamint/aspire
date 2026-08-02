// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;

namespace Aspire.Hosting.Rust;

/// <summary>
/// The build and runtime base images used by a generated Rust Dockerfile.
/// </summary>
internal sealed record RustPublishImages(string BuildImage, string RuntimeImage)
{
    /// <summary>
    /// Whether the build stage looks Alpine-based, which determines whether a C toolchain has to be
    /// installed.
    /// </summary>
    public bool BuildImageIsPossiblyAlpine => IsPossiblyAlpine(BuildImage);

    /// <summary>
    /// Whether the runtime stage looks Alpine-based, which determines whether BusyBox user/package
    /// management commands can be emitted.
    /// </summary>
    public bool RuntimeImageIsPossiblyAlpine => IsPossiblyAlpine(RuntimeImage);

    /// <remarks>
    /// A hint, never a guarantee. An image name is free-form, so a private image built on Alpine can be
    /// called anything and an image called <c>alpine-tools</c> can be Debian underneath. Callers must
    /// therefore treat the answer as a preference for which commands to try first, and must not refuse to
    /// generate a Dockerfile on the strength of it: a wrong guess should at worst cost a container build,
    /// whereas a rejection blocks a configuration that may well have worked.
    /// </remarks>
    private static bool IsPossiblyAlpine(string image) => image.Contains("alpine", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Chooses the base images for a generated Rust Dockerfile.
/// </summary>
/// <remarks>
/// <para>
/// The default pairing is <c>rust:&lt;version&gt;-alpine</c> for the build stage and
/// <c>alpine:&lt;version&gt;</c> for the runtime stage. Both are musl-based, so the produced binary and the
/// runtime image share a libc by construction and there is no glibc-version skew to reason about. That is the
/// main reason the default is Alpine rather than a Debian pair, where a binary built against a newer glibc
/// silently fails at startup on an older runtime image.
/// </para>
/// <para>
/// Callers who need glibc (proprietary crates shipping <c>-gnu</c> binaries, or crates that build materially
/// faster against glibc) can pair the images themselves through <c>WithDockerfileBaseImage</c>, for example
/// <c>rust:1.89-bookworm</c> with <c>debian:bookworm-slim</c>. Pairing a <c>--target</c> triple with images
/// that can run the result is then theirs to get right.
/// </para>
/// </remarks>
internal static partial class RustPublishImageResolver
{
    /// <summary>
    /// The runtime image paired with the default Alpine build image. Pinned rather than <c>alpine:latest</c>
    /// so a generated Dockerfile keeps producing the same image over time.
    /// </summary>
    public const string DefaultRuntimeImage = "alpine:3.22";

    public static RustPublishImages Resolve(
        string? explicitBuildImage,
        string? explicitRuntimeImage,
        string appDirectory,
        string? minimumRustVersion,
        string resourceName)
    {
        var buildImage = explicitBuildImage ?? ResolveDefaultBuildImage(appDirectory, minimumRustVersion, resourceName);
        var runtimeImage = explicitRuntimeImage ?? DefaultRuntimeImage;

        return new RustPublishImages(buildImage, runtimeImage);
    }

    /// <summary>
    /// Maps the crate's pinned rustup channel onto a real container image tag.
    /// </summary>
    /// <remarks>
    /// rustup channel names are not container image tags. Docker Hub's official <c>rust</c> repository
    /// publishes by version (<c>rust:1.89-alpine</c>, <c>rust:1.89.0-alpine</c>) plus an unversioned
    /// <c>rust:alpine</c> that tracks current stable; there is no <c>rust:stable-alpine</c> or
    /// <c>rust:beta-*</c> tag. Pre-release toolchains live in the separate <c>rustlang/rust</c> repository,
    /// which publishes <c>nightly-alpine</c> plus dated variants that append the date after the OS suffix,
    /// as in <c>nightly-alpine-2026-08-01</c> — not <c>nightly-2026-08-01-alpine</c>.
    /// See https://hub.docker.com/_/rust and https://hub.docker.com/r/rustlang/rust
    /// </remarks>
    internal static string ResolveDefaultBuildImage(string appDirectory, string? minimumRustVersion, string resourceName)
    {
        var channel = RustToolchainDetector.Detect(appDirectory);

        if (channel is null)
        {
            return $"rust:{ResolveUnpinnedVersion(minimumRustVersion)}-alpine";
        }

        if (RustToolchainDetector.GetChannelName(channel) is { } channelName)
        {
            return channelName switch
            {
                "stable" => "rust:alpine",
                "nightly" when RustToolchainDetector.GetChannelDate(channel) is { } date => $"rustlang/rust:nightly-alpine-{date}",
                "nightly" => "rustlang/rust:nightly-alpine",
                _ => throw new DistributedApplicationException(
                    $"The Rust app '{resourceName}' pins the '{channel}' toolchain, but no official container image publishes the '{channelName}' " +
                    $"channel. Call WithDockerfileBaseImage(buildImage: \"...\") to supply an image that provides it, or pin an explicit version in " +
                    $"rust-toolchain.toml.")
            };
        }

        // A version channel may carry a host suffix (1.89.0-x86_64-unknown-linux-gnu). Only the version part
        // is a valid image tag, and the host suffix is irrelevant because the build always runs in a Linux
        // container.
        var version = VersionPrefixRegex().Match(channel) is { Success: true } match ? match.Groups[1].Value : channel;

        return $"rust:{version}-alpine";
    }

    [GeneratedRegex(@"^(\d+(?:\.\d+){0,2})(?:-|$)")]
    private static partial Regex VersionPrefixRegex();

    // A crate that pins no toolchain still declares the oldest one it supports, and cargo refuses to build
    // with anything older, so the crate's rust-version raises the pinned default when it is newer. The
    // default stays a pinned version rather than the floating `rust:alpine` tag so generated Dockerfiles
    // remain reproducible.
    private static string ResolveUnpinnedVersion(string? minimumRustVersion)
        => minimumRustVersion is not null
            && CargoMetadata.TryParseRustVersion(minimumRustVersion, out var minimum)
            && CargoMetadata.TryParseRustVersion(RustToolchainDetector.DefaultChannel, out var @default)
            && minimum > @default
                ? minimumRustVersion
                : RustToolchainDetector.DefaultChannel;
}
