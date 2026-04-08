// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Aspire.Cli.Tests;

public class ProgramTests
{
    [Fact]
    public void ParseLogFileOption_ReturnsNull_WhenArgsAreNull()
    {
        var result = Program.ParseLogFileOption(null);

        Assert.Null(result);
    }

    [Fact]
    public void ParseLogFileOption_ReturnsValue_WhenOptionAppearsBeforeDelimiter()
    {
        var result = Program.ParseLogFileOption(["run", "--log-file", "cli.log", "--", "--log-file", "app.log"]);

        Assert.Equal("cli.log", result);
    }

    [Fact]
    public void ParseLogFileOption_IgnoresValue_WhenOptionAppearsAfterDelimiter()
    {
        var result = Program.ParseLogFileOption(["run", "--", "--log-file", "app.log"]);

        Assert.Null(result);
    }

    [Fact]
    public void ParseLoggingOptions_NoLogFile_SetsFlag()
    {
        var options = Program.ParseLoggingOptions(["describe", "--no-log-file"]);

        Assert.True(options.NoLogFile);
        Assert.Null(options.LogFilePath);
    }

    [Fact]
    public void ParseLoggingOptions_WithoutNoLogFile_GeneratesLogFilePath()
    {
        var options = Program.ParseLoggingOptions(["describe"]);

        Assert.False(options.NoLogFile);
        Assert.NotNull(options.LogFilePath);
        Assert.EndsWith(".log", options.LogFilePath);
    }

    [Fact]
    public void ParseLoggingOptions_NoLogFileWithDebug_SetsBothFlags()
    {
        var options = Program.ParseLoggingOptions(["describe", "--debug", "--no-log-file"]);

        Assert.True(options.NoLogFile);
        Assert.True(options.DebugMode);
        Assert.Null(options.LogFilePath);
    }

    [Fact]
    public void ParseLoggingOptions_IgnoresNoLogFileAfterDelimiter()
    {
        var options = Program.ParseLoggingOptions(["run", "--", "--no-log-file"]);

        Assert.False(options.NoLogFile);
        Assert.NotNull(options.LogFilePath);
    }

    [Fact]
    public void FileLoggerProvider_CreateNull_DoesNotCreateFile()
    {
        using var provider = FileLoggerProvider.CreateNull();

        Assert.Null(provider.LogFilePath);

        // Writing should be a no-op (no exception)
        var logger = provider.CreateLogger("Test");
        logger.LogInformation("This should not throw");
    }

    [Fact]
    public void FileLoggerProvider_CreateNull_LoggerIsEnabled()
    {
        using var provider = FileLoggerProvider.CreateNull();
        var logger = provider.CreateLogger("Aspire.Cli.Test");

        // Logger reports enabled (filter is separate from file existence)
        Assert.True(logger.IsEnabled(Microsoft.Extensions.Logging.LogLevel.Information));
    }

    [Fact]
    public void StartupErrorWriter_Dispose_DoesNotThrowWhenLogFileIsDisabled()
    {
        using var writer = new StartupErrorWriter(logFilePath: null);
        writer.WriteLine("example startup error");
    }
}
