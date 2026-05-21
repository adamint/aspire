// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.CommandLine;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Aspire.Cli.Backchannel;
using Aspire.Cli.Configuration;
using Aspire.Cli.Interaction;
using Aspire.Cli.Resources;
using Aspire.Cli.Telemetry;
using Aspire.Cli.Utils;
using Aspire.Shared.Model.Serialization;
using Microsoft.Extensions.Logging;
using Spectre.Console;

namespace Aspire.Cli.Commands;

/// <summary>
/// Represents information about a running AppHost for JSON serialization.
/// Aligned with AppHostListInfo from ListAppHostsTool.
/// </summary>
internal sealed class AppHostDisplayInfo
{
    public required string AppHostPath { get; init; }
    public required int AppHostPid { get; init; }
    public string? SdkVersion { get; init; }
    public int? CliPid { get; init; }
    public string? DashboardUrl { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LogFilePath { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<ResourceJson>? Resources { get; set; }
}

[JsonSerializable(typeof(List<AppHostDisplayInfo>))]
[JsonSerializable(typeof(ResourceJson))]
[JsonSerializable(typeof(ResourceUrlJson))]
[JsonSerializable(typeof(ResourceVolumeJson))]
[JsonSerializable(typeof(ResourceRelationshipJson))]
[JsonSerializable(typeof(ResourceHealthReportJson))]
[JsonSerializable(typeof(ResourceCommandJson))]
[JsonSerializable(typeof(ResourceCommandArgumentJson[]))]
[JsonSerializable(typeof(JsonNode))]
[JsonSerializable(typeof(Dictionary<string, JsonNode?>))]
[JsonSerializable(typeof(Dictionary<string, string?>))]
[JsonSerializable(typeof(Dictionary<string, ResourceHealthReportJson>))]
[JsonSerializable(typeof(Dictionary<string, ResourceCommandJson>))]
[JsonSourceGenerationOptions(WriteIndented = true, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class PsCommandJsonContext : JsonSerializerContext
{
    private static PsCommandJsonContext? s_relaxedEscaping;
    private static PsCommandJsonContext? s_compactRelaxedEscaping;

    /// <summary>
    /// Gets a context with relaxed JSON escaping for non-ASCII character support.
    /// </summary>
    public static PsCommandJsonContext RelaxedEscaping => s_relaxedEscaping ??= new(new JsonSerializerOptions
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    });

    /// <summary>
    /// Gets a compact context with relaxed JSON escaping for newline-delimited streaming output.
    /// </summary>
    public static PsCommandJsonContext CompactRelaxedEscaping => s_compactRelaxedEscaping ??= new(new JsonSerializerOptions
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    });
}

internal sealed partial class PsCommand : BaseCommand
{
    internal override HelpGroup HelpGroup => HelpGroup.AppCommands;

    private readonly IInteractionService _interactionService;
    private readonly IAuxiliaryBackchannelMonitor _backchannelMonitor;
    private readonly IStandardOutputStatus _standardOutputStatus;
    private readonly ILogger<PsCommand> _logger;
    private static readonly Option<OutputFormat> s_formatOption = new("--format")
    {
        Description = PsCommandStrings.JsonOptionDescription
    };

    private static readonly Option<bool> s_resourcesOption = new("--resources")
    {
        Description = PsCommandStrings.ResourcesOptionDescription
    };

    private static readonly Option<bool> s_includeHiddenOption = new("--include-hidden")
    {
        Description = SharedCommandStrings.IncludeHiddenOptionDescription
    };

    private static readonly Option<bool> s_followOption = new("--follow", "-f")
    {
        Description = PsCommandStrings.FollowOptionDescription
    };

    public PsCommand(
        IInteractionService interactionService,
        IAuxiliaryBackchannelMonitor backchannelMonitor,
        IStandardOutputStatus standardOutputStatus,
        IFeatures features,
        ICliUpdateNotifier updateNotifier,
        CliExecutionContext executionContext,
        AspireCliTelemetry telemetry,
        ILogger<PsCommand> logger)
        : base("ps", PsCommandStrings.Description, features, updateNotifier, executionContext, interactionService, telemetry)
    {
        _interactionService = interactionService;
        _backchannelMonitor = backchannelMonitor;
        _standardOutputStatus = standardOutputStatus;
        _logger = logger;

        Options.Add(s_formatOption);
        Options.Add(s_resourcesOption);
        Options.Add(s_includeHiddenOption);
        Options.Add(s_followOption);
    }

    protected override async Task<CommandResult> ExecuteAsync(ParseResult parseResult, CancellationToken cancellationToken)
    {
        using var activity = Telemetry.StartDiagnosticActivity(Name);

        var format = parseResult.GetValue(s_formatOption);
        var includeResources = parseResult.GetValue(s_resourcesOption);
        var includeHidden = parseResult.GetValue(s_includeHiddenOption);

        if (parseResult.GetValue(s_followOption))
        {
            return await ExecuteFollowAsync(format, includeResources, includeHidden, cancellationToken).ConfigureAwait(false);
        }

        // Scan for running AppHosts (same as ListAppHostsTool). JSON output must not go
        // through status rendering because non-interactive status text shares stdout.
        var connections = format == OutputFormat.Json
            ? await ScanForConnectionsAsync(cancellationToken).ConfigureAwait(false)
            : await _interactionService.ShowStatusAsync(
                SharedCommandStrings.ScanningForRunningAppHosts,
                async () => await ScanForConnectionsAsync(cancellationToken).ConfigureAwait(false));

        if (connections.Count == 0)
        {
            if (format == OutputFormat.Json)
            {
                // Structured output always goes to stdout.
                _interactionService.DisplayRawText("[]", ConsoleOutput.Standard);
            }
            else
            {
                _interactionService.DisplayMessage(KnownEmojis.Information, SharedCommandStrings.AppHostNotRunning);
            }
            return CommandResult.Success();
        }

        // Order: in-scope first, then out-of-scope
        var orderedConnections = connections
            .OrderByDescending(c => c.IsInScope)
            .ToList();

        // Gather info for each AppHost
        var appHostInfos = await GatherAppHostInfosAsync(orderedConnections, includeResources && format == OutputFormat.Json, includeHidden, cancellationToken).ConfigureAwait(false);

        if (format == OutputFormat.Json)
        {
            var json = JsonSerializer.Serialize(appHostInfos, PsCommandJsonContext.RelaxedEscaping.ListAppHostDisplayInfo);
            // Structured output always goes to stdout.
            _interactionService.DisplayRawText(json, ConsoleOutput.Standard);
        }
        else
        {
            DisplayTable(appHostInfos);
        }

        return CommandResult.Success();
    }

    private async Task<List<IAppHostAuxiliaryBackchannel>> ScanForConnectionsAsync(CancellationToken cancellationToken)
    {
        await _backchannelMonitor.ScanAsync(cancellationToken).ConfigureAwait(false);

        return _backchannelMonitor.Connections.ToList();
    }

    private async Task<CommandResult> ExecuteFollowAsync(OutputFormat format, bool includeResources, bool includeHidden, CancellationToken cancellationToken)
    {
        if (format != OutputFormat.Json)
        {
            return CommandResult.Failure(CliExitCodes.InvalidCommand, PsCommandStrings.FollowRequiresJson);
        }

        using var followCancellationTokenSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var followCancellationToken = followCancellationTokenSource.Token;
        var outputClosedWatcherTask = WatchForClosedOutputAsync(followCancellationTokenSource, _standardOutputStatus, followCancellationToken);
        var updates = Channel.CreateUnbounded<IReadOnlyList<IAppHostAuxiliaryBackchannel>?>(new UnboundedChannelOptions
        {
            SingleReader = true
        });
        var currentConnections = new List<IAppHostAuxiliaryBackchannel>();
        CancellationTokenSource? resourceWatchCts = null;
        List<Task> resourceWatchTasks = [];
        var lastJson = string.Empty;
        var resourceUpdateQueued = 0;

        _ = Task.Run(async () =>
        {
            try
            {
                await foreach (var connections in _backchannelMonitor.WatchConnectionsAsync(followCancellationToken).WithCancellation(followCancellationToken).ConfigureAwait(false))
                {
                    await updates.Writer.WriteAsync(connections, followCancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (followCancellationToken.IsCancellationRequested)
            {
                // Expected when the caller stops following.
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Failed while watching AppHost connections for ps --follow.");
            }
            finally
            {
                updates.Writer.TryComplete();
            }
        }, CancellationToken.None);

        try
        {
            await foreach (var connections in updates.Reader.ReadAllAsync(followCancellationToken).ConfigureAwait(false))
            {
                if (connections is not null)
                {
                    currentConnections = OrderConnections(connections);
                    await RestartResourceWatchersAsync().ConfigureAwait(false);
                }
                else
                {
                    Interlocked.Exchange(ref resourceUpdateQueued, 0);
                }

                await WriteSnapshotAsync().ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (followCancellationToken.IsCancellationRequested)
        {
            return CommandResult.Success();
        }
        catch (IOException ex)
        {
            _logger.LogDebug(ex, "Stopping ps --follow because the output stream is no longer writable.");
            return CommandResult.Success();
        }
        finally
        {
            await followCancellationTokenSource.CancelAsync().ConfigureAwait(false);
            await outputClosedWatcherTask.ConfigureAwait(false);
            if (resourceWatchCts is not null)
            {
                await resourceWatchCts.CancelAsync().ConfigureAwait(false);
                await Task.WhenAll(resourceWatchTasks).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                resourceWatchCts.Dispose();
            }
        }

        return CommandResult.Success();

        async Task RestartResourceWatchersAsync()
        {
            if (resourceWatchCts is not null)
            {
                await resourceWatchCts.CancelAsync().ConfigureAwait(false);
                await Task.WhenAll(resourceWatchTasks).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                resourceWatchCts.Dispose();
                resourceWatchCts = null;
                resourceWatchTasks = [];
            }

            if (!includeResources || format != OutputFormat.Json)
            {
                return;
            }

            resourceWatchCts = CancellationTokenSource.CreateLinkedTokenSource(followCancellationToken);
            var resourceCancellationToken = resourceWatchCts.Token;
            foreach (var connection in currentConnections)
            {
                resourceWatchTasks.Add(Task.Run(async () =>
                {
                    try
                    {
                        await foreach (var _ in connection.WatchResourceSnapshotsAsync(includeHidden, resourceCancellationToken).WithCancellation(resourceCancellationToken).ConfigureAwait(false))
                        {
                            if (Interlocked.Exchange(ref resourceUpdateQueued, 1) == 0)
                            {
                                await updates.Writer.WriteAsync(null, resourceCancellationToken).ConfigureAwait(false);
                            }
                        }
                    }
                    catch (OperationCanceledException) when (resourceCancellationToken.IsCancellationRequested)
                    {
                        // Expected when the connection list changes or the command stops.
                    }
                    catch (Exception ex)
                    {
                        _logger.LogDebug(ex, "Failed while watching resource snapshots for {AppHostPath}.", connection.AppHostInfo?.AppHostPath);
                    }
                }, CancellationToken.None));
            }
        }

        async Task WriteSnapshotAsync()
        {
            var appHostInfos = await GatherAppHostInfosAsync(currentConnections, includeResources, includeHidden, followCancellationToken).ConfigureAwait(false);
            var json = JsonSerializer.Serialize(appHostInfos, PsCommandJsonContext.CompactRelaxedEscaping.ListAppHostDisplayInfo);
            if (!string.Equals(json, lastJson, StringComparison.Ordinal))
            {
                lastJson = json;
                _interactionService.DisplayRawText(json, ConsoleOutput.Standard);
            }
        }
    }

    private static Task WatchForClosedOutputAsync(CancellationTokenSource cancellationTokenSource, IStandardOutputStatus standardOutputStatus, CancellationToken cancellationToken)
    {
        if (!standardOutputStatus.IsOutputRedirected)
        {
            return Task.CompletedTask;
        }

        return Task.Run(async () =>
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    // A follow command may write a valid first snapshot into a pipe and then have
                    // no more changes to write. Poll stdout so consumers such as `head -n 1` do
                    // not leave the process alive indefinitely after closing their read end.
                    if (standardOutputStatus.IsOutputClosed())
                    {
                        await cancellationTokenSource.CancelAsync().ConfigureAwait(false);
                        return;
                    }

                    await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Expected when the command exits normally.
            }
        }, CancellationToken.None);
    }
}

internal interface IStandardOutputStatus
{
    bool IsOutputRedirected { get; }

    bool IsOutputClosed();
}

internal sealed partial class StandardOutputStatus : IStandardOutputStatus
{
    public bool IsOutputRedirected => System.Console.IsOutputRedirected;

    public bool IsOutputClosed()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && IsUnixStandardOutputClosed())
        {
            return true;
        }

        try
        {
            System.Console.Out.Flush();
            return false;
        }
        catch (IOException)
        {
            return true;
        }
        catch (ObjectDisposedException)
        {
            return true;
        }
    }

    private static bool IsUnixStandardOutputClosed()
    {
        var fileDescriptors = new[]
        {
            new PollFileDescriptor
            {
                FileDescriptor = 1,
                Events = PollOut
            }
        };

        try
        {
            var result = RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
                ? PollLibSystem(fileDescriptors, 1, 0)
                : PollLibc(fileDescriptors, 1, 0);
            return result > 0 && (fileDescriptors[0].ReturnedEvents & (PollError | PollHangUp | PollInvalid)) != 0;
        }
        catch (DllNotFoundException)
        {
            return false;
        }
        catch (EntryPointNotFoundException)
        {
            return false;
        }
    }

    private const short PollOut = 0x0004;
    private const short PollError = 0x0008;
    private const short PollHangUp = 0x0010;
    private const short PollInvalid = 0x0020;

    [StructLayout(LayoutKind.Sequential)]
    private struct PollFileDescriptor
    {
        public int FileDescriptor;
        public short Events;
        public short ReturnedEvents;
    }

    [LibraryImport("libc", EntryPoint = "poll", SetLastError = true)]
    private static partial int PollLibc([In, Out] PollFileDescriptor[] fileDescriptors, nuint count, int timeoutMilliseconds);

    [LibraryImport("libSystem", EntryPoint = "poll", SetLastError = true)]
    private static partial int PollLibSystem([In, Out] PollFileDescriptor[] fileDescriptors, nuint count, int timeoutMilliseconds);
}

internal sealed partial class PsCommand
{
    private static List<IAppHostAuxiliaryBackchannel> OrderConnections(IEnumerable<IAppHostAuxiliaryBackchannel> connections)
    {
        return connections
            .OrderByDescending(c => c.IsInScope)
            .ToList();
    }

    private async Task<List<AppHostDisplayInfo>> GatherAppHostInfosAsync(List<IAppHostAuxiliaryBackchannel> connections, bool includeResources, bool includeHidden, CancellationToken cancellationToken)
    {
        var appHostInfos = new List<AppHostDisplayInfo>();

        foreach (var connection in connections)
        {
            var info = connection.AppHostInfo;
            if (info is null)
            {
                continue;
            }

            string? sdkVersion = null;
            var appHostPath = info.AppHostPath;
            var appHostPid = info.ProcessId;
            var cliPid = info.CliProcessId;
            var cliLogFilePath = info.CliLogFilePath;

            try
            {
                if (connection.SupportsV2)
                {
                    var v2Info = await connection.GetAppHostInfoV2Async(cancellationToken).ConfigureAwait(false);
                    if (v2Info is not null)
                    {
                        sdkVersion = GetSdkVersion(v2Info.AspireHostVersion);
                        appHostPath = string.IsNullOrWhiteSpace(v2Info.AppHostPath) ? appHostPath : v2Info.AppHostPath;
                        cliPid = v2Info.CliProcessId ?? cliPid;
                        cliLogFilePath = v2Info.CliLogFilePath ?? cliLogFilePath;

                        if (int.TryParse(v2Info.Pid, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedPid))
                        {
                            appHostPid = parsedPid;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Failed to get AppHost SDK version for {AppHostPath}", info.AppHostPath);
            }

            string? dashboardUrl = null;

            try
            {
                var dashboardUrls = await connection.GetDashboardUrlsAsync(cancellationToken).ConfigureAwait(false);
                dashboardUrl = dashboardUrls?.BaseUrlWithLoginToken;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Failed to get dashboard URL for {AppHostPath}", info.AppHostPath);
            }

            List<ResourceJson>? resources = null;
            if (includeResources)
            {
                try
                {
                    var snapshots = await connection.GetResourceSnapshotsAsync(includeHidden, cancellationToken).ConfigureAwait(false);
                    resources = ResourceSnapshotMapper.MapToResourceJsonList(snapshots, dashboardUrl, includeEnvironmentVariableValues: false);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Failed to get resource snapshots for {AppHostPath}", info.AppHostPath);
                }
            }

            appHostInfos.Add(new AppHostDisplayInfo
            {
                AppHostPath = appHostPath ?? PsCommandStrings.UnknownPath,
                AppHostPid = appHostPid,
                SdkVersion = sdkVersion,
                CliPid = cliPid,
                DashboardUrl = dashboardUrl,
                LogFilePath = cliLogFilePath,
                Resources = resources
            });
        }

        return appHostInfos;
    }

    private static string? GetSdkVersion(string? sdkVersion)
    {
        if (string.IsNullOrWhiteSpace(sdkVersion) ||
            string.Equals(sdkVersion, "unknown", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return sdkVersion;
    }

    private void DisplayTable(List<AppHostDisplayInfo> appHosts)
    {
        if (appHosts.Count == 0)
        {
            return;
        }

        var shortPaths = FileSystemHelper.ShortenPaths(appHosts.Select(a => a.AppHostPath).ToList());

        // Only show the CLI Log column when at least one app host has a log file path.
        var includeCliLog = appHosts.Any(a => !string.IsNullOrEmpty(a.LogFilePath));

        var table = new Table();
        table.AddBoldColumn(PsCommandStrings.HeaderPath);
        table.AddBoldColumn(PsCommandStrings.HeaderSdk);
        table.AddBoldColumn(PsCommandStrings.HeaderPid);
        table.AddBoldColumn(PsCommandStrings.HeaderCliPid);

        if (includeCliLog)
        {
            table.AddBoldColumn(PsCommandStrings.HeaderCliLog);
        }

        table.AddBoldColumn(PsCommandStrings.HeaderDashboard);

        foreach (var appHost in appHosts)
        {
            var shortPath = shortPaths[appHost.AppHostPath];
            var cliPid = appHost.CliPid?.ToString(CultureInfo.InvariantCulture) ?? "-";
            var dashboard = "-";
            if (!string.IsNullOrEmpty(appHost.DashboardUrl))
            {
                if (Uri.TryCreate(appHost.DashboardUrl, UriKind.Absolute, out _))
                {
                    dashboard = MarkupHelpers.SafeLink(_interactionService, appHost.DashboardUrl);
                }
                else
                {
                    dashboard = Markup.Escape(appHost.DashboardUrl);
                }
            }

            var columns = new List<string>
            {
                Markup.Escape(shortPath),
                Markup.Escape(appHost.SdkVersion ?? "-"),
                appHost.AppHostPid.ToString(CultureInfo.InvariantCulture),
                cliPid,
            };

            if (includeCliLog)
            {
                var logDisplay = "-";
                if (!string.IsNullOrEmpty(appHost.LogFilePath))
                {
                    logDisplay = MarkupHelpers.SafeFileLink(_interactionService, appHost.LogFilePath, Path.GetFileName(appHost.LogFilePath));
                }

                columns.Add(logDisplay);
            }

            columns.Add(dashboard);

            table.AddRow(columns.ToArray());
        }

        _interactionService.DisplayRenderable(table);
    }

}
