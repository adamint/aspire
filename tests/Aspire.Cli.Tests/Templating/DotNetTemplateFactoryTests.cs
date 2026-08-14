// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.CommandLine;
using Microsoft.AspNetCore.InternalTesting;
using System.Diagnostics;
using System.Text.Json;
using Aspire.Cli.Backchannel;
using Aspire.Cli.Certificates;
using Aspire.Cli.Commands;
using Aspire.Cli.Configuration;
using Aspire.Cli.DotNet;
using Aspire.Cli.Interaction;
using Aspire.Cli.Packaging;
using Aspire.Cli.Templating;
using Aspire.Cli.Tests.Telemetry;
using Aspire.Cli.Tests.TestServices;
using Microsoft.Extensions.Logging.Abstractions;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils;
using Aspire.Shared;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace Aspire.Cli.Tests.Templating;

public class DotNetTemplateFactoryTests
{
    private readonly ITestOutputHelper _outputHelper;

    public DotNetTemplateFactoryTests(ITestOutputHelper outputHelper)
    {
        _outputHelper = outputHelper;
    }

    private static PackageChannel CreateExplicitChannel(PackageMapping[] mappings) =>
        PackageChannel.CreateExplicitChannel("test", PackageChannelQuality.Both, mappings, new FakeNuGetPackageCache(), new TestFeatures(), NullLogger.Instance);

    private static async Task WriteNuGetConfigAsync(DirectoryInfo dir, string content)
    {
        var path = Path.Combine(dir.FullName, "nuget.config");
        await File.WriteAllTextAsync(path, content);
    }

    /// <summary>
    /// Test that simulates the path comparison logic by testing NuGetConfigMerger behavior
    /// directly, which is what PromptToCreateOrUpdateNuGetConfigAsync will ultimately call.
    /// </summary>
    [Fact]
    public async Task NuGetConfigMerger_InPlaceCreation_WithoutExistingConfig_CreatesInWorkingDirectory()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;

        var mappings = new[]
        {
            new PackageMapping("Aspire.*", "https://test.feed.example.com")
        };
        var channel = CreateExplicitChannel(mappings);

        // Act - Simulate in-place creation: output directory same as working directory
        await NuGetConfigMerger.CreateOrUpdateAsync(workingDir, channel).DefaultTimeout();

