// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.IO.Compression;

namespace Aspire.Cli.Tests.Utils;

/// <summary>
/// A folder-backed NuGet feed built from fabricated packages, plus a restore that can only reach it.
/// </summary>
/// <remarks>
/// Version-range behavior is decided by NuGet, not by the XML the CLI generates, so the only way to
/// prove a pin holds is to restore against a feed whose contents are known exactly. Package ids used
/// with this helper must not exist on any real feed or in the developer's global package cache, or a
/// restore that should fail can succeed from the cache instead.
/// </remarks>
internal static class OfflineNuGetFeed
{
    /// <summary>
    /// Writes a minimal but valid <c>.nupkg</c> for <paramref name="id"/> at
    /// <paramref name="version"/> into <paramref name="feedPath"/>.
    /// </summary>
    public static void CreateStubPackage(string feedPath, string id, string version)
    {
        var stagingPath = Path.Combine(feedPath, $".staging-{id}");
        Directory.CreateDirectory(Path.Combine(stagingPath, "lib", "net10.0"));

        File.WriteAllText(Path.Combine(stagingPath, $"{id}.nuspec"), $"""
            <?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
              <metadata>
                <id>{id}</id>
                <version>{version}</version>
                <description>Stub package for restore tests.</description>
                <authors>Aspire</authors>
              </metadata>
            </package>
            """);

        File.WriteAllText(Path.Combine(stagingPath, "[Content_Types].xml"), """
            <?xml version="1.0" encoding="utf-8"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="nuspec" ContentType="text/xml" />
              <Default Extension="dll" ContentType="application/octet-stream" />
              <Default Extension="xml" ContentType="text/xml" />
            </Types>
            """);

        File.WriteAllBytes(Path.Combine(stagingPath, "lib", "net10.0", $"{id}.dll"), []);

        ZipFile.CreateFromDirectory(stagingPath, Path.Combine(feedPath, $"{id}.{version}.nupkg"));
        Directory.Delete(stagingPath, recursive: true);
    }

    /// <summary>
    /// Restores <paramref name="projectPath"/> against <paramref name="feedPath"/> only.
    /// </summary>
    /// <remarks>
    /// <c>--source</c> replaces every configured source rather than adding one, which is what keeps
    /// the restore offline. Note that it does not isolate the global packages folder:
    /// <c>--packages</c> would, but it also breaks targeting-pack resolution
    /// (<c>NU1101 Microsoft.NETCore.App.Ref</c>), so fabricated package ids are used instead.
    /// </remarks>
    public static async Task<(int ExitCode, string Output)> RestoreAsync(string projectPath, string feedPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(projectPath)!
        };

        startInfo.ArgumentList.Add("restore");
        startInfo.ArgumentList.Add(projectPath);
        startInfo.ArgumentList.Add("--source");
        startInfo.ArgumentList.Add(feedPath);

        using var process = Process.Start(startInfo)!;
        // Read both streams concurrently to avoid deadlock when a pipe buffer fills.
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        return (process.ExitCode, await stdoutTask + await stderrTask);
    }
}
