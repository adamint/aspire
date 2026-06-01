// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Threading.Channels;
using Aspire.Dashboard.Components.Dialogs;
using Aspire.Dashboard.Components.Tests.Shared;
using Aspire.Dashboard.Configuration;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Tests.Shared;
using Aspire.Tests.Shared.DashboardModel;
using AngleSharp.Dom;
using Bunit;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Aspire.Dashboard.Components.Tests.Dialogs;

[UseCulture("en-US")]
public sealed class ManageDataDialogTests : DashboardTestContext
{
    [Fact]
    public void Render_SelectionButtons_HaveAccessibleNames()
    {
        var basketResource = ModelTestHelpers.CreateResource(
            resourceName: "basket",
            displayName: "Basket service",
            state: KnownResourceState.Running);
        var catalogResource = ModelTestHelpers.CreateResource(
            resourceName: "catalog",
            displayName: "Catalog service",
            state: KnownResourceState.Running);
        var resourcesChannel = Channel.CreateUnbounded<IReadOnlyList<ResourceViewModelChange>>();
        var dashboardClient = new TestDashboardClient(
            isEnabled: true,
            initialResources: [basketResource, catalogResource],
            resourceChannelProvider: () => resourcesChannel);

        SetupManageDataDialogServices(dashboardClient);

        var cut = RenderComponent<ManageDataDialog>();

        cut.WaitForAssertion(() =>
        {
            AssertSelectionButtonHasAccessibleName(cut, "Deselect all");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        ExpandResourceRows(cut, expectedCount: 2);

        cut.WaitForAssertion(() =>
        {
            AssertSelectionButtonInRowHasAccessibleName(cut, "Basket service", "Deselect Basket service");
            AssertSelectionButtonInRowHasAccessibleName(cut, "Catalog service", "Deselect Catalog service");
            AssertNestedRowSelectionLabels(
                cut,
                "Resource",
                "Deselect Resource for Basket service",
                "Deselect Resource for Catalog service");
            AssertNestedRowSelectionLabels(
                cut,
                "Console logs",
                "Deselect Console logs for Basket service",
                "Deselect Console logs for Catalog service");
            AssertNoButtonHasAccessibleName(cut, "Deselect Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        cut.Find("fluent-button[aria-label='Deselect all']").Click();

        cut.WaitForAssertion(() =>
        {
            AssertSelectionButtonHasAccessibleName(cut, "Select all");
            AssertSelectionButtonInRowHasAccessibleName(cut, "Basket service", "Select Basket service");
            AssertSelectionButtonInRowHasAccessibleName(cut, "Catalog service", "Select Catalog service");
            AssertNestedRowSelectionLabels(
                cut,
                "Resource",
                "Select Resource for Basket service",
                "Select Resource for Catalog service");
            AssertNestedRowSelectionLabels(
                cut,
                "Console logs",
                "Select Console logs for Basket service",
                "Select Console logs for Catalog service");
            AssertNoButtonHasAccessibleName(cut, "Select Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });
    }

    private void SetupManageDataDialogServices(TestDashboardClient dashboardClient)
    {
        FluentUISetupHelpers.AddCommonDashboardServices(this);
        Services.AddLogging();
        Services.AddSingleton<ILoggerFactory>(NullLoggerFactory.Instance);
        Services.AddOptions<DashboardOptions>().Configure(options => options.UI.DisableImport = true);
        Services.AddSingleton<IDashboardClient>(dashboardClient);
        Services.AddSingleton<IconResolver>();
        Services.AddSingleton<ConsoleLogsManager>();
        Services.AddSingleton<ConsoleLogsFetcher>();
        Services.AddSingleton<TelemetryExportService>();
        Services.AddSingleton<TelemetryImportService>();

        FluentUISetupHelpers.SetupFluentUIComponents(this);
        FluentUISetupHelpers.SetupFluentButton(this);
        FluentUISetupHelpers.SetupFluentDataGrid(this);
    }

    private static void ExpandResourceRows(IRenderedComponent<ManageDataDialog> cut, int expectedCount)
    {
        for (var i = 0; i < expectedCount; i++)
        {
            var toggleButtons = cut.FindAll("fluent-button[aria-label='Toggle nesting']");

            Assert.Equal(expectedCount, toggleButtons.Count);

            toggleButtons[i].Click();
        }
    }

    private static void AssertSelectionButtonHasAccessibleName(IRenderedComponent<ManageDataDialog> cut, string accessibleName)
    {
        Assert.Contains(cut.FindAll("fluent-button"), button => ButtonHasAccessibleName(button, accessibleName));
    }

    private static void AssertSelectionButtonInRowHasAccessibleName(IRenderedComponent<ManageDataDialog> cut, string visibleText, string accessibleName)
    {
        var row = Assert.Single(cut.FindAll(".fluent-data-grid-row"), row => row.TextContent.Contains(visibleText, StringComparison.Ordinal));

        Assert.Contains(row.QuerySelectorAll("fluent-button"), button => ButtonHasAccessibleName(button, accessibleName));
    }

    private static void AssertNestedRowSelectionLabels(IRenderedComponent<ManageDataDialog> cut, string visibleText, params string[] expectedAccessibleNames)
    {
        var accessibleNames = cut.FindAll(".fluent-data-grid-row")
            .Where(row => row.TextContent.Contains(visibleText, StringComparison.Ordinal))
            .Select(GetOnlySelectionButtonAccessibleName)
            .ToArray();

        Assert.Equal(
            expectedAccessibleNames.OrderBy(name => name, StringComparer.Ordinal),
            accessibleNames.OrderBy(name => name, StringComparer.Ordinal));
        Assert.Equal(accessibleNames.Length, accessibleNames.Distinct(StringComparer.Ordinal).Count());
    }

    private static void AssertNoButtonHasAccessibleName(IRenderedComponent<ManageDataDialog> cut, string accessibleName) =>
        Assert.DoesNotContain(
            cut.FindAll("fluent-button"),
            button =>
                string.Equals(button.GetAttribute("title"), accessibleName, StringComparison.Ordinal) ||
                string.Equals(button.GetAttribute("aria-label"), accessibleName, StringComparison.Ordinal));

    private static bool ButtonHasAccessibleName(IElement button, string accessibleName) =>
        string.Equals(button.GetAttribute("title"), accessibleName, StringComparison.Ordinal) &&
        string.Equals(button.GetAttribute("aria-label"), accessibleName, StringComparison.Ordinal);

    private static string GetOnlySelectionButtonAccessibleName(IElement row)
    {
        var button = Assert.Single(row.QuerySelectorAll("fluent-button"));
        var title = button.GetAttribute("title");

        Assert.False(string.IsNullOrEmpty(title));
        Assert.Equal(title, button.GetAttribute("aria-label"));

        return title;
    }
}