        // Assert
        var nugetConfigPath = Path.Combine(workingDir.FullName, "nuget.config");
        Assert.True(File.Exists(nugetConfigPath), "nuget.config should be created in working directory for in-place creation");
    }

    [Fact]
    public async Task NuGetConfigMerger_InPlaceCreation_WithExistingConfig_UpdatesWorkingDirectoryConfig()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;

        // Create existing NuGet.config in working directory without the required source
        await WriteNuGetConfigAsync(workingDir,
            """
            <?xml version="1.0"?>
            <configuration>
                <packageSources>
                    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
                </packageSources>
            </configuration>
            """);

        var mappings = new[]
        {
            new PackageMapping("Aspire.*", "https://test.feed.example.com")
        };
        var channel = CreateExplicitChannel(mappings);

        // Act - Simulate in-place creation: output directory same as working directory
        await NuGetConfigMerger.CreateOrUpdateAsync(workingDir, channel).DefaultTimeout();

        // Assert
        var nugetConfigPath = Path.Combine(workingDir.FullName, "nuget.config");
        Assert.True(File.Exists(nugetConfigPath), "nuget.config should exist in working directory");

        var content = await File.ReadAllTextAsync(nugetConfigPath);
        Assert.Contains("https://test.feed.example.com", content);
    }

    [Fact]
    public async Task NuGetConfigMerger_SubdirectoryCreation_WithParentConfig_IgnoresParentAndCreatesInOutputDirectory()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;
        var outputDir = Directory.CreateDirectory(Path.Combine(workingDir.FullName, "MyProject"));

        // Create existing NuGet.config in working directory (parent)
        var parentConfigContent =
            """
            <?xml version="1.0"?>
            <configuration>
                <packageSources>
                    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
                </packageSources>
            </configuration>
            """;
        await WriteNuGetConfigAsync(workingDir, parentConfigContent).DefaultTimeout();

        var mappings = new[]
        {
            new PackageMapping("Aspire.*", "https://test.feed.example.com")
        };
        var channel = CreateExplicitChannel(mappings);

        // Act - Simulate subdirectory creation: output directory different from working directory
        await NuGetConfigMerger.CreateOrUpdateAsync(outputDir, channel).DefaultTimeout();

        // Assert
        // Parent nuget.config should remain unchanged
        var parentConfigPath = Path.Combine(workingDir.FullName, "nuget.config");
        var parentContent = await File.ReadAllTextAsync(parentConfigPath);
        Assert.Equal(parentConfigContent.ReplaceLineEndings(), parentContent.ReplaceLineEndings());
        Assert.DoesNotContain("https://test.feed.example.com", parentContent);

        // New nuget.config should be created in output directory
        var outputConfigPath = Path.Combine(outputDir.FullName, "nuget.config");
        Assert.True(File.Exists(outputConfigPath), "nuget.config should be created in output directory");

        var outputContent = await File.ReadAllTextAsync(outputConfigPath);
        Assert.Contains("https://test.feed.example.com", outputContent);
    }

    [Fact]
    public async Task NuGetConfigMerger_SubdirectoryCreation_WithExistingConfigInOutputDirectory_MergesInOutputDirectory()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;
        var outputDir = Directory.CreateDirectory(Path.Combine(workingDir.FullName, "MyProject"));

        // Create existing NuGet.config in output directory
        await WriteNuGetConfigAsync(outputDir,
            """
            <?xml version="1.0"?>
            <configuration>
                <packageSources>
                    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
                </packageSources>
            </configuration>
            """);

        var mappings = new[]
        {
            new PackageMapping("Aspire.*", "https://test.feed.example.com")
        };
        var channel = CreateExplicitChannel(mappings);

        // Act - Simulate subdirectory creation: merge into existing config in output directory
        await NuGetConfigMerger.CreateOrUpdateAsync(outputDir, channel).DefaultTimeout();

        // Assert
        var outputConfigPath = Path.Combine(outputDir.FullName, "nuget.config");
        Assert.True(File.Exists(outputConfigPath), "nuget.config should exist in output directory");

        var content = await File.ReadAllTextAsync(outputConfigPath);
        Assert.Contains("https://test.feed.example.com", content);
        Assert.Contains("https://api.nuget.org/v3/index.json", content);
    }

    [Fact]
    public async Task NuGetConfigMerger_SubdirectoryCreation_WithoutAnyConfig_CreatesInOutputDirectory()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;
        var outputDir = Directory.CreateDirectory(Path.Combine(workingDir.FullName, "MyProject"));

        var mappings = new[]
        {
            new PackageMapping("Aspire.*", "https://test.feed.example.com")
        };
        var channel = CreateExplicitChannel(mappings);

        // Act - Simulate subdirectory creation: create new config in output directory
        await NuGetConfigMerger.CreateOrUpdateAsync(outputDir, channel).DefaultTimeout();

        // Assert
        // No nuget.config should exist in working directory
        var workingConfigPath = Path.Combine(workingDir.FullName, "nuget.config");
        Assert.False(File.Exists(workingConfigPath), "No nuget.config should be created in working directory");

        // New nuget.config should be created in output directory
        var outputConfigPath = Path.Combine(outputDir.FullName, "nuget.config");
        Assert.True(File.Exists(outputConfigPath), "nuget.config should be created in output directory");

        var content = await File.ReadAllTextAsync(outputConfigPath);
        Assert.Contains("https://test.feed.example.com", content);
    }

    [Fact]
    public async Task NuGetConfigMerger_ImplicitChannel_DoesNothing()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;
        var outputDir = Directory.CreateDirectory(Path.Combine(workingDir.FullName, "MyProject"));

        var channel = PackageChannel.CreateImplicitChannel(new FakeNuGetPackageCache(), new TestFeatures(), NullLogger.Instance);

        // Act
        await NuGetConfigMerger.CreateOrUpdateAsync(outputDir, channel).DefaultTimeout();

        // Assert
        // No nuget.config should be created anywhere
        var workingConfigPath = Path.Combine(workingDir.FullName, "nuget.config");
        var outputConfigPath = Path.Combine(outputDir.FullName, "nuget.config");
        Assert.False(File.Exists(workingConfigPath), "No nuget.config should be created for implicit channel");
        Assert.False(File.Exists(outputConfigPath), "No nuget.config should be created for implicit channel");
    }

    [Fact]
    public async Task NuGetConfigMerger_ExplicitChannelWithoutMappings_DoesNothing()
    {
        // Arrange
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var workingDir = workspace.WorkspaceRoot;
        var outputDir = Directory.CreateDirectory(Path.Combine(workingDir.FullName, "MyProject"));

        var channel = CreateExplicitChannel([]); // No mappings

        // Act
        await NuGetConfigMerger.CreateOrUpdateAsync(outputDir, channel).DefaultTimeout();

        // Assert
        // No nuget.config should be created anywhere
        var workingConfigPath = Path.Combine(workingDir.FullName, "nuget.config");
        var outputConfigPath = Path.Combine(outputDir.FullName, "nuget.config");
        Assert.False(File.Exists(workingConfigPath), "No nuget.config should be created when no mappings exist");
        Assert.False(File.Exists(outputConfigPath), "No nuget.config should be created when no mappings exist");
    }

    [Fact]
    public async Task GetTemplates_WhenShowAllTemplatesIsEnabled_ReturnsAllTemplates()
    {
        // Arrange
        var features = new TestFeatures().SetFeature(KnownFeatures.ShowAllTemplates, true);
        var factory = CreateTemplateFactory(features);

        // Act
        var templates = (await factory.GetTemplatesAsync()).ToList();

        // Assert
        var templateNames = templates.Select(t => t.Name).ToList();
        Assert.Contains("aspire-starter", templateNames);
        Assert.Contains("aspire", templateNames);
        Assert.Contains("aspire-apphost", templateNames);
        Assert.Contains("aspire-servicedefaults", templateNames);
        Assert.Contains("aspire-test", templateNames);
    }

    [Fact]
    public async Task GetTemplates_WhenShowAllTemplatesIsDisabled_ReturnsOnlyStarterTemplates()
    {
        // Arrange
        var features = new TestFeatures();
        var factory = CreateTemplateFactory(features);

        // Act
        var templates = (await factory.GetTemplatesAsync()).ToList();

        // Assert
        var templateNames = templates.Select(t => t.Name).ToList();
        Assert.Contains("aspire-starter", templateNames);
        Assert.DoesNotContain(KnownTemplateId.DotNetEmptyAppHost, templateNames);
        Assert.DoesNotContain("aspire-apphost", templateNames);
        Assert.DoesNotContain("aspire-servicedefaults", templateNames);
        Assert.DoesNotContain("aspire-test", templateNames);
    }

    [Fact]
    public async Task GetTemplates_SingleFileAppHostIsNotReturned()
    {
        // Arrange
        var features = new TestFeatures();
        var factory = CreateTemplateFactory(features);

        // Act
        var templates = (await factory.GetTemplatesAsync()).ToList();

        // Assert
        var templateNames = templates.Select(t => t.Name).ToList();
        Assert.DoesNotContain("aspire-apphost-singlefile", templateNames);
        Assert.DoesNotContain("aspire-py-starter", templateNames);
    }

    [Fact]
    public async Task GetInitTemplates_IncludesSingleFileAppHostTemplate()
    {
        // Arrange
        var features = new TestFeatures();
        var factory = CreateTemplateFactory(features);

        // Act
        var templates = (await factory.GetInitTemplatesAsync()).ToList();

        // Assert
        var templateNames = templates.Select(t => t.Name).ToList();
        Assert.Contains("aspire-apphost-singlefile", templateNames);
    }

    [Fact]
    public async Task GetTemplates_WhenDotNetSdkIsUnavailable_ReturnsNoTemplates()
    {
        // Arrange
        var features = new TestFeatures().SetFeature(KnownFeatures.ShowAllTemplates, true);
        var sdkInstaller = new TestDotNetSdkInstaller
        {
            CheckAsyncCallback = _ => (false, null, "10.0.100")
        };
        var factory = CreateTemplateFactory(features, sdkInstaller: sdkInstaller);

        // Act
        var templates = await factory.GetTemplatesAsync();

        // Assert
        Assert.Empty(templates);
    }

    [Theory]
    [InlineData(true, null, false)]
    [InlineData(false, "https://internal.example/v3/index.json", false)]
    [InlineData(true, "https://internal.example/v3/index.json", true)]
    public void ShouldRestoreAfterTemplate_OnlyRestoresSourceBackedOwningTemplates(bool ownsAspireConfig, string? source, bool expected)
    {
        var template = new CallbackTemplate(
            "test",
            "test",
            (_, _) => string.Empty,
            _ => { },
            (_, _, _, _) => Task.FromResult(new TemplateResult(CliExitCodes.Success)),
            ownsAspireConfig: ownsAspireConfig);
        var inputs = new TemplateInputs
        {
            Source = source,
            SourcePolicy = source is null ? PackageSourceRoutingPolicy.None : PackageSourceRoutingPolicy.ProjectLocalConfigured
        };

        Assert.Equal(expected, DotNetTemplateFactory.ShouldRestoreAfterTemplate(template, inputs));
    }

    [Fact]
    public async Task GetTemplates_OwningDotNetTemplatesDeclareRestoreSuppressionArguments()
    {
        var factory = CreateTemplateFactory(new TestFeatures().SetFeature(KnownFeatures.ShowAllTemplates, true));
        var templates = (await factory.GetTemplatesAsync()).ToDictionary(t => t.Name);

        Assert.Equal(["--skipRestore"], ((CallbackTemplate)templates["aspire-starter"]).RestoreSuppressionArguments);
        Assert.Equal(["--no-restore"], ((CallbackTemplate)templates["aspire"]).RestoreSuppressionArguments);
        Assert.Equal(["--no-restore"], ((CallbackTemplate)templates["aspire-apphost"]).RestoreSuppressionArguments);

        var initTemplate = (CallbackTemplate)(await factory.GetInitTemplatesAsync()).Single();
        Assert.Equal(["--no-restore"], initTemplate.RestoreSuppressionArguments);
    }

    [Theory]
    [InlineData("aspire-starter", "aspire-starter", "--skipRestore")]
    [InlineData("aspire-apphost", "aspire-apphost", "--no-restore")]
    [InlineData("aspire-empty", "aspire", "--no-restore")]
    [InlineData("aspire-apphost-singlefile", "aspire-apphost-singlefile", "--no-restore")]
    public async Task ActualTemplateEngine_ExposesExpectedRestoreAlias(
        string templateDirectoryName,
        string templateName,
        string expectedRestoreArgument)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var hive = workspace.CreateDirectory("template-hive");
        var templatePath = Path.Combine(
            GetRepoRoot(),
            "src",
            "Aspire.ProjectTemplates",
            "templates",
            templateDirectoryName);

        var installResult = await RunDotNetAsync(
            ["new", "install", templatePath, "--debug:custom-hive", hive.FullName],
            workspace.Path);
        Assert.Equal(0, installResult.ExitCode);

        var helpResult = await RunDotNetAsync(
            ["new", templateName, "--help", "--debug:custom-hive", hive.FullName],
            workspace.Path);
        Assert.Equal(0, helpResult.ExitCode);
        Assert.Contains(expectedRestoreArgument, helpResult.Output);

        var unexpectedRestoreArgument = expectedRestoreArgument == "--skipRestore"
            ? "--no-restore"
            : "--skipRestore";
        Assert.DoesNotContain(unexpectedRestoreArgument, helpResult.Output);
    }

    [Fact]
    public void FindAppHostRestoreTarget_UsesConfiguredEntryPointForArbitraryProjectName()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var output = workspace.CreateDirectory("output");
        var projectDirectory = output.CreateSubdirectory("src");
        var projectPath = Path.Combine(projectDirectory.FullName, "CustomProject.csproj");
        var entryPointPath = Path.Combine(projectDirectory.FullName, "CustomEntry.cs");
        File.WriteAllText(projectPath, "<Project />");
        File.WriteAllText(entryPointPath, "public class CustomEntry { }");
        File.WriteAllText(
            Path.Combine(output.FullName, AspireConfigFile.FileName),
            """
            {
              "appHost": {
                "path": "src/CustomEntry.cs"
              }
            }
            """);

        var target = DotNetTemplateFactory.FindAppHostRestoreTarget(output.FullName);

        Assert.Equal(projectPath, target?.FullName);
    }

    [Fact]
    public void FindAppHostRestoreTarget_UsesSingleFilePrimaryOutput()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var output = workspace.CreateDirectory("output");
        var appHostPath = Path.Combine(output.FullName, "custom-entry.cs");
        File.WriteAllText(appHostPath, "Console.WriteLine(\"hello\");");

        var target = DotNetTemplateFactory.FindAppHostRestoreTarget(output.FullName);

        Assert.Equal(appHostPath, target?.FullName);
    }

    [Fact]
    public async Task ApplyTemplateAsync_WithConfiguredSource_PropagatesRestoreFailureAndUsesResolvedTarget()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(_outputHelper);
        var output = workspace.CreateDirectory("output");
        var projectPath = Path.Combine(output.FullName, "CustomProject.csproj");
        string[]? newProjectArguments = null;
        var runner = new TestDotNetCliRunner
        {
            NewProjectAsyncCallback = (_, _, outputPath, extraArgs, _, _) =>
            {
                newProjectArguments = extraArgs;
                File.WriteAllText(projectPath, "<Project />");
                File.WriteAllText(
                    Path.Combine(outputPath, AspireConfigFile.FileName),
                    """
                    {
                      "appHost": {
                        "path": "CustomProject.csproj"
                      }
                    }
                    """);
                return 0;
            }
        };
        var restoreCalls = new List<FileInfo>();
        runner.RestoreAsyncCallback = (projectFile, _, _) =>
        {
            restoreCalls.Add(projectFile);
            return 7;
        };
        var packageCache = new FakeNuGetPackageCache
        {
            GetTemplatePackagesAsyncCallback = (_, _, _, _) => Task.FromResult<IEnumerable<Aspire.Shared.NuGetPackageCli>>(
            [
                new Aspire.Shared.NuGetPackageCli
                {
                    Id = TemplateNuGetConfigService.TemplatesPackageName,
                    Version = "13.5.0",
                    Source = "https://internal.example/v3/index.json"
                }
            ])
        };
        var packagingService = new TestPackagingService
        {
            GetChannelsAsyncCallback = _ => Task.FromResult<IEnumerable<PackageChannel>>(
            [
                PackageChannel.CreateImplicitChannel(packageCache, new TestFeatures(), NullLogger.Instance)
            ])
        };
        var factory = CreateTemplateFactory(
            new TestFeatures().SetFeature(KnownFeatures.ShowAllTemplates, true),
            runner: runner,
            packagingService: packagingService);
        var template = (CallbackTemplate)factory.GetTemplates().Single(t => t.Name == "aspire-apphost");

        var result = await template.ApplyTemplateAsync(
            new TemplateInputs
            {
                Name = "CustomProject",
                Output = output.FullName,
                Source = "https://internal.example/v3/index.json",
                SourcePolicy = PackageSourceRoutingPolicy.ProjectLocalConfigured,
                Version = "13.5.0"
            },
            new System.CommandLine.RootCommand().Parse([]),
            CancellationToken.None);

        Assert.Equal(CliExitCodes.FailedToBuildArtifacts, result.ExitCode);
        Assert.Contains("--no-restore", newProjectArguments!);
        var restoreCall = Assert.Single(restoreCalls);
        Assert.Equal(projectPath, restoreCall.FullName);
    }

    private static DotNetTemplateFactory CreateTemplateFactory(
        TestFeatures features,
        bool nonInteractive = false,
        TestDotNetSdkInstaller? sdkInstaller = null,
        TestDotNetCliRunner? runner = null,
        TestPackagingService? packagingService = null)
    {
        var interactionService = new TestInteractionService();
        runner ??= new TestDotNetCliRunner();
        var certificateService = new TestCertificateService();
        packagingService ??= new TestPackagingService();
        var prompter = new TestNewCommandPrompter();
        var workingDirectory = new DirectoryInfo("/tmp");
        var executionContext = TestExecutionContextHelper.CreateExecutionContext(workingDirectory);
        sdkInstaller ??= new TestDotNetSdkInstaller();
        var telemetry = TestTelemetryHelper.CreateInitializedTelemetry();
        var hostEnvironment = new FakeCliHostEnvironment(nonInteractive);
        var templateNuGetConfigService = new TemplateNuGetConfigService(interactionService, executionContext, packagingService, prompter, hostEnvironment);

        return new DotNetTemplateFactory(
            interactionService,
            runner,
            certificateService,
            prompter,
            executionContext,
            sdkInstaller,
            features,
            telemetry,
            hostEnvironment,
            templateNuGetConfigService,
            new HostEnvironment());
    }

    private static async Task<(int ExitCode, string Output)> RunDotNetAsync(
        IReadOnlyList<string> arguments,
        string workingDirectory)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo("dotnet")
            {
                WorkingDirectory = workingDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        Assert.True(process.Start());

        // Read both streams concurrently so a template-engine diagnostic cannot fill a pipe
        // while the test waits for the process to exit.
        var standardOutputTask = process.StandardOutput.ReadToEndAsync();
        var standardErrorTask = process.StandardError.ReadToEndAsync();
        using var timeout = AsyncTestHelpers.CreateDefaultTimeoutTokenSource(TestConstants.LongTimeoutDuration);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }

            throw new TimeoutException($"Process '{process.StartInfo.FileName}' did not exit within the timeout.");
        }

        var output = await standardOutputTask + await standardErrorTask;
        return (process.ExitCode, output);
    }

    private static string GetRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "global.json")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Could not locate the Aspire repository root.");
    }

    private sealed class TestInteractionService : IInteractionService
    {
        public ConsoleOutput Console { get; set; }
        public bool SupportsLinks { get; set; }

        public Task<T> PromptForSelectionAsync<T>(string prompt, IEnumerable<T> choices, Func<T, string> displaySelector, PromptBinding<string?>? binding = null, bool echoSelected = true, CancellationToken cancellationToken = default) where T : notnull
            => throw new NotImplementedException();

        public Task<IReadOnlyList<T>> PromptForSelectionsAsync<T>(string promptText, IEnumerable<T> choices, Func<T, string> choiceFormatter, IEnumerable<T>? preSelected = null, bool optional = false, PromptBinding<string?>? binding = null, bool echoSelected = true, IEnumerable<T>? bindingChoices = null, CancellationToken cancellationToken = default) where T : notnull
            => throw new NotImplementedException();

        public Task<string> PromptForStringAsync(string promptText, Func<string, ValidationResult>? validator = null, bool isSecret = false, bool required = false, PromptBinding<string?>? binding = null, CancellationToken cancellationToken = default)
            => throw new NotImplementedException();

        public Task<string> PromptForFilePathAsync(string promptText, Func<string, ValidationResult>? validator = null, bool directory = false, bool required = false, PromptBinding<string?>? binding = null, CancellationToken cancellationToken = default)
            => throw new NotImplementedException();

        public Task<bool> PromptConfirmAsync(string prompt, PromptBinding<bool>? binding = null, CancellationToken cancellationToken = default)
            => throw new NotImplementedException();

        public Task<TResult> ShowStatusAsync<TResult>(string message, Func<Task<TResult>> work, KnownEmoji? emoji = null, bool allowMarkup = false)
            => work();

        public Task<TResult> ShowDynamicStatusAsync<TResult>(string initialStatusText, Func<Action<string>, Task<TResult>> action, KnownEmoji? emoji = null)
            => throw new NotImplementedException();

        public Task ShowStatusAsync(string message, Func<Task> work)
            => throw new NotImplementedException();

        public void ShowStatus(string message, Action work, KnownEmoji? emoji = null, bool allowMarkup = false)
            => throw new NotImplementedException();

        public void DisplaySuccess(string message, bool allowMarkup = false) { }
        public void DisplayError(string message, bool allowMarkup = false) { }
        public void DisplayMessage(KnownEmoji emoji, string message, bool allowMarkup = false, ConsoleOutput? consoleOverride = null) { }
        public void DisplayLines(IEnumerable<(OutputLineStream Stream, string Line)> lines) { }
        public void DisplayCancellationMessage(string? message = null, ConsoleOutput? consoleOverride = null) { }
        public int DisplayIncompatibleVersionError(AppHostIncompatibleException ex, string appHostHostingVersion) => 0;
        public void DisplayPlainText(string text) { }
        public void DisplayRawText(string text, ConsoleOutput? consoleOverride = null) { }
        public void DisplayMarkdown(string markdown, ConsoleOutput? consoleOverride = null, int? maxWidth = null) { }
        public void DisplayMarkupLine(string markup) { }
        public void DisplaySubtleMessage(string message, bool allowMarkup = false) { }
        public void DisplayEmptyLine() { }
        public void DisplayVersionUpdateNotification(string message, string? updateCommand = null) { }
        public void WriteConsoleLog(string message, int? resourceHashCode, string? resourceName, bool isError) { }
        public void DisplayRenderable(IRenderable renderable) { }
        public Task DisplayLiveAsync(IRenderable initialRenderable, Func<Action<IRenderable>, Task> callback) => callback(_ => { });
    }

    private sealed class TestDotNetCliRunner : IDotNetCliRunner
    {
        public Func<string, string, FileInfo?, string?, bool, ProcessInvocationOptions, CancellationToken, (int ExitCode, string? TemplateVersion)>? InstallTemplateAsyncCallback { get; set; }
        public Func<string, string, string, string[], ProcessInvocationOptions, CancellationToken, int>? NewProjectAsyncCallback { get; set; }
        public Func<FileInfo, ProcessInvocationOptions, CancellationToken, int>? RestoreAsyncCallback { get; set; }

        public Task<(int ExitCode, string? TemplateVersion)> InstallTemplateAsync(string packageName, string version, FileInfo? nugetConfigFile, string? nugetSource, bool force, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => Task.FromResult(InstallTemplateAsyncCallback is not null
                ? InstallTemplateAsyncCallback(packageName, version, nugetConfigFile, nugetSource, force, options, cancellationToken)
                : (0, version));

        public Task<int> NewProjectAsync(string templateName, string projectName, string outputPath, string[] extraArgs, ProcessInvocationOptions? options, CancellationToken cancellationToken)
            => NewProjectAsyncCallback is not null
                ? Task.FromResult(NewProjectAsyncCallback(templateName, projectName, outputPath, extraArgs, options!, cancellationToken))
                : throw new NotImplementedException();

        public Task<int> RestoreAsync(FileInfo projectFile, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => RestoreAsyncCallback is not null
                ? Task.FromResult(RestoreAsyncCallback(projectFile, options, cancellationToken))
                : Task.FromResult(0);

        public Task<int> BuildAsync(FileInfo projectFile, bool noRestore, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<int> AddPackageAsync(FileInfo projectFile, string packageName, string version, string? packageSourceUrl, bool noRestore, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<int> AddProjectToSolutionAsync(FileInfo solutionFile, FileInfo projectFile, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<(int ExitCode, IReadOnlyList<FileInfo> Projects)> GetSolutionProjectsAsync(FileInfo solutionFile, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<int> AddProjectReferenceAsync(FileInfo projectFile, FileInfo referencedProjectFile, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<(int ExitCode, NuGetPackageCli[]? Packages)> SearchPackagesAsync(DirectoryInfo workingDirectory, string query, bool exactMatch, bool prerelease, int take, int skip, FileInfo? nugetConfigFile, bool useCache, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<(int ExitCode, bool IsAspireHost, string? AspireHostingVersion)> GetAppHostInformationAsync(FileInfo projectFile, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<(int ExitCode, JsonDocument? Output)> GetProjectItemsAndPropertiesAsync(FileInfo projectFile, string[] items, string[] properties, string[] targets, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<int> RunAsync(FileInfo projectFile, bool watch, bool noBuild, bool noRestore, string[] args, IDictionary<string, string>? env, TaskCompletionSource<IAppHostCliBackchannel>? backchannelCompletionSource, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<int> RunAppHostCommandAsync(FileInfo projectFile, string command, DirectoryInfo workingDirectory, string[] args, IDictionary<string, string>? env, TaskCompletionSource<IAppHostCliBackchannel>? backchannelCompletionSource, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<(int ExitCode, string[] ConfigPaths)> GetNuGetConfigPathsAsync(DirectoryInfo workingDirectory, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<int> InitUserSecretsAsync(FileInfo projectFile, ProcessInvocationOptions options, CancellationToken cancellationToken)
            => Task.FromResult(0);
    }

    private sealed class TestCertificateService : ICertificateService
    {
        public Task<EnsureCertificatesTrustedResult> EnsureCertificatesTrustedAsync(CancellationToken cancellationToken)
            => Task.FromResult(new EnsureCertificatesTrustedResult
            {
                EnvironmentVariables = new Dictionary<string, string>(),
                Success = true
            });

        public string? ExportDevCertificatePem(CancellationToken cancellationToken) => null;
    }

    private sealed class TestNewCommandPrompter : INewCommandPrompter, ITemplateVersionPrompter
    {
        public Task<string> PromptForProjectNameAsync(string defaultName, ParseResult parseResult, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<string> PromptForOutputPath(string defaultPath, ParseResult parseResult, Func<string, ValidationResult>? validator = null, Func<string, string>? outputPathResolver = null, CancellationToken cancellationToken = default)
            => throw new NotImplementedException();

        public Task<(Aspire.Shared.NuGetPackageCli Package, PackageChannel Channel)> PromptForTemplatesVersionAsync(IEnumerable<(Aspire.Shared.NuGetPackageCli Package, PackageChannel Channel)> packages, CancellationToken cancellationToken)
            => throw new NotImplementedException();

        public Task<ITemplate> PromptForTemplateAsync(ITemplate[] templates, CancellationToken cancellationToken)
            => throw new NotImplementedException();
    }

    private sealed class FakeCliHostEnvironment(bool nonInteractive) : ICliHostEnvironment
    {
        public bool SupportsInteractiveInput => !nonInteractive;
        public bool SupportsInteractiveOutput => !nonInteractive;
        public bool SupportsAnsi => false;
    }
}
