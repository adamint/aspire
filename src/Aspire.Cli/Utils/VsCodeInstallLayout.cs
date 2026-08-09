// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Cli.Utils;

/// <summary>
/// The per-user directory names a single VS Code build family uses on disk.
/// </summary>
/// <param name="UserDataFolderName">
/// The <c>nameShort</c> value that names the user-data directory (for example
/// <c>%APPDATA%\Code</c> or <c>~/Library/Application Support/Code</c>).
/// </param>
/// <param name="DesktopDataFolderName">
/// The <c>dataFolderName</c> value that names the home-relative desktop folder holding extensions.
/// </param>
/// <param name="ServerDataFolderName">
/// The <c>serverDataFolderName</c> value that names the home-relative remote/server folder.
/// </param>
/// <param name="UsesMicrosoftGallery">
/// Whether the build's <c>extensionsGallery</c> points at the Visual Studio Marketplace.
/// </param>
internal sealed record VsCodeVariant(
    string UserDataFolderName,
    string DesktopDataFolderName,
    string ServerDataFolderName,
    bool UsesMicrosoftGallery);

/// <summary>
/// An extension root and whether the build that owns it installs from Microsoft's Marketplace.
/// </summary>
/// <remarks>
/// The gallery is a per-build setting, not a property of the extension: VSCodium points
/// <c>extensionsGallery</c> at Open VSX, so an extension it records as coming from "gallery" did not
/// come from the VS Code Marketplace and must not be compared against or linked to it.
/// </remarks>
internal sealed record VsCodeExtensionRoot(string Path, bool UsesMicrosoftGallery);

/// <summary>
/// The single model of where a VS Code build keeps its per-user state on disk.
/// </summary>
/// <remarks>
/// Every path VS Code derives per user comes from three <c>product.json</c> fields, so the CLI keeps
/// one table of them rather than letting each caller hand-roll its own directory list.
/// <list type="bullet">
/// <item><description><c>nameShort</c> names the user-data directory.</description></item>
/// <item><description><c>dataFolderName</c> names the home-relative desktop folder.</description></item>
/// <item><description><c>serverDataFolderName</c> names the home-relative remote/server folder.</description></item>
/// </list>
/// Values are taken from the shipping manifests: the stable and Insiders builds use <c>Code</c> /
/// <c>Code - Insiders</c>, and VSCodium inherits the OSS defaults because its overlay manifest does
/// not redefine them.
/// See https://github.com/microsoft/vscode/blob/main/product.json and
/// https://github.com/VSCodium/vscodium/blob/master/product.json.
/// </remarks>
internal static class VsCodeInstallLayout
{
    private static readonly IReadOnlyList<VsCodeVariant> s_knownVariants =
    [
        new VsCodeVariant("Code", ".vscode", ".vscode-server", UsesMicrosoftGallery: true),
        new VsCodeVariant("Code - Insiders", ".vscode-insiders", ".vscode-server-insiders", UsesMicrosoftGallery: true),

        // Neither of the OSS-derived builds installs from the Visual Studio Marketplace: a plain
        // code-oss build ships no gallery at all and VSCodium points extensionsGallery at Open VSX.
        new VsCodeVariant("Code - OSS", ".vscode-oss", ".vscode-server-oss", UsesMicrosoftGallery: false),

        // VSCodium leaves dataFolderName at the code-oss default but overrides serverDataFolderName,
        // and its Insiders build overrides both, so the OSS names alone never find a remote VSCodium
        // install. See the setpath calls in
        // https://github.com/VSCodium/vscodium/blob/master/prepare_vscode.sh.
        new VsCodeVariant("VSCodium", ".vscode-oss", ".vscodium-server", UsesMicrosoftGallery: false),
        new VsCodeVariant("VSCodium - Insiders", ".vscodium-insiders", ".vscodium-server-insiders", UsesMicrosoftGallery: false)
    ];

