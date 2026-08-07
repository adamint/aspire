// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Aspire.Cli.Npm;
using Aspire.Cli.Telemetry;
using Aspire.Cli.Tests.Acquisition;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Aspire.Cli.Tests.Npm;

[Collection(EnvVarMutatingTestCollection.Name)]
public class NpmRunnerTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public void PackageRegistry_UsesCanonicalInternalFeed()
    {
        var registryConstants = typeof(NpmRunner)
            .GetFields(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
            .Where(field => field.IsLiteral && field.FieldType == typeof(string) && field.Name.Contains("Registry", StringComparison.Ordinal))
            .Select(field => (string?)field.GetRawConstantValue())
            .ToArray();

        Assert.Contains("https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/", registryConstants);
        Assert.DoesNotContain(registryConstants, value => value?.Contains("npmjs", StringComparison.OrdinalIgnoreCase) is true);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_SetsCommonProperties()
    {
        var startInfo = NpmRunner.CreateNpmProcessStartInfo("/usr/bin/npm", ["view", "express", "version"], "/tmp/workdir", new TestEnvironment());

        Assert.True(startInfo.RedirectStandardOutput);
        Assert.True(startInfo.RedirectStandardError);
        Assert.False(startInfo.UseShellExecute);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal("/tmp/workdir", startInfo.WorkingDirectory);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_OnWindows_WithCmdExtension_UsesCmdExe()
    {
        Assert.SkipUnless(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Windows-only test.");

        var startInfo = NpmRunner.CreateNpmProcessStartInfo(
            @"C:\Program Files\nodejs\npm.cmd",
            ["view", "@playwright/cli@0.1.1", "version", "--registry", "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"],
            @"C:\temp\workdir", new TestEnvironment());

        Assert.Equal("cmd.exe", startInfo.FileName);
        Assert.Empty(startInfo.ArgumentList);
        Assert.Contains("npm.cmd", startInfo.Arguments);
        Assert.Contains("view", startInfo.Arguments);
        Assert.Contains("@playwright/cli@0.1.1", startInfo.Arguments);
        Assert.Contains("version", startInfo.Arguments);
        Assert.Contains("--registry", startInfo.Arguments);
        Assert.StartsWith("/c ", startInfo.Arguments);
        Assert.Equal(@"C:\temp\workdir", startInfo.WorkingDirectory);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_OnWindows_WithCmdExtension_WrapsInOuterQuotes()
    {
        Assert.SkipUnless(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Windows-only test.");

        var startInfo = NpmRunner.CreateNpmProcessStartInfo(
            @"C:\Program Files\nodejs\npm.cmd",
            ["view", "express", "version"],
            @"C:\temp", new TestEnvironment());

        // cmd.exe /c requires outer quotes wrapping the entire command:
        // /c ""C:\Program Files\nodejs\npm.cmd" "view" "express" "version""
        var args = startInfo.Arguments;
        Assert.StartsWith(@"/c """, args);
        Assert.EndsWith(@"""", args);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_OnWindows_WithExeExtension_DoesNotUseCmdExe()
    {
        Assert.SkipUnless(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Windows-only test.");

        var startInfo = NpmRunner.CreateNpmProcessStartInfo(
            @"C:\Program Files\nodejs\npm.exe",
            ["view", "express", "version"],
            @"C:\temp", new TestEnvironment());

        Assert.Equal(@"C:\Program Files\nodejs\npm.exe", startInfo.FileName);
        Assert.Equal(["view", "express", "version"], startInfo.ArgumentList);
        Assert.Empty(startInfo.Arguments);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_OnNonWindows_UsesDirectInvocation()
    {
        Assert.SkipUnless(!RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Non-Windows-only test.");

        var startInfo = NpmRunner.CreateNpmProcessStartInfo(
            "/usr/local/bin/npm",
            ["view", "@playwright/cli@0.1.1", "version"],
            "/tmp/workdir", new TestEnvironment());

        Assert.Equal("/usr/local/bin/npm", startInfo.FileName);
        Assert.Equal(["view", "@playwright/cli@0.1.1", "version"], startInfo.ArgumentList);
        Assert.Empty(startInfo.Arguments);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_OnNonWindows_CmdExtensionIsIgnored()
    {
        Assert.SkipUnless(!RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Non-Windows-only test.");

        // On non-Windows, even a .cmd path is invoked directly (not via cmd.exe).
        var startInfo = NpmRunner.CreateNpmProcessStartInfo(
            "/usr/local/bin/npm.cmd",
            ["view", "express", "version"],
            "/tmp", new TestEnvironment());

        Assert.Equal("/usr/local/bin/npm.cmd", startInfo.FileName);
        Assert.Equal(["view", "express", "version"], startInfo.ArgumentList);
        Assert.Empty(startInfo.Arguments);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_WithEmptyArgs_OnNonWindows_ProducesValidStartInfo()
    {
        Assert.SkipUnless(!RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Non-Windows-only test.");

        var startInfo = NpmRunner.CreateNpmProcessStartInfo("/usr/bin/npm", [], "/tmp", new TestEnvironment());

        Assert.Equal("/usr/bin/npm", startInfo.FileName);
        Assert.Empty(startInfo.ArgumentList);
    }

    [Fact]
    public void CreateNpmProcessStartInfo_WithEmptyArgs_OnWindows_ProducesValidStartInfo()
    {
        Assert.SkipUnless(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Windows-only test.");

        var startInfo = NpmRunner.CreateNpmProcessStartInfo(@"C:\Program Files\nodejs\npm.cmd", [], @"C:\temp", new TestEnvironment());

        Assert.Equal("cmd.exe", startInfo.FileName);
        Assert.Contains("npm.cmd", startInfo.Arguments);
        Assert.Equal(@"C:\temp", startInfo.WorkingDirectory);
    }

    [Fact]
    public async Task InstallGlobalAsync_UsesInternalRegistryForDependencies()
    {
        var tempDirectory = Directory.CreateTempSubdirectory("aspire-npm-runner-test-");

        try
        {
            WriteFakeNpm(tempDirectory);
            var argumentsPath = Path.Combine(tempDirectory.FullName, "arguments.txt");
            var existingPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            using var pathOverride = new EnvVarOverride("PATH", $"{tempDirectory.FullName}{Path.PathSeparator}{existingPath}");
            using var pathExtensionsOverride = OperatingSystem.IsWindows() ? new EnvVarOverride("PATHEXT", ".CMD") : null;
            using var argumentsPathOverride = new EnvVarOverride("NPM_ARGS_FILE", argumentsPath);
            using var profilingTelemetry = new ProfilingTelemetry(new ConfigurationBuilder().Build());
            var runner = new NpmRunner(new TestEnvironment(), NullLogger<NpmRunner>.Instance, profilingTelemetry);
            var tarballPath = Path.Combine(tempDirectory.FullName, "playwright-cli.tgz");

            var result = await runner.InstallGlobalAsync(tarballPath, TestContext.Current.CancellationToken);

            Assert.True(result);
            Assert.Equal(
                [
                    "install",
                    "-g",
                    tarballPath,
                    "--ignore-scripts",
                    "--registry",
                    "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"
                ],
                await File.ReadAllLinesAsync(argumentsPath, TestContext.Current.CancellationToken));
        }
        finally
        {
            tempDirectory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task ResolvePackageAsync_UsesInternalRegistryForAspireCliLatest()
    {
        var tempDirectory = Directory.CreateTempSubdirectory("aspire-npm-runner-test-");

        try
        {
            WriteFakeNpm(tempDirectory);
            var argumentsPath = Path.Combine(tempDirectory.FullName, "arguments.txt");
            var existingPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            using var pathOverride = new EnvVarOverride(
                "PATH",
                $"{tempDirectory.FullName}{Path.PathSeparator}{existingPath}");
            using var pathExtensionsOverride = OperatingSystem.IsWindows()
                ? new EnvVarOverride("PATHEXT", ".CMD")
                : null;
            using var argumentsPathOverride = new EnvVarOverride("NPM_ARGS_FILE", argumentsPath);
            using var stdoutOverride = new EnvVarOverride("NPM_STDOUT", "13.4.6");
            using var profilingTelemetry = new ProfilingTelemetry(new ConfigurationBuilder().Build());
            var runner = new NpmRunner(
                new TestEnvironment(),
                NullLogger<NpmRunner>.Instance,
                profilingTelemetry);

            var package = await runner.ResolvePackageAsync(
                NpmInstallDetection.ExpectedPackageName,
                "latest",
                TestContext.Current.CancellationToken);

            Assert.NotNull(package);
            Assert.Equal("13.4.6", package.Version.ToString());
            Assert.Equal(
                [
                    "view",
                    "@microsoft/aspire-cli@latest",
                    "version",
                    "--registry",
                    "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"
                ],
                await File.ReadAllLinesAsync(
                    argumentsPath,
                    TestContext.Current.CancellationToken));
        }
        finally
        {
            tempDirectory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task ResolvePackageFromAnonymousInternalRegistryAsync_IgnoresConflictingNpmConfiguration()
    {
        await using var registry = new TestNpmRegistry("13.4.6");
        var tempDirectory = Directory.CreateTempSubdirectory("aspire-npm-runner-test-");

        try
        {
            var npmrcPath = Path.Combine(tempDirectory.FullName, "conflicting.npmrc");
            await File.WriteAllTextAsync(
                npmrcPath,
                $"""
                @microsoft:registry=http://127.0.0.1:9/
                json=true
                //127.0.0.1:{registry.RegistryUri.Port}/:_authToken=ambient-secret
                always-auth=true
                """,
                TestContext.Current.CancellationToken);

            using var userConfigOverride = new EnvVarOverride("NPM_CONFIG_USERCONFIG", npmrcPath);
            using var jsonOverride = new EnvVarOverride("NPM_CONFIG_JSON", "true");
            using var nodeAuthTokenOverride = new EnvVarOverride("NODE_AUTH_TOKEN", "ambient-secret");
            using var npmTokenOverride = new EnvVarOverride("NPM_TOKEN", "ambient-secret");
            using var profilingTelemetry = new ProfilingTelemetry(new ConfigurationBuilder().Build());
            var runner = new NpmRunner(
                new TestEnvironment(),
                NullLogger<NpmRunner>.Instance,
                profilingTelemetry,
                TimeProvider.System,
                registry.RegistryUri.AbsoluteUri);

            Assert.SkipUnless(runner.IsAvailable, "npm is required for this test.");

            var package = await runner.ResolvePackageFromAnonymousInternalRegistryAsync(
                NpmInstallDetection.ExpectedPackageName,
                "latest",
                TestContext.Current.CancellationToken);

            Assert.NotNull(package);
            Assert.Equal("13.4.6", package.Version.ToString());

            var request = await registry.WaitForRequestAsync(
                request => Uri.UnescapeDataString(request.Target) == "/@microsoft/aspire-cli",
                TestContext.Current.CancellationToken);

            Assert.Equal("GET", request.Method);
            Assert.Equal("/@microsoft/aspire-cli", Uri.UnescapeDataString(request.Target));
            Assert.False(request.Headers.ContainsKey("Authorization"));
        }
        finally
        {
            tempDirectory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task ResolvePackageAsync_CancellationTerminatesNpmProcess()
    {
        var tempDirectory = Directory.CreateTempSubdirectory("aspire-npm-runner-test-");
        int? processId = null;

        try
        {
            WriteBlockingFakeNpm(tempDirectory);
            var processIdPath = Path.Combine(tempDirectory.FullName, "process-id.txt");
            var existingPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            using var pathOverride = new EnvVarOverride(
                "PATH",
                $"{tempDirectory.FullName}{Path.PathSeparator}{existingPath}");
            using var pathExtensionsOverride = OperatingSystem.IsWindows()
                ? new EnvVarOverride("PATHEXT", ".CMD")
                : null;
            using var processIdPathOverride = new EnvVarOverride("NPM_PID_FILE", processIdPath);
            using var profilingTelemetry = new ProfilingTelemetry(new ConfigurationBuilder().Build());
            using var cancellationTokenSource = new CancellationTokenSource();
            var runner = new NpmRunner(
                new TestEnvironment(),
                NullLogger<NpmRunner>.Instance,
                profilingTelemetry);

            var resolutionTask = runner.ResolvePackageAsync(
                NpmInstallDetection.ExpectedPackageName,
                "latest",
                cancellationTokenSource.Token);
            processId = await WaitForProcessIdAsync(processIdPath).DefaultTimeout();

            await cancellationTokenSource.CancelAsync();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => resolutionTask).DefaultTimeout();
            await WaitForProcessExitAsync(processId.Value).DefaultTimeout();
        }
        finally
        {
            if (processId is { } runningProcessId)
            {
                TryKillProcess(runningProcessId);
            }

            tempDirectory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task CliUpdateNotifierDispose_TerminatesNpmProcessWithoutHanging()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        using var npmScope = NpmInstallDetection.UseEnvironmentForTesting(
            new Dictionary<string, string?>
            {
                [NpmInstallDetection.PackageEnvironmentVariableName] = NpmInstallDetection.ExpectedPackageName,
                [NpmInstallDetection.PackageVersionEnvironmentVariableName] = "13.4.0",
                [NpmInstallDetection.PackageRidEnvironmentVariableName] = "osx-arm64"
            });
        var tempDirectory = Directory.CreateTempSubdirectory("aspire-npm-runner-test-");
        int? processId = null;

        try
        {
            WriteBlockingFakeNpm(tempDirectory);
            var processIdPath = Path.Combine(tempDirectory.FullName, "process-id.txt");
            var existingPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            using var pathOverride = new EnvVarOverride(
                "PATH",
                $"{tempDirectory.FullName}{Path.PathSeparator}{existingPath}");
            using var pathExtensionsOverride = OperatingSystem.IsWindows()
                ? new EnvVarOverride("PATHEXT", ".CMD")
                : null;
            using var processIdPathOverride = new EnvVarOverride("NPM_PID_FILE", processIdPath);
            using var profilingTelemetry = new ProfilingTelemetry(new ConfigurationBuilder().Build());
            var runner = new NpmRunner(
                new TestEnvironment(),
                NullLogger<NpmRunner>.Instance,
                profilingTelemetry);
            var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, configure =>
            {
                configure.NpmRunnerFactory = _ => runner;
            });
            var provider = services.BuildServiceProvider();
            var notifier = provider.GetRequiredService<ICliUpdateNotifier>();
            var statusTask = notifier.GetVersionStatusAsync(
                workspace.WorkspaceRoot,
                CancellationToken.None);

            processId = await WaitForProcessIdAsync(processIdPath).DefaultTimeout();
            await Task.Run(provider.Dispose).DefaultTimeout();
            await WaitForProcessExitAsync(processId.Value).DefaultTimeout();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => statusTask).DefaultTimeout();
        }
        finally
        {
            if (processId is { } runningProcessId)
            {
                TryKillProcess(runningProcessId);
            }

            tempDirectory.Delete(recursive: true);
        }
    }

    [Fact]
    public void IsExpectedProcessTerminationException_AggregateWithOnlyExpectedExceptions_ReturnsTrue()
    {
        Assert.True(NpmRunner.IsExpectedProcessTerminationException(
            new AggregateException(
                new InvalidOperationException(),
                new System.ComponentModel.Win32Exception())));
    }

    [Fact]
    public void IsExpectedProcessTerminationException_AggregateWithUnexpectedException_ReturnsFalse()
    {
        Assert.False(NpmRunner.IsExpectedProcessTerminationException(
            new AggregateException(
                new InvalidOperationException(),
                new IOException())));
    }

    [Fact]
    public void IsExpectedProcessTerminationException_EmptyAggregate_ReturnsFalse()
    {
        Assert.False(NpmRunner.IsExpectedProcessTerminationException(new AggregateException()));
    }

    [Fact]
    public async Task WaitForProcessExitAfterTerminationAsync_ReturnsFalseWhenBudgetExpires()
    {
        var timeProvider = new FakeTimeProvider();
        var processExit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        var waitTask = NpmRunner.WaitForProcessExitAfterTerminationAsync(processExit.Task, timeProvider);
        await Task.Yield();
        timeProvider.Advance(NpmRunner.ProcessTerminationTimeout);

        Assert.False(await waitTask.DefaultTimeout());
    }

    [Fact]
    public void TryExtractLastVersion_SingleVersion_ReturnsTrimmedVersion()
    {
        var result = NpmRunner.TryExtractLastVersion("0.1.1\n", out var version);
        Assert.True(result);
        Assert.Equal("0.1.1", version);
    }

    [Fact]
    public void TryExtractLastVersion_MultipleVersions_ReturnsLastVersion()
    {
        var output = "@playwright/cli@0.1.1 '0.1.1'\n@playwright/cli@0.1.2 '0.1.2'\n@playwright/cli@0.1.3 '0.1.3'\n";
        var result = NpmRunner.TryExtractLastVersion(output, out var version);
        Assert.True(result);
        Assert.Equal("0.1.3", version);
    }

    [Fact]
    public void TryExtractLastVersion_MultipleVersions_WindowsLineEndings_ReturnsLastVersion()
    {
        var output = "@playwright/cli@0.1.1 '0.1.1'\r\n@playwright/cli@0.1.2 '0.1.2'\r\n@playwright/cli@0.1.3 '0.1.3'\r\n";
        var result = NpmRunner.TryExtractLastVersion(output, out var version);
        Assert.True(result);
        Assert.Equal("0.1.3", version);
    }

    [Fact]
    public void TryExtractLastVersion_EmptyString_ReturnsFalse()
    {
        var result = NpmRunner.TryExtractLastVersion("", out var version);
        Assert.False(result);
        Assert.Null(version);
    }

    [Fact]
    public void TryExtractLastVersion_WhitespaceOnly_ReturnsFalse()
    {
        var result = NpmRunner.TryExtractLastVersion("  \n  \n  ", out var version);
        Assert.False(result);
        Assert.Null(version);
    }

    [Fact]
    public void TryExtractLastVersion_SingleVersionNoNewline_ReturnsTrimmedVersion()
    {
        var result = NpmRunner.TryExtractLastVersion("1.2.3", out var version);
        Assert.True(result);
        Assert.Equal("1.2.3", version);
    }

    [Fact]
    public void TryExtractLastVersion_MultipleVersionsWithPrerelease_ReturnsLastVersion()
    {
        var output = "@scope/pkg@1.0.0-alpha '1.0.0-alpha'\n@scope/pkg@1.0.0 '1.0.0'\n";
        var result = NpmRunner.TryExtractLastVersion(output, out var version);
        Assert.True(result);
        Assert.Equal("1.0.0", version);
    }

    private static void WriteFakeNpm(DirectoryInfo directory)
    {
        if (OperatingSystem.IsWindows())
        {
            File.WriteAllText(
                Path.Combine(directory.FullName, "npm.cmd"),
                """
                @echo off
                type nul > "%NPM_ARGS_FILE%"
                :loop
                if "%~1"=="" goto output
                >> "%NPM_ARGS_FILE%" echo %~1
                shift
                goto loop
                :output
                if defined NPM_STDOUT echo %NPM_STDOUT%
                exit /b 0
                """);
            return;
        }

        var npmPath = Path.Combine(directory.FullName, "npm");
        File.WriteAllText(
            npmPath,
            """
            #!/bin/sh
            printf '%s\n' "$@" > "$NPM_ARGS_FILE"
            if [ -n "$NPM_STDOUT" ]; then
              printf '%s\n' "$NPM_STDOUT"
            fi
            exit 0
            """);
        File.SetUnixFileMode(
            npmPath,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
            UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
    }

    private static void WriteBlockingFakeNpm(DirectoryInfo directory)
    {
        if (OperatingSystem.IsWindows())
        {
            File.WriteAllText(
                Path.Combine(directory.FullName, "npm.cmd"),
                """
                @echo off
                powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$PID | Set-Content -LiteralPath $env:NPM_PID_FILE; while ($true) { Start-Sleep -Milliseconds 100 }"
                """);
            return;
        }

        var npmPath = Path.Combine(directory.FullName, "npm");
        File.WriteAllText(
            npmPath,
            """
            #!/bin/sh
            printf '%s\n' "$$" > "$NPM_PID_FILE"
            while true; do
              sleep 1
            done
            """);
        File.SetUnixFileMode(
            npmPath,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
            UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
    }

    private static async Task<int> WaitForProcessIdAsync(string processIdPath)
    {
        while (true)
        {
            try
            {
                var value = await File.ReadAllTextAsync(
                    processIdPath,
                    TestContext.Current.CancellationToken);
                if (int.TryParse(
                    value,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out var processId))
                {
                    return processId;
                }
            }
            catch (IOException)
            {
            }

            await Task.Delay(10, TestContext.Current.CancellationToken);
        }
    }

    private static async Task WaitForProcessExitAsync(int processId)
    {
        while (true)
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                if (process.HasExited)
                {
                    return;
                }
            }
            catch (ArgumentException)
            {
                return;
            }

            await Task.Delay(10, TestContext.Current.CancellationToken);
        }
    }

    private static void TryKillProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
        }
    }
}
