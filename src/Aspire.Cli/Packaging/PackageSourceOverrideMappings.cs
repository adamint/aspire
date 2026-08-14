// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Utils;

namespace Aspire.Cli.Packaging;

internal static class PackageSourceOverrideMappings
{
    /// <summary>
    /// Resolves a package source against the supplied base directory, returning relative local
    /// sources as absolute paths so persisted mappings remain valid elsewhere.
    /// </summary>
    public static string ResolveForWorkingDirectory(string source, DirectoryInfo baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        ArgumentNullException.ThrowIfNull(baseDirectory);

        var sourceKind = ClassifySource(source, out _);

        // On Unix, Uri treats DOS-shaped paths such as C:/feed as absolute file URIs.
        // Preserve a file URI only when the source explicitly includes the file: scheme.
        if (Path.IsPathFullyQualified(source) ||
            IsWindowsExtendedLocalDrivePath(source) ||
            sourceKind is PackageSourceKind.Http or PackageSourceKind.FileUri)
        {
            return source;
        }

        return Path.GetFullPath(source, baseDirectory.FullName);
    }

    public static string? GetMissingLocalDirectory(string source)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);

        var localDirectory = GetNormalizedLocalDirectory(source);
        if (localDirectory is null)
        {
            return null;
        }

        return Directory.Exists(localDirectory) ? null : localDirectory;
    }

    public static bool IsRemoteFileSystemSource(string source)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);

        var trimmedSource = source.Trim();
        if (HasWindowsRemotePathPrefix(trimmedSource))
        {
            return true;
        }

        if (!trimmedSource.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ||
            !Uri.TryCreate(trimmedSource, UriKind.Absolute, out var uri) ||
            !uri.IsFile)
        {
            return false;
        }

        if (!uri.IsLoopback && (uri.IsUnc || !string.IsNullOrEmpty(uri.Host)))
        {
            return true;
        }

        if (uri.IsLoopback && !string.IsNullOrEmpty(uri.Host))
        {
            return false;
        }

        // Hostless file URIs can encode a Windows UNC or device path in their local path:
        //   file:///%2Fserver/share -> //server/share
        //   file:///%2F%3F%2FUNC/server/share -> //?/UNC/server/share
        // Uri.GetComponents(Path, Unescaped) can collapse the first encoded separator, so use
        // the complete decoded LocalPath and classify it before any filesystem API receives it.
        var decodedPath = uri.LocalPath;
        return HasWindowsRemotePathPrefix(decodedPath);
    }

    public static string? GetFirstReparsePoint(string source, DirectoryInfo baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        ArgumentNullException.ThrowIfNull(baseDirectory);

        var sourceKind = ClassifySource(source, out var localDirectory);
        if (sourceKind is PackageSourceKind.Http)
        {
            return null;
        }

        var isRelativeLocalPath = sourceKind is PackageSourceKind.LocalPath &&
            !Path.IsPathFullyQualified(source) &&
            !IsWindowsExtendedLocalDrivePath(source);

        // Relative configuration is inspected from its declaring directory on every OS, which
        // avoids rejecting unrelated symlinked ancestors such as macOS system temporary paths.
        // Absolute sources are inspected from the filesystem root only on Windows, where following
        // a junction or symlink can cross onto an authenticated remote filesystem.
        if (!isRelativeLocalPath && !OperatingSystem.IsWindows())
        {
            return null;
        }

        var resolvedLocalDirectory = IsWindowsExtendedLocalDrivePath(localDirectory!)
            ? localDirectory!
            : Path.GetFullPath(localDirectory!, baseDirectory.FullName);
        var inspectionBase = isRelativeLocalPath
            ? Path.GetFullPath(baseDirectory.FullName)
            : Path.GetPathRoot(resolvedLocalDirectory)!;

        return GetFirstReparsePoint(resolvedLocalDirectory, inspectionBase);
    }

    public static string? GetNormalizedLocalDirectory(string source)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);

        var sourceKind = ClassifySource(source, out var localDirectory);
        if (sourceKind is PackageSourceKind.Http)
        {
            return null;
        }

        return IsWindowsExtendedLocalDrivePath(localDirectory!)
            ? localDirectory
            : Path.GetFullPath(localDirectory!);
    }

    public static PackageMapping[] Create(string packageSourceOverride, PackageChannel? requestedChannel, string? nugetServiceIndexOverride)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageSourceOverride);
        if (HasCredentialMaterial(packageSourceOverride))
        {
            throw new ArgumentException("Credential-bearing HTTP sources cannot be persisted.", nameof(packageSourceOverride));
        }

        var mappings = new List<PackageMapping>
        {
            new("Aspire*", packageSourceOverride)
        };

        if (requestedChannel?.Mappings is not null)
        {
            foreach (var mapping in requestedChannel.Mappings)
            {
                if (mapping.PackageFilter.StartsWith("Aspire", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                mappings.Add(mapping);
            }
        }

        if (!mappings.Any(static mapping => mapping.PackageFilter == PackageMapping.AllPackages))
        {
            // Honor the runtime service-index override (env / sidecar) when the
            // CLI emits a fresh fallback mapping. Reads from existing user
            // configs are not rewritten — see docs/specs/cli-identity-sidecar.md.
            var fallbackSource = string.IsNullOrEmpty(nugetServiceIndexOverride)
                ? PackageSources.NuGetOrg
                : nugetServiceIndexOverride;
            mappings.Add(new PackageMapping(PackageMapping.AllPackages, fallbackSource));
        }

        return [.. mappings.DistinctBy(static mapping => $"{mapping.PackageFilter}\0{mapping.Source}")];
    }

    public static PackageMapping[] CreateForTemplateOperations(string packageSourceOverride)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageSourceOverride);

        // NuGet package search queries every configured source without applying package source
        // mapping. Keep the temporary config exclusive to --source so discovery and installation
        // cannot contact a channel feed or NuGet.org behind the user's approved proxy.
        return
        [
            new("Aspire*", packageSourceOverride),
            new(PackageMapping.AllPackages, packageSourceOverride)
        ];
    }

    public static bool HasCredentialMaterial(string source)
    {
        return Uri.TryCreate(source.Trim(), UriKind.Absolute, out var uri) &&
            (uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) &&
            (!string.IsNullOrEmpty(uri.UserInfo) ||
                !string.IsNullOrEmpty(uri.Query) ||
                !string.IsNullOrEmpty(uri.Fragment));
    }

    private static PackageSourceKind ClassifySource(string source, out string? localDirectory)
    {
        if (UrlHelper.IsHttpUrl(source))
        {
            localDirectory = null;
            return PackageSourceKind.Http;
        }

        if (source.StartsWith("file:", StringComparison.OrdinalIgnoreCase) &&
            Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
            uri.IsFile)
        {
            localDirectory = uri.LocalPath;
            return PackageSourceKind.FileUri;
        }

        localDirectory = source;
        return PackageSourceKind.LocalPath;
    }

    private static bool IsWindowsDirectorySeparator(char value)
    {
        return value is '\\' or '/';
    }

    private static bool HasWindowsRemotePathPrefix(string path)
    {
        if (IsWindowsExtendedLocalDrivePath(path))
        {
            return false;
        }

        if (path.Length >= 2 &&
            IsWindowsDirectorySeparator(path[0]) &&
            IsWindowsDirectorySeparator(path[1]))
        {
            return true;
        }

        // Windows accepts either slash as a separator, including mixed forms:
        //   /\server\share
        //   \??/UNC\server\share
        return path.Length >= 4 &&
            IsWindowsDirectorySeparator(path[0]) &&
            path[1] == '?' &&
            path[2] == '?' &&
            IsWindowsDirectorySeparator(path[3]);
    }

    private static bool IsWindowsExtendedLocalDrivePath(string path)
    {
        return path.Length >= 7 &&
            path[0] == '\\' &&
            path[1] == '\\' &&
            path[2] == '?' &&
            path[3] == '\\' &&
            ((path[4] >= 'A' && path[4] <= 'Z') || (path[4] >= 'a' && path[4] <= 'z')) &&
            path[5] == ':' &&
            IsWindowsDirectorySeparator(path[6]);
    }

    private static string? GetFirstReparsePoint(string localDirectory, string inspectionBase)
    {
        var relativePath = Path.GetRelativePath(inspectionBase, localDirectory);
        var currentPath = inspectionBase;

        foreach (var component in relativePath.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries))
        {
            currentPath = Path.GetFullPath(Path.Combine(currentPath, component));
            if (component is "." or "..")
            {
                continue;
            }

            try
            {
                if ((File.GetAttributes(currentPath) & FileAttributes.ReparsePoint) is FileAttributes.ReparsePoint)
                {
                    return currentPath;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Missing and inaccessible components retain the existing missing-source behavior.
                return null;
            }
        }

        return null;
    }

    private enum PackageSourceKind
    {
        Http,
        FileUri,
        LocalPath
    }
}
