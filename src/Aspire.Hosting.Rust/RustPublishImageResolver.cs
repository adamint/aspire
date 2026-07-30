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
    /// Whether the build stage is Alpine-based, which determines whether a C toolchain has to be installed.
    /// </summary>
    public bool BuildImageIsAlpine => IsAlpine(BuildImage);

    /// <summary>
    /// Whether the runtime stage is Alpine-based, which determines whether BusyBox user/package management
    /// commands can be emitted.
    /// </summary>
    public bool RuntimeImageIsAlpine => IsAlpine(RuntimeImage);

    private static bool IsAlpine(string image) => image.Contains("alpine", StringComparison.OrdinalIgnoreCase);
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
/// that can run the result is then theirs to get right; a mismatch surfaces when the container build or the
/// container itself runs.
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
        string resourceName)
    {
        var buildImage = explicitBuildImage ?? ResolveDefaultBuildImage(appDirectory, resourceName);
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
    /// which publishes <c>nightly</c> and dated <c>nightly-YYYY-MM-DD</c> tags with the same OS suffixes.
    /// See https://hub.docker.com/_/rust and https://hub.docker.com/r/rustlang/rust
    /// </remarks>
    internal static string ResolveDefaultBuildImage(string appDirectory, string resourceName)
    {
        var channel = RustToolchainDetector.Detect(appDirectory);

        if (channel is null)
        {
            return $"rust:{RustToolchainDetector.DefaultChannel}-alpine";
        }

        if (RustToolchainDetector.GetChannelName(channel) is { } channelName)
        {
            return channelName switch
            {
                "stable" => "rust:alpine",
                "nightly" when RustToolchainDetector.GetChannelDate(channel) is { } date => $"rustlang/rust:nightly-{date}-alpine",
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
}
