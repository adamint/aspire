// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using System.Text;
using Aspire.Cli.Backchannel;
using Aspire.Cli.Interaction;
using Aspire.Cli.Resources;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Tests.Utils;
using Aspire.Cli.Utils;
using Microsoft.AspNetCore.InternalTesting;
using Microsoft.Extensions.Logging.Abstractions;
using Spectre.Console;

namespace Aspire.Cli.Tests.Interaction;

public class ExtensionInteractionServiceTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task DisplayMessage_DoesNotRenderTerminalHyperlinksToDebugConsoleCapturedOutput()
    {
        var output = new StringBuilder();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.Yes,
            ColorSystem = ColorSystemSupport.TrueColor,
            Out = new AnsiConsoleOutput(new StringWriter(output)),
            Enrichment = new ProfileEnrichment { UseDefaultEnrichers = false }
        });
        console.Profile.Capabilities.Links = true;
        console.Profile.Width = int.MaxValue;

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var logFilePath = Path.Combine(workspace.WorkspaceRoot.FullName, "cli [extension].log");
        var executionContext = workspace.CreateExecutionContext(logFilePath: logFilePath);
        var consoleInteractionService = new ConsoleInteractionService(
            new ConsoleEnvironment(console, console),
            executionContext,
            TestHelpers.CreateInteractiveHostEnvironment(),
            new EnvironmentProcessPathProvider(),
            NullLoggerFactory.Instance,
            new ConsoleLogBufferContext());
        var extensionInteractionService = new ExtensionInteractionService(
            consoleInteractionService,
            new TestExtensionBackchannel(),
            extensionPromptEnabled: false,
            logger: NullLogger<ExtensionInteractionService>.Instance);

        var fileLinkMarkup = MarkupHelpers.SafeFileLink(extensionInteractionService, logFilePath);
        extensionInteractionService.DisplayMessage(
            KnownEmojis.PageFacingUp,
            string.Format(CultureInfo.CurrentCulture, InteractionServiceStrings.SeeLogsAt, fileLinkMarkup),
            allowMarkup: true,
            consoleOverride: ConsoleOutput.Error);
        await extensionInteractionService.FlushAsync();

        var outputString = output.ToString();
        Assert.Contains(logFilePath, outputString);
        Assert.DoesNotContain("\u001b]8;", outputString);
        Assert.DoesNotContain("file://", outputString);
    }

    [Fact]
    public async Task DisplayCancellationMessage_WithCustomMessage_UsesCancellationBackchannel()
    {
        var output = new StringBuilder();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.Yes,
            ColorSystem = ColorSystemSupport.TrueColor,
            Out = new AnsiConsoleOutput(new StringWriter(output)),
            Enrichment = new ProfileEnrichment { UseDefaultEnrichers = false }
        });

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var executionContext = workspace.CreateExecutionContext();
        var consoleInteractionService = new ConsoleInteractionService(
            new ConsoleEnvironment(console, console),
            executionContext,
            TestHelpers.CreateInteractiveHostEnvironment(),
            new EnvironmentProcessPathProvider(),
            NullLoggerFactory.Instance,
            new ConsoleLogBufferContext());
        var cancellationMessageCalled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var displayMessageCalled = false;
        var backchannel = new TestExtensionBackchannel
        {
            DisplayCancellationMessageAsyncCalled = cancellationMessageCalled,
            DisplayMessageAsyncCallback = (_, _) =>
            {
                displayMessageCalled = true;
                return Task.CompletedTask;
            }
        };
        using var extensionInteractionService = new ExtensionInteractionService(
            consoleInteractionService,
            backchannel,
            extensionPromptEnabled: false,
            logger: NullLogger<ExtensionInteractionService>.Instance);

        extensionInteractionService.DisplayCancellationMessage("Stopping dashboard.");
        await extensionInteractionService.FlushAsync();

        Assert.True(cancellationMessageCalled.Task.IsCompletedSuccessfully);
        Assert.False(displayMessageCalled);
    }

    [Fact]
    public async Task Dispose_StopsBackgroundPump()
    {
        var output = new StringBuilder();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.Yes,
            ColorSystem = ColorSystemSupport.TrueColor,
            Out = new AnsiConsoleOutput(new StringWriter(output)),
            Enrichment = new ProfileEnrichment { UseDefaultEnrichers = false }
        });

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var logFilePath = Path.Combine(workspace.WorkspaceRoot.FullName, "cli [extension].log");
        var executionContext = workspace.CreateExecutionContext(logFilePath: logFilePath);
        var consoleInteractionService = new ConsoleInteractionService(
            new ConsoleEnvironment(console, console),
            executionContext,
            TestHelpers.CreateInteractiveHostEnvironment(),
            new EnvironmentProcessPathProvider(),
            NullLoggerFactory.Instance,
            new ConsoleLogBufferContext());
        var extensionInteractionService = new ExtensionInteractionService(
            consoleInteractionService,
            new TestExtensionBackchannel(),
            extensionPromptEnabled: false,
            logger: NullLogger<ExtensionInteractionService>.Instance);

        extensionInteractionService.Dispose();

        // The background pump should exit promptly after disposal.
        await extensionInteractionService.PumpTask.DefaultTimeout();
    }

    [Fact]
    public async Task WriteAppHostLogEntryAsync_BlocksTheProducerWhenTheExtensionStopsDraining()
    {
        var output = new StringBuilder();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.Yes,
            ColorSystem = ColorSystemSupport.TrueColor,
            Out = new AnsiConsoleOutput(new StringWriter(output)),
            Enrichment = new ProfileEnrichment { UseDefaultEnrichers = false }
        });

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var consoleInteractionService = new ConsoleInteractionService(
            new ConsoleEnvironment(console, console),
            workspace.CreateExecutionContext(),
            TestHelpers.CreateInteractiveHostEnvironment(),
            new EnvironmentProcessPathProvider(),
            NullLoggerFactory.Instance,
            new ConsoleLogBufferContext());

        // Wedge the extension on the first entry so the pump cannot drain, then keep writing.
        // Without a bound the producer would never block and the CLI would buffer every record.
        var firstEntryReceived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseExtension = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var written = 0;
        var backchannel = new TestExtensionBackchannel
        {
            WriteAppHostLogEntryAsyncCallback = async _ =>
            {
                if (Interlocked.Increment(ref written) == 1)
                {
                    firstEntryReceived.TrySetResult();
                    await releaseExtension.Task;
                }
            }
        };
        using var extensionInteractionService = new ExtensionInteractionService(
            consoleInteractionService,
            backchannel,
            extensionPromptEnabled: false,
            logger: NullLogger<ExtensionInteractionService>.Instance);

        await extensionInteractionService.WriteAppHostLogEntryAsync(CreateEntry(1), CancellationToken.None).DefaultTimeout();
        await firstEntryReceived.Task.DefaultTimeout();

        var producer = Task.Run(async () =>
        {
            for (var sequenceNumber = 2L; sequenceNumber <= 4096; sequenceNumber++)
            {
                await extensionInteractionService.WriteAppHostLogEntryAsync(CreateEntry(sequenceNumber), CancellationToken.None);
            }
        });

        Assert.False(producer.IsCompleted);
        await Assert.ThrowsAsync<TimeoutException>(() => producer.WaitAsync(TimeSpan.FromMilliseconds(250)));

        releaseExtension.TrySetResult();
        await producer.DefaultTimeout();
        await extensionInteractionService.FlushAsync().DefaultTimeout();

        Assert.Equal(4096, Volatile.Read(ref written));

        static ExtensionAppHostLogEntry CreateEntry(long sequenceNumber) => new()
        {
            SequenceNumber = sequenceNumber,
            Timestamp = new DateTimeOffset(2026, 3, 16, 12, 0, 0, TimeSpan.Zero),
            LogLevel = "Information",
            Message = "Message",
            CategoryName = "Example.Category",
            EventId = 0,
        };
    }
}
