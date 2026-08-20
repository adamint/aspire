// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Hosting.Utils;

namespace Aspire.Cli.Backchannel;

/// <summary>
/// Provides the platform-specific path identity rules used for AppHost selection.
/// </summary>
internal static class AppHostPathComparer
{
    public static bool PathsEqual(string leftPath, string rightPath)
    {
        return PathsEqual(leftPath, rightPath, Comparer);
    }

    internal static bool PathsEqual(string leftPath, string rightPath, StringComparer fallbackComparer)
    {
        if (StringComparer.Ordinal.Equals(leftPath, rightPath))
        {
            return true;
        }

        var leftCanonicalized = TryGetCanonicalPath(leftPath, out var canonicalLeftPath);
        var rightCanonicalized = TryGetCanonicalPath(rightPath, out var canonicalRightPath);

        if (leftCanonicalized || rightCanonicalized)
        {
            if (!leftCanonicalized || !rightCanonicalized)
            {
                return false;
            }

            // Stored filesystem spelling is authoritative even on Windows because an individual
            // directory can opt into case-sensitive semantics. The drive letter is volume identity,
            // not a directory segment, so canonicalize only that root before the ordinal comparison.
            return StringComparer.Ordinal.Equals(
                NormalizeDriveRootIdentity(canonicalLeftPath),
                NormalizeDriveRootIdentity(canonicalRightPath));
        }

        return fallbackComparer.Equals(
            PathNormalizer.ResolveToFilesystemPath(PathNormalizer.ResolveSymlinks(leftPath)),
            PathNormalizer.ResolveToFilesystemPath(PathNormalizer.ResolveSymlinks(rightPath)));
    }

    internal static string NormalizeDriveRootIdentity(string path)
    {
        if (path.Length < 3 ||
            path[1] != ':' ||
            path[2] is not ('\\' or '/') ||
            !char.IsAsciiLetter(path[0]))
        {
            return path;
        }

        var normalizedDriveLetter = char.ToUpperInvariant(path[0]);
        return normalizedDriveLetter == path[0]
            ? path
            : $"{normalizedDriveLetter}{path[1..]}";
    }

    private static bool TryGetCanonicalPath(string path, out string canonicalPath)
    {
        canonicalPath = path;
        return PathNormalizer.TryResolveSymlinks(path, out var symlinkResolvedPath) &&
            PathNormalizer.TryResolveToFilesystemPath(symlinkResolvedPath, out canonicalPath);
    }

    private static StringComparer Comparer =>
        OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;
}
