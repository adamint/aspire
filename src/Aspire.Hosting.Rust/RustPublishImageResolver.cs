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
/// Chooses the base images for a generated Rust Dockerfile and validates that the pair can actually run the
/// binary the build stage produces.
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
/// <c>rust:1.89-bookworm</c> with <c>debian:bookworm-slim</c>.
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
        string? target,
        string resourceName)
    {
        var buildImage = explicitBuildImage ?? ResolveDefaultBuildImage(appDirectory, resourceName);
        var runtimeImage = explicitRuntimeImage ?? DefaultRuntimeImage;

        if (target is not null)
        {
            ValidateTarget(target, explicitBuildImage is not null && explicitRuntimeImage is not null, resourceName);
        }

        return new RustPublishImages(buildImage, runtimeImage);
    }

    // A cross-compiled binary only runs in the runtime image when its libc matches. The default images are
    // musl, so a -gnu triple would build a binary Alpine cannot execute; rather than emit a Dockerfile that
    // fails at container start with a confusing "no such file or directory" (the classic missing-loader
    // error), fail here with the fix. When the caller supplied both images they own the pairing.
    private static void ValidateTarget(string target, bool callerOwnsImagePairing, string resourceName)
    {
        if (!target.Contains("linux", StringComparison.OrdinalIgnoreCase))
        {
            throw new DistributedApplicationException(
                $"The Rust app '{resourceName}' passes '--target {target}' to cargo, but the generated Dockerfile produces a Linux container " +
                $"image. Remove the --target argument, or add a Dockerfile next to Cargo.toml to take over the container build.");
        }

        if (!callerOwnsImagePairing && target.Contains("-gnu", StringComparison.OrdinalIgnoreCase))
        {
            throw new DistributedApplicationException(
                $"The Rust app '{resourceName}' passes '--target {target}' to cargo, which produces a glibc binary, but the default generated " +
                $"Dockerfile builds and runs on musl (Alpine) images. Call WithDockerfileBaseImage(buildImage: \"rust:{RustToolchainDetector.DefaultChannel}-bookworm\", " +
                $"runtimeImage: \"debian:bookworm-slim\") to supply a matching glibc pair, or target a *-musl triple.");
        }
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
