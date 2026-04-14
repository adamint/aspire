// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Commands;
using Aspire.Cli.Projects;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Aspire.Cli.Tests.Commands;

public class StartCommandTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task StartCommand_Help_Works()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start --help");

        var exitCode = await result.InvokeAsync().DefaultTimeout();

        Assert.Equal(ExitCodeConstants.Success, exitCode);
    }

    [Fact]
    public async Task StartCommand_AcceptsNoBuildOption()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start --no-build --help");

        var exitCode = await result.InvokeAsync().DefaultTimeout();
        Assert.Equal(ExitCodeConstants.Success, exitCode);
    }

    [Fact]
    public async Task StartCommand_AcceptsFormatOption()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start --format json --help");

        var exitCode = await result.InvokeAsync().DefaultTimeout();
        Assert.Equal(ExitCodeConstants.Success, exitCode);
    }

    [Fact]
    public async Task StartCommand_AcceptsIsolatedOption()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start --isolated --help");

        var exitCode = await result.InvokeAsync().DefaultTimeout();
        Assert.Equal(ExitCodeConstants.Success, exitCode);
    }

    [Fact]
    public void StartCommand_ForwardsUnmatchedTokensToAppHost()
    {
        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper);
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start -- --custom-arg value");

        Assert.Empty(result.Errors);
        Assert.Contains("--custom-arg", result.UnmatchedTokens);
        Assert.Contains("value", result.UnmatchedTokens);
    }

    [Fact]
    public async Task StartCommand_WhenMultipleProjectFilesFound_NonInteractive_PassesThrowBehavior()
    {
        MultipleAppHostProjectsFoundBehavior? capturedBehavior = null;

        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, options =>
        {
            options.ProjectLocatorFactory = _ => new TestProjectLocator
            {
                UseOrFindAppHostProjectFileWithBehaviorAsyncCallback = (_, behavior, _, _) =>
                {
                    capturedBehavior = behavior;
                    throw new ProjectLocatorException("Multiple project files found.", ProjectLocatorFailureReason.MultipleProjectFilesFound);
                }
            };
            options.CliHostEnvironmentFactory = sp =>
            {
                var configuration = sp.GetRequiredService<IConfiguration>();
                return new CliHostEnvironment(configuration, nonInteractive: true);
            };
        });
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start");

        var exitCode = await result.InvokeAsync().DefaultTimeout();

        Assert.Equal(MultipleAppHostProjectsFoundBehavior.Throw, capturedBehavior);
    }

    [Fact]
    public async Task StartCommand_WhenMultipleProjectFilesFound_Interactive_PassesPromptBehavior()
    {
        MultipleAppHostProjectsFoundBehavior? capturedBehavior = null;

        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, options =>
        {
            options.ProjectLocatorFactory = _ => new TestProjectLocator
            {
                UseOrFindAppHostProjectFileWithBehaviorAsyncCallback = (_, behavior, _, _) =>
                {
                    capturedBehavior = behavior;
                    throw new ProjectLocatorException("Multiple project files found.", ProjectLocatorFailureReason.MultipleProjectFilesFound);
                }
            };
            options.CliHostEnvironmentFactory = sp =>
            {
                var configuration = sp.GetRequiredService<IConfiguration>();
                return new CliHostEnvironment(configuration, nonInteractive: false);
            };
        });
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start");

        var exitCode = await result.InvokeAsync().DefaultTimeout();

        Assert.Equal(MultipleAppHostProjectsFoundBehavior.Prompt, capturedBehavior);
    }

    [Fact]
    public async Task StartCommand_WhenMultipleProjectFilesFound_JsonFormat_PassesThrowBehavior()
    {
        MultipleAppHostProjectsFoundBehavior? capturedBehavior = null;

        using var workspace = TemporaryWorkspace.Create(outputHelper);
        var services = CliTestHelper.CreateServiceCollection(workspace, outputHelper, options =>
        {
            options.ProjectLocatorFactory = _ => new TestProjectLocator
            {
                UseOrFindAppHostProjectFileWithBehaviorAsyncCallback = (_, behavior, _, _) =>
                {
                    capturedBehavior = behavior;
                    throw new ProjectLocatorException("Multiple project files found.", ProjectLocatorFailureReason.MultipleProjectFilesFound);
                }
            };
            options.CliHostEnvironmentFactory = sp =>
            {
                var configuration = sp.GetRequiredService<IConfiguration>();
                return new CliHostEnvironment(configuration, nonInteractive: false);
            };
        });
        var provider = services.BuildServiceProvider();

        var command = provider.GetRequiredService<RootCommand>();
        var result = command.Parse("start --format json");

        var exitCode = await result.InvokeAsync().DefaultTimeout();

        Assert.Equal(MultipleAppHostProjectsFoundBehavior.Throw, capturedBehavior);
    }
}
