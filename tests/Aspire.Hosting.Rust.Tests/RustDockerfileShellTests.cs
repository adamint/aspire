// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;

namespace Aspire.Hosting.Rust.Tests;

public class RustDockerfileShellTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task EmptyCandidateSetDoesNotPreventTheCurrentArtifactFromBeingCollected()
    {
        SkipWithoutPosixShell();
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var targetDirectory = workspace.CreateDirectory("target").FullName;
        var artifactDirectory = workspace.CreateDirectory("artifacts").FullName;
        var currentArtifact = Path.Combine(targetDirectory, "release", "api");
        var cargoCommand =
            $"mkdir -p {ShellQuote(Path.GetDirectoryName(currentArtifact)!)} && " +
            $"printf current > {ShellQuote(currentArtifact)}";
        var command = RustDockerfileGenerator.BuildArtifactCommand(
            new RustCargoTarget("api", "release", Target: null, IsExample: false),
            cargoCommand,
            targetDirectory,
            artifactDirectory);

        var result = await RunShellAsync(command);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardError);
        Assert.Equal("current", File.ReadAllText(Path.Combine(artifactDirectory, "api")));
    }

    [Fact]
    public async Task CargoFailurePreservesItsExitCodeAndStandardError()
    {
        SkipWithoutPosixShell();
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var targetDirectory = workspace.CreateDirectory("target").FullName;
        var artifactDirectory = workspace.CreateDirectory("artifacts").FullName;
        var cargoStub = Path.Combine(workspace.WorkspaceRoot.FullName, "cargo-stub");
        await File.WriteAllTextAsync(
            cargoStub,
            "#!/bin/sh\nprintf 'stub cargo failed\\n' >&2\nexit 73\n",
            TestContext.Current.CancellationToken);
        var command = RustDockerfileGenerator.BuildArtifactCommand(
            new RustCargoTarget("api", "release", Target: null, IsExample: false),
            $"/bin/sh {ShellQuote(cargoStub)}",
            targetDirectory,
            artifactDirectory);

        var result = await RunShellAsync(command);

        Assert.Equal(73, result.ExitCode);
        Assert.Equal("stub cargo failed\n", result.StandardError);
        Assert.False(File.Exists(Path.Combine(artifactDirectory, "api")));
    }

    [Fact]
    public async Task StaleCandidatesAreRemovedBeforeTheCurrentArtifactIsCollected()
    {
        SkipWithoutPosixShell();
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var targetDirectory = workspace.CreateDirectory("target").FullName;
        var artifactDirectory = workspace.CreateDirectory("artifacts").FullName;
        var rootCandidate = Path.Combine(targetDirectory, "release", "api");
        var staleTargetCandidate = Path.Combine(targetDirectory, "stale-target", "release", "api");
        var currentTargetCandidate = Path.Combine(targetDirectory, "current-target", "release", "api");
        Directory.CreateDirectory(Path.GetDirectoryName(rootCandidate)!);
        Directory.CreateDirectory(Path.GetDirectoryName(staleTargetCandidate)!);
        File.WriteAllText(rootCandidate, "stale-root");
        File.WriteAllText(staleTargetCandidate, "stale-target");
        var cargoCommand =
            $"mkdir -p {ShellQuote(Path.GetDirectoryName(currentTargetCandidate)!)} && " +
            $"printf current > {ShellQuote(currentTargetCandidate)}";
        var command = RustDockerfileGenerator.BuildArtifactCommand(
            new RustCargoTarget("api", "release", "current-target", IsExample: false),
            cargoCommand,
            targetDirectory,
            artifactDirectory);

        var result = await RunShellAsync(command);

        Assert.Equal(0, result.ExitCode);
        Assert.False(File.Exists(rootCandidate));
        Assert.False(File.Exists(staleTargetCandidate));
        Assert.Equal("current", File.ReadAllText(Path.Combine(artifactDirectory, "api")));
    }

    [Fact]
    public async Task MissingArtifactDiagnosticDoesNotExecuteTheTargetName()
    {
        SkipWithoutPosixShell();
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var targetDirectory = workspace.CreateDirectory("target").FullName;
        var artifactDirectory = workspace.CreateDirectory("artifacts").FullName;
        var markerPath = Path.Combine(workspace.WorkspaceRoot.FullName, "command-substitution-ran");
        var targetName = $"$(touch${{IFS}}{markerPath})";
        var command = RustDockerfileGenerator.BuildArtifactCommand(
            new RustCargoTarget(targetName, "release", Target: null, IsExample: false),
            "true",
            targetDirectory,
            artifactDirectory);

        var result = await RunShellAsync(command);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal($"no {targetName} under {targetDirectory}\n", result.StandardError);
        Assert.False(File.Exists(markerPath));
    }

    private static void SkipWithoutPosixShell()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("The generated Dockerfile command is executed by /bin/sh.");
        }
    }

    private static async Task<(int ExitCode, string StandardOutput, string StandardError)> RunShellAsync(string command)
    {
        var startInfo = new ProcessStartInfo("/bin/sh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add(command);

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start /bin/sh.");
        var standardOutput = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
        var standardError = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(TestContext.Current.CancellationToken);

        return (process.ExitCode, await standardOutput, await standardError);
    }

    private static string ShellQuote(string value)
        => $"'{value.Replace("'", "'\\''")}'";
}
