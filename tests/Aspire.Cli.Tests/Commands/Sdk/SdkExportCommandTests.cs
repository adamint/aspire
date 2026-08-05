// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using Aspire.Cli.Commands;
using Aspire.Cli.Configuration;
using Aspire.Cli.Interaction;
using Aspire.Cli.Projects;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Commands.Sdk;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.DependencyInjection;
using StreamJsonRpc;

namespace Aspire.Cli.Tests.Commands.Sdk;

/// <summary>
/// Covers <c>aspire sdk export</c>. The command exists to feed documentation pipelines, so the
/// discipline it needs is unusual for a CLI command: stdout has to be exactly one machine-readable
/// document with nothing else mixed in, and the package version has to be exact so published
/// documentation can be keyed on it.
/// </summary>
public class SdkExportCommandTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task SdkExportWithHelpReturnsZero()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);
        using var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("sdk export --help");

        var exitCode = await result.InvokeAsync().DefaultTimeout();

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task SdkExportForExactPackageWritesCanonicalDocumentToStdout()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out var rpcClient);
        using var _ = workspace;

        var exitCode = await InvokeAsync(provider, "sdk export --language typescript --package Aspire.Hosting.Redis@13.5.0");

        Assert.Equal(CliExitCodes.Success, exitCode);
        Assert.Equal(("typescript", "Aspire.Hosting.Redis", "13.5.0"), rpcClient.LastExportRequest);

        var stdout = Assert.Single(interactionService.DisplayedRawText, entry => entry.ConsoleOverride == ConsoleOutput.Standard);
        using var document = JsonDocument.Parse(stdout.Text);
        Assert.Equal(1, document.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("Aspire.Hosting.Redis", document.RootElement.GetProperty("package").GetProperty("name").GetString());
    }

    [Fact]
    public async Task SdkExportDefaultsToCoreHostingAtTheRunningSdkVersion()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out var rpcClient);
        using var _ = workspace;

        var exitCode = await InvokeAsync(provider, "sdk export --language typescript");

        Assert.Equal(CliExitCodes.Success, exitCode);

        // Defaulting to the CLI's own SDK version is the entire point of the command: documentation
        // must describe the SDK this CLI would actually generate against, not a floating latest.
        var expectedVersion = provider.GetRequiredService<Aspire.Cli.CliExecutionContext>().IdentityVersion;
        Assert.Equal(("typescript", "Aspire.Hosting", expectedVersion), rpcClient.LastExportRequest);
    }

    [Fact]
    public async Task SdkExportSendsProgressToStderrOnly()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _);
        using var _2 = workspace;

        var exitCode = await InvokeAsync(provider, "sdk export --language typescript --package Aspire.Hosting.Redis@13.5.0");

        Assert.Equal(CliExitCodes.Success, exitCode);
        Assert.DoesNotContain(
            interactionService.DisplayedMessages,
            message => message.ConsoleOverride == ConsoleOutput.Standard);
    }

    [Fact]
    public async Task SdkExportPassesPackageSourceThroughToPrepare()
    {
        var interactionService = new TestInteractionService();
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appHostServerProject = new CapturingAppHostServerProject(workspace.WorkspaceRoot.FullName);
        using var provider = CreateProvider(interactionService, workspace, new StubExportRpcClient(), appHostServerProject);

        var exitCode = await InvokeAsync(provider, "sdk export --language typescript --package Aspire.Hosting.Redis@13.5.0 --source /tmp/aspire-hive");

        Assert.Equal(CliExitCodes.Success, exitCode);
        Assert.Equal("/tmp/aspire-hive", appHostServerProject.PackageSourceOverride);
    }

    /// <summary>
    /// The code generator ships in its own package that the scanner AppHost does not reference by
    /// default. Without adding it the server loads no generators and every export fails with
    /// "No code generator found", which is exactly how this regressed once already.
    /// </summary>
    [Fact]
    public async Task SdkExportAddsTheCodeGenerationPackageForTheRequestedLanguage()
    {
        var interactionService = new TestInteractionService();
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appHostServerProject = new CapturingAppHostServerProject(workspace.WorkspaceRoot.FullName);
        using var provider = CreateProvider(interactionService, workspace, new StubExportRpcClient(), appHostServerProject);

        var exitCode = await InvokeAsync(provider, "sdk export --language typescript --package Aspire.Hosting.Redis@13.5.0");

        Assert.Equal(CliExitCodes.Success, exitCode);
        Assert.Contains(
            appHostServerProject.Integrations,
            integration => integration.Name.Contains("CodeGeneration", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("Aspire.Hosting")]
    [InlineData("Aspire.Hosting@")]
    [InlineData("@13.5.0")]
    [InlineData("Aspire.Hosting@not-a-version")]
    [InlineData("Aspire@Hosting@13.5.0")]
    public async Task SdkExportWithMalformedPackageReturnsInvalidCommand(string package)
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _);
        using var _2 = workspace;

        var exitCode = await InvokeAsync(provider, $"sdk export --language typescript --package \"{package}\"");

        Assert.Equal(CliExitCodes.InvalidCommand, exitCode);
        Assert.Empty(interactionService.DisplayedRawText);
    }

    [Fact]
    public async Task SdkExportWithMismatchedCoreVersionReturnsInvalidCommand()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _);
        using var _2 = workspace;

        // The scanner loads the core assemblies this CLI ships with, so honouring a different core
        // version would export this CLI's surface under someone else's version number — the same
        // stale-signature problem this command exists to fix.
        var exitCode = await InvokeAsync(provider, "sdk export --language typescript --package Aspire.Hosting@1.0.0");

        Assert.Equal(CliExitCodes.InvalidCommand, exitCode);
        Assert.Empty(interactionService.DisplayedRawText);
    }

    [Fact]
    public async Task SdkExportAcceptsCoreVersionThatDiffersOnlyByBuildMetadata()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _);
        using var _2 = workspace;

        var executionContext = provider.GetRequiredService<Aspire.Cli.CliExecutionContext>();

        var exitCode = await InvokeAsync(
            provider,
            $"sdk export --language typescript --package Aspire.Hosting@{executionContext.IdentitySdkVersion}+build.5");

        Assert.Equal(0, exitCode);
    }

    [Theory]
    [InlineData("13.5.*")]
    [InlineData("[13.5.0,14.0.0)")]
    [InlineData("13.5.0-*")]
    public async Task SdkExportWithFloatingVersionReturnsInvalidCommand(string version)
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _);
        using var _2 = workspace;

        // Floating versions are rejected before restore rather than resolved, because a document
        // published under a range would silently describe a different SDK on the next restore.
        var exitCode = await InvokeAsync(provider, $"sdk export --language typescript --package \"Aspire.Hosting@{version}\"");

        Assert.Equal(CliExitCodes.InvalidCommand, exitCode);
        Assert.Empty(interactionService.DisplayedRawText);
    }

    [Fact]
    public async Task SdkExportWithUnsupportedLanguageReturnsInvalidCommand()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _, new ThrowingExportRpcClient(
            new NotSupportedException("The 'Go' code generator does not implement IApiReferenceExporter.")));
        using var _2 = workspace;

        var exitCode = await InvokeAsync(provider, "sdk export --language go --package Aspire.Hosting@13.5.0");

        Assert.Equal(CliExitCodes.InvalidCommand, exitCode);
        Assert.Empty(interactionService.DisplayedRawText);
    }

    [Fact]
    public async Task SdkExportWhenRpcFailsReturnsFailureAndWritesNothingToStdout()
    {
        var interactionService = new TestInteractionService();
        using var provider = CreateProvider(interactionService, out var workspace, out _, new ThrowingExportRpcClient(
            new RemoteInvocationException("apphost blew up", 0, errorData: null)));
        using var _2 = workspace;

        var exitCode = await InvokeAsync(provider, "sdk export --language typescript --package Aspire.Hosting@13.5.0");

        Assert.NotEqual(CliExitCodes.Success, exitCode);

        // A partial document is worse than none: a consumer would publish it as if it were complete.
        Assert.Empty(interactionService.DisplayedRawText);
    }

    [Fact]
    public async Task SdkDumpJsonPayloadIsUnchangedByTheSharedPreparationExtraction()
    {
        // sdk export and sdk dump now share preparation code but nothing else. This lives beside the
        // export tests because it guards the extraction, not dump's own behaviour: dump must keep
        // producing its existing capabilities payload and must not be routed through the canonical
        // exporter.
        var interactionService = new TestInteractionService();
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var rpcClient = new CapabilitiesRpcClient();
        using var provider = CreateProvider(
            interactionService,
            workspace,
            rpcClient,
            new FakeSucceedingAppHostServerProject(workspace.WorkspaceRoot.FullName));

        var exitCode = await InvokeAsync(provider, "sdk dump --format json Aspire.Hosting.Redis@13.5.0");

        Assert.Equal(CliExitCodes.Success, exitCode);
        Assert.Equal(["Aspire.Hosting.Redis"], rpcClient.LastAssemblyNames);

        var stdout = Assert.Single(interactionService.DisplayedRawText);
        using var document = JsonDocument.Parse(stdout.Text);

        // The capabilities shape, not the canonical export schema.
        Assert.False(document.RootElement.TryGetProperty("schemaVersion", out _));
        Assert.True(document.RootElement.TryGetProperty("Capabilities", out _));
    }

    private static async Task<int> InvokeAsync(ServiceProvider provider, string commandLine)
    {
        var command = provider.GetRequiredService<RootCommand>();
        return await command.Parse(commandLine).InvokeAsync().DefaultTimeout();
    }

    private ServiceProvider CreateProvider(
        TestInteractionService interactionService,
        out TemporaryWorkspace workspace,
        out StubExportRpcClient rpcClient,
        IAppHostRpcClient? overrideRpcClient = null)
    {
        workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        rpcClient = new StubExportRpcClient();
        return CreateProvider(
            interactionService,
            workspace,
            overrideRpcClient ?? rpcClient,
            new FakeSucceedingAppHostServerProject(workspace.WorkspaceRoot.FullName));
    }

    private ServiceProvider CreateProvider(
        TestInteractionService interactionService,
        TemporaryWorkspace workspace,
        IAppHostRpcClient rpcClient,
        IAppHostServerProject appHostServerProject)
    {
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, options =>
        {
            options.InteractionServiceFactory = _ => interactionService;
        });

        services.AddSingleton<IAppHostServerProjectFactory>(new TestAppHostServerProjectFactory
        {
            CreateAsyncCallback = (_, _) => Task.FromResult(appHostServerProject)
        });
        services.AddSingleton<IAppHostServerSessionFactory>(new FakeAppHostServerSessionFactory
        {
            Session = new FakeAppHostServerSession(rpcClient)
        });

        return services.BuildServiceProvider();
    }

    private sealed class StubExportRpcClient : FakeAppHostRpcClient
    {
        public (string Language, string PackageName, string PackageVersion)? LastExportRequest { get; private set; }

        public override Task<JsonElement> ExportApiAsync(string languageId, string packageName, string packageVersion, CancellationToken cancellationToken)
        {
            LastExportRequest = (languageId, packageName, packageVersion);

            using var document = JsonDocument.Parse($$"""
                {
                  "schemaVersion": 1,
                  "language": "{{languageId}}",
                  "package": { "name": "{{packageName}}", "version": "{{packageVersion}}" },
                  "modules": [],
                  "declarations": []
                }
                """);

            return Task.FromResult(document.RootElement.Clone());
        }
    }

    private sealed class ThrowingExportRpcClient(Exception exception) : FakeAppHostRpcClient
    {
        public override Task<JsonElement> ExportApiAsync(string languageId, string packageName, string packageVersion, CancellationToken cancellationToken)
            => Task.FromException<JsonElement>(exception);
    }

    private sealed class CapabilitiesRpcClient : FakeAppHostRpcClient
    {
        public IReadOnlyList<string>? LastAssemblyNames { get; private set; }

        public override Task<CapabilitiesInfo> GetCapabilitiesForAssembliesAsync(IReadOnlyList<string> assemblyNames, CancellationToken cancellationToken)
        {
            LastAssemblyNames = assemblyNames;
            return Task.FromResult(new CapabilitiesInfo());
        }
    }

    private sealed class CapturingAppHostServerProject(string appDirectoryPath) : IAppHostServerProject
    {
        public string AppDirectoryPath { get; } = appDirectoryPath;

        public string? PackageSourceOverride { get; private set; }

        public IReadOnlyList<IntegrationReference> Integrations { get; private set; } = [];

        public string GetInstanceIdentifier() => AppDirectoryPath;

        public Task<AppHostServerPrepareResult> PrepareAsync(
            string sdkVersion,
            IEnumerable<IntegrationReference> integrations,
            string? requestedChannel = null,
            string? packageSourceOverride = null,
            CancellationToken cancellationToken = default)
        {
            PackageSourceOverride = packageSourceOverride;
            Integrations = [.. integrations];
            return Task.FromResult(new AppHostServerPrepareResult(Success: true, Output: null));
        }

        public Task<AppHostServerRunResult> RunAsync(
            int hostPid,
            IReadOnlyDictionary<string, string>? environmentVariables,
            string[]? additionalArgs,
            bool debug,
            AppHostServerRunControl? runControl)
            => throw new NotSupportedException("Run should not be invoked when using a fake codegen session.");
    }
}
