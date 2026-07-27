// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;

namespace Aspire.Hosting.Rust;

internal static partial class RustVersionDetector
{
    public static string? DetectVersion(string appDirectory)
    {
        var toolchainTomlPath = Path.Combine(appDirectory, "rust-toolchain.toml");
        if (File.Exists(toolchainTomlPath))
        {
            var content = File.ReadAllText(toolchainTomlPath);
            var match = ChannelRegex().Match(content);
            if (match.Success)
            {
                return match.Groups[1].Value;
            }
        }

        var toolchainPath = Path.Combine(appDirectory, "rust-toolchain");
        if (File.Exists(toolchainPath))
        {
            var channel = File.ReadAllText(toolchainPath).Trim();
            if (!string.IsNullOrEmpty(channel))
            {
                return channel;
            }
        }

        return null;
    }

    [GeneratedRegex(@"channel\s*=\s*""([^""]+)""", RegexOptions.IgnoreCase)]
    private static partial Regex ChannelRegex();
}
