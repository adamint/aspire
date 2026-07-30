// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;

namespace Aspire.Hosting.Rust;

/// <summary>
/// Detects the Rust toolchain a crate directory pins, if any.
/// </summary>
internal static partial class RustToolchainDetector
{
    /// <summary>
    /// Channel used when a crate does not pin one. Deliberately a pinned version rather than a floating tag
    /// so generated Dockerfiles stay reproducible.
    /// </summary>
    public const string DefaultChannel = "1.89";

    /// <summary>
    /// Returns the pinned toolchain channel, or <see langword="null"/> when the crate does not pin one.
    /// </summary>
    public static string? Detect(string appDirectory)
    {
        // rust-toolchain.toml is the current format:
        //   [toolchain]
        //   channel = "1.89.0"
        //   # channel = "nightly"    <- commented-out lines must never win
        // The value may also be a TOML literal string using single quotes.
        var tomlPath = Path.Combine(appDirectory, "rust-toolchain.toml");
        if (File.Exists(tomlPath))
        {
            foreach (var line in File.ReadLines(tomlPath))
            {
                var match = ChannelRegex().Match(line);
                if (match.Success)
                {
                    // Group 1 is the double-quoted form, group 2 the single-quoted form.
                    var value = match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
                    if (value.Length > 0)
                    {
                        return value;
                    }
                }
            }
        }

        // Legacy format: the entire file is the channel name, e.g. "nightly-2024-01-01".
        var legacyPath = Path.Combine(appDirectory, "rust-toolchain");
        if (File.Exists(legacyPath))
        {
            var channel = File.ReadAllText(legacyPath).Trim();
            if (channel.Length > 0)
            {
                return channel;
            }
        }

        return null;
    }

    /// <summary>
    /// Returns the leading named-channel token (<c>stable</c>, <c>beta</c>, or <c>nightly</c>) of
    /// <paramref name="channel"/>, or <see langword="null"/> when it is a version.
    /// </summary>
    /// <remarks>
    /// A rustup channel is either a version (<c>1.89</c>, <c>1.89.0</c>) or a named channel that may carry a
    /// date and/or host suffix (<c>stable</c>, <c>nightly-2024-01-01</c>,
    /// <c>stable-x86_64-unknown-linux-gnu</c>). This matters because container images are published by
    /// version, so a named channel cannot simply be substituted into an image tag.
    /// See https://rust-lang.github.io/rustup/concepts/toolchains.html
    /// </remarks>
    public static string? GetChannelName(string channel)
    {
        foreach (var name in (ReadOnlySpan<string>)["stable", "beta", "nightly"])
        {
            // Match the whole token only: "stable" and "stable-x86_64-..." are named channels, but a
            // hypothetical version starting with the same letters is not.
            if (channel.StartsWith(name, StringComparison.OrdinalIgnoreCase)
                && (channel.Length == name.Length || channel[name.Length] == '-'))
            {
                return name.ToLowerInvariant();
            }
        }

        return null;
    }

    /// <summary>
    /// Returns the date suffix of a dated nightly channel (<c>nightly-2024-01-01</c>), or
    /// <see langword="null"/> when the channel carries no date.
    /// </summary>
    public static string? GetChannelDate(string channel)
    {
        var match = ChannelDateRegex().Match(channel);
        return match.Success ? match.Groups[1].Value : null;
    }

    // Anchored to the start of the line (matched per line) so commented-out entries never match.
    [GeneratedRegex(@"^\s*channel\s*=\s*(?:""([^""]*)""|'([^']*)')", RegexOptions.IgnoreCase)]
    private static partial Regex ChannelRegex();

    // Matches the ISO date rustup allows immediately after a channel name, e.g. nightly-2024-01-01 or
    // nightly-2024-01-01-x86_64-unknown-linux-gnu.
    [GeneratedRegex(@"^[A-Za-z]+-(\d{4}-\d{2}-\d{2})(?:-|$)")]
    private static partial Regex ChannelDateRegex();
}