    /// <summary>
    /// Enumerates the extension roots a VS Code build could load extensions from, most to least
    /// authoritative.
    /// </summary>
    /// <remarks>
    /// <c>VSCODE_EXTENSIONS</c> replaces the extension location outright, so when it is set it is the
    /// only root worth probing: falling through to the defaults could report an extension from
    /// <c>~/.vscode</c> that the running window would never load. This deliberately does not model
    /// <c>--extensions-dir</c> or portable mode, because a directory probe cannot tell which of
    /// several installations is the active one — callers that need the active install read the
    /// version the extension itself reports instead.
    /// </remarks>
    internal static IEnumerable<VsCodeExtensionRoot> GetExtensionRootPaths(IEnvironment environment, DirectoryInfo homeDirectory)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(homeDirectory);

        var overrideDirectory = environment.GetEnvironmentVariable("VSCODE_EXTENSIONS");
        if (!string.IsNullOrWhiteSpace(overrideDirectory))
        {
            // VSCODE_EXTENSIONS names a directory, not a product: VS Code, VSCodium, and code-oss all
            // honor it, so an override cannot establish which gallery the build installs from. The
            // path is still matched against the known data folders, which covers the common case of
            // pointing the override at a build's own root, and anything else stays unknown rather
            // than being guessed into a Marketplace comparison.
            yield return new VsCodeExtensionRoot(
                overrideDirectory,
                UsesMicrosoftGalleryByPath(environment, overrideDirectory, homeDirectory));
            yield break;
        }

        var home = homeDirectory.FullName;

        // code-oss and VSCodium share a dataFolderName, so the same desktop root would otherwise be
        // scanned (and reported as searched) twice.
        var visitedRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var variant in s_knownVariants)
        {
            var path = Path.Combine(home, variant.DesktopDataFolderName, "extensions");
            if (visitedRoots.Add(path))
            {
                yield return new VsCodeExtensionRoot(path, variant.UsesMicrosoftGallery);
            }
        }

        foreach (var variant in s_knownVariants)
        {
            var path = Path.Combine(home, variant.ServerDataFolderName, "extensions");
            if (visitedRoots.Add(path))
            {
                yield return new VsCodeExtensionRoot(path, variant.UsesMicrosoftGallery);
            }
        }
    }

    // An override that points at a build's own extensions root still identifies the build, so the
    // path is matched against the known data folders before giving up. Only a Microsoft-gallery
    // folder promotes the root; an OSS or VSCodium folder, or a path matching nothing, does not.
    private static bool UsesMicrosoftGalleryByPath(IEnvironment environment, string extensionsDirectory, DirectoryInfo homeDirectory)
    {
        var home = homeDirectory.FullName;

        // Case-insensitively on Windows and macOS, where the file system is, and exactly on Linux,
        // where ~/.VSCODE/extensions is a genuinely different directory from ~/.vscode/extensions.
        // Matching case-insensitively there would promote a VSCodium or custom-gallery override to
        // the Microsoft Marketplace and make the outbound request this classification prevents.
        var pathComparison = environment.IsWindows() || environment.IsMacOS()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        foreach (var variant in s_knownVariants)
        {
            if (!variant.UsesMicrosoftGallery)
            {
                continue;
            }

            foreach (var dataFolderName in new[] { variant.DesktopDataFolderName, variant.ServerDataFolderName })
            {
                var root = Path.Combine(home, dataFolderName, "extensions");
                if (string.Equals(
                        Path.TrimEndingDirectorySeparator(extensionsDirectory),
                        Path.TrimEndingDirectorySeparator(root),
                        pathComparison))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Enumerates the home-relative remote/server data folder names for every known VS Code build.
    /// </summary>
    internal static IEnumerable<string> ServerDataFolderNames
        => s_knownVariants.Select(variant => variant.ServerDataFolderName);

    /// <summary>
    /// Enumerates the user-data directory names for every known VS Code build.
    /// </summary>
    internal static IEnumerable<string> UserDataFolderNames
        => s_knownVariants.Select(variant => variant.UserDataFolderName);
}
