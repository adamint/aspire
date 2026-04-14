// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using Aspire.Dashboard.Components.Dialogs;
using Aspire.Dashboard.Components.Tests.Shared;
using Aspire.Dashboard.Configuration;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Otlp.Model;
using Aspire.Dashboard.Otlp.Storage;
using Aspire.Dashboard.Tests.Shared;
using Aspire.Dashboard.Utils;
using Bunit;
using Google.Protobuf.Collections;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OpenTelemetry.Proto.Logs.V1;
using Xunit;
using static Aspire.Tests.Shared.Telemetry.TelemetryTestHelpers;

namespace Aspire.Dashboard.Components.Tests.Dialogs;

[UseCulture("en-US")]
public sealed class ManageDataDialogTests : DashboardTestContext
{
    [Fact]
    public void RendersLatestTimestampForTelemetryOnlyResources()
    {
        var timeProvider = SetupManageDataServices();
        var repository = Services.GetRequiredService<TelemetryRepository>();
        var timestamp = new DateTime(2026, 4, 8, 10, 0, 0, DateTimeKind.Utc);

        AddLog(repository, "beta", timestamp);

        var cut = RenderComponent<ManageDataDialog>();

        cut.WaitForAssertion(() =>
        {
            Assert.Contains("Timestamp", cut.Markup, StringComparison.Ordinal);
            Assert.Contains(FormatHelpers.FormatDateTime(timeProvider, timestamp, MillisecondsDisplay.None, CultureInfo.CurrentCulture), cut.Markup, StringComparison.Ordinal);
            Assert.Equal(["beta"], GetResourceNames(cut));
        });
    }

    [Fact]
    public void TimestampSort_UsesSnapshotUntilUserChangesSort()
    {
        var timeProvider = SetupManageDataServices();
        var repository = Services.GetRequiredService<TelemetryRepository>();
        var alphaInitial = new DateTime(2026, 4, 8, 9, 0, 0, DateTimeKind.Utc);
        var betaInitial = new DateTime(2026, 4, 8, 10, 0, 0, DateTimeKind.Utc);
        var alphaUpdated = new DateTime(2026, 4, 8, 12, 0, 0, DateTimeKind.Utc);

        AddLog(repository, "alpha", alphaInitial);
        AddLog(repository, "beta", betaInitial);

        var cut = RenderComponent<ManageDataDialog>();

        cut.WaitForAssertion(() => Assert.Equal(["alpha", "beta"], GetResourceNames(cut)));

        cut.FindAll(".manage-data-sort-button")[1].Click();

        cut.WaitForAssertion(() => Assert.Equal(["beta", "alpha"], GetResourceNames(cut)));

        AddLog(repository, "alpha", alphaUpdated);

        cut.WaitForAssertion(() =>
        {
            Assert.Equal(["beta", "alpha"], GetResourceNames(cut));
            Assert.Contains(FormatHelpers.FormatDateTime(timeProvider, alphaUpdated, MillisecondsDisplay.None, CultureInfo.CurrentCulture), cut.Markup, StringComparison.Ordinal);
        });

        cut.FindAll(".manage-data-sort-button")[0].Click();

        cut.WaitForAssertion(() => Assert.Equal(["alpha", "beta"], GetResourceNames(cut)));

        cut.FindAll(".manage-data-sort-button")[1].Click();

        cut.WaitForAssertion(() => Assert.Equal(["alpha", "beta"], GetResourceNames(cut)));
    }

    private TestTimeProvider SetupManageDataServices()
    {
        var timeProvider = new TestTimeProvider();

        FluentUISetupHelpers.SetupFluentDataGrid(this);
        FluentUISetupHelpers.AddCommonDashboardServices(this, browserTimeProvider: timeProvider);

        Services.AddSingleton<IDashboardClient>(new TestDashboardClient(isEnabled: false));
        Services.AddSingleton<ConsoleLogsManager>();
        Services.AddSingleton<ConsoleLogsFetcher>();
        Services.AddSingleton<TelemetryExportService>();
        Services.AddSingleton<TelemetryImportService>();
        Services.AddSingleton<IOptionsMonitor<DashboardOptions>>(new TestOptionsMonitor<DashboardOptions>(new DashboardOptions
        {
            UI = new UIOptions
            {
                DisableImport = true
            }
        }));
        Services.AddSingleton<ILogger<TelemetryImportService>>(NullLogger<TelemetryImportService>.Instance);

        return timeProvider;
    }

    private static void AddLog(TelemetryRepository repository, string resourceName, DateTime timestamp)
    {
        repository.AddLogs(new AddContext(), new RepeatedField<ResourceLogs>
        {
            new ResourceLogs
            {
                Resource = CreateResource(name: resourceName),
                ScopeLogs =
                {
                    new ScopeLogs
                    {
                        Scope = CreateScope("TestLogger"),
                        LogRecords =
                        {
                            CreateLogRecord(time: timestamp, message: resourceName, severity: SeverityNumber.Info)
                        }
                    }
                }
            }
        });
    }

    private static List<string> GetResourceNames(IRenderedComponent<ManageDataDialog> cut)
    {
        return cut.FindAll(".resource-name-text")
            .Select(element => element.TextContent.Trim())
            .ToList();
    }

    private sealed class TestOptionsMonitor<T>(T currentValue) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; } = currentValue;

        public T Get(string? name)
        {
            return CurrentValue;
        }

        public IDisposable? OnChange(Action<T, string?> listener)
        {
            return null;
        }
    }
}
