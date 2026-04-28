// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Backchannel;
using Aspire.Cli.Tests.TestServices;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Cli.Tests.Backchannel;

public class AppHostConnectionResolverTests
{
    [Fact]
    public async Task ResolveConnectionAsync_FallsBackToPlatformPathComparisonWhenAppHostPathCasingDiffers()
    {
        var basePath = Path.Combine(Directory.GetCurrentDirectory(), "case-lookup-" + Guid.NewGuid().ToString("N"));
        var workingDirectory = new DirectoryInfo(Path.Combine(basePath, "repo"));
        var homeDirectory = new DirectoryInfo(Path.Combine(basePath, "home"));
        var actualAppHostPath = Path.Combine(workingDirectory.FullName, "src", "MyApp.AppHost", "MyApp.AppHost.csproj");
        var requestedAppHostPath = actualAppHostPath.Replace("MyApp.AppHost", "myapp.apphost", StringComparison.Ordinal);

        var monitor = new TestAuxiliaryBackchannelMonitor();
        var connection = new TestAppHostAuxiliaryBackchannel
        {
            AppHostInfo = new AppHostInformation
            {
                AppHostPath = actualAppHostPath,
                ProcessId = 1234
            }
        };
        monitor.AddConnection("test-hash", "test-socket", connection);

        var executionContext = new CliExecutionContext(
            workingDirectory,
            new DirectoryInfo(Path.Combine(basePath, "hives")),
            new DirectoryInfo(Path.Combine(basePath, "cache")),
            new DirectoryInfo(Path.Combine(basePath, "sdks")),
            new DirectoryInfo(Path.Combine(basePath, "logs")),
            Path.Combine(basePath, "logs", "test.log"),
            homeDirectory: homeDirectory);
        var resolver = new AppHostConnectionResolver(
            monitor,
            new TestInteractionService(),
            executionContext,
            NullLogger.Instance);

        var result = await resolver.ResolveConnectionAsync(
            new FileInfo(requestedAppHostPath),
            "Scanning for AppHosts",
            "Select an AppHost",
            "No AppHost found",
            CancellationToken.None);

        if (OperatingSystem.IsWindows() || OperatingSystem.IsMacOS())
        {
            Assert.True(result.Success, result.ErrorMessage);
            Assert.Same(connection, result.Connection);
        }
        else
        {
            Assert.False(result.Success);
            Assert.Equal("No AppHost found", result.ErrorMessage);
        }

        Assert.Equal(1, monitor.ScanCallCount);
    }
}
