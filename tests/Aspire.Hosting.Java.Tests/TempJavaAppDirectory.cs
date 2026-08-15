// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Java.Tests;

/// <summary>
/// Creates a securely-created temporary directory that stands in for a Java application directory.
/// </summary>
internal sealed class TempJavaAppDirectory : IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("aspire-java-tests");

    public string Path => _directory.FullName;

    /// <summary>
    /// Writes a file into the directory, creating any intermediate directories.
    /// </summary>
    public string Write(string fileName, string content = "")
    {
        var fullPath = System.IO.Path.Combine(Path, fileName);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, content);

        return fullPath;
    }

    /// <summary>
    /// Writes a build tool wrapper script into the directory and marks it executable on Unix, matching
    /// what a real <c>mvnw</c>/<c>gradlew</c> checkout looks like.
    /// </summary>
    public string WriteWrapper(string fileName)
    {
        var fullPath = Write(fileName, "#!/bin/sh\nexit 0\n");

        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                fullPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }

        return fullPath;
    }

    public void Dispose()
    {
        try
        {
            _directory.Delete(recursive: true);
        }
        catch (IOException)
        {
            // Best effort: a virus scanner or indexer can briefly hold a handle on Windows, and failing
            // to clean up a temp directory must not fail an otherwise passing test.
        }
    }
}
