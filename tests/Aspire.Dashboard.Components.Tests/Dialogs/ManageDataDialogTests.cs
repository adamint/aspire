// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Threading.Channels;
using AngleSharp.Dom;
using Aspire.Dashboard.Components.Dialogs;
using Aspire.Dashboard.Components.Tests.Shared;
using Aspire.Dashboard.Configuration;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Model.ManageData;
using Aspire.Dashboard.Tests.Shared;
using Aspire.Tests.Shared.DashboardModel;
using Bunit;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.FluentUI.AspNetCore.Components;
using Xunit;

namespace Aspire.Dashboard.Components.Tests.Dialogs;

[UseCulture("en-US")]
public sealed class ManageDataDialogTests : DashboardTestContext
{
    [Fact]
    public void Render_SelectionControlsExposeAccessibleNamesCheckboxRoleAndState()
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
            AssertSelectionCheckboxCount(cut, 3);
            AssertSelectionCheckbox(cut, "Deselect all", "true");
            AssertSelectionCheckbox(cut, "Deselect Basket service", "true");
            AssertSelectionCheckbox(cut, "Deselect Catalog service", "true");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        ExpandResourceRows(cut, expectedCount: 2);

        cut.WaitForAssertion(() =>
        {
            AssertAllSelectionControlsSelected(cut);
            AssertNoButtonHasAccessibleName(cut, "Deselect Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        AssertSelectionCheckbox(cut, "Deselect Console logs for Basket service", "true").Click();

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 7);
            AssertSelectionCheckbox(cut, "Select all", "mixed");
            AssertSelectionCheckbox(cut, "Select Basket service", "mixed");
            AssertSelectionCheckbox(cut, "Deselect Catalog service", "true");
            AssertSelectionCheckbox(cut, "Deselect Resource for Basket service", "true");
            AssertSelectionCheckbox(cut, "Select Console logs for Basket service", "false");
            AssertSelectionCheckbox(cut, "Deselect Resource for Catalog service", "true");
            AssertSelectionCheckbox(cut, "Deselect Console logs for Catalog service", "true");
            AssertNoButtonHasAccessibleName(cut, "Select Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        AssertSelectionCheckbox(cut, "Select all", "mixed").Click();

        cut.WaitForAssertion(() =>
        {
            AssertAllSelectionControlsSelected(cut);
            AssertNoButtonHasAccessibleName(cut, "Deselect Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        AssertSelectionCheckbox(cut, "Deselect all", "true").Click();

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 7);
            AssertSelectionCheckbox(cut, "Select all", "false");
            AssertSelectionCheckbox(cut, "Select Basket service", "false");
            AssertSelectionCheckbox(cut, "Select Catalog service", "false");
            AssertSelectionCheckbox(cut, "Select Resource for Basket service", "false");
            AssertSelectionCheckbox(cut, "Select Console logs for Basket service", "false");
            AssertSelectionCheckbox(cut, "Select Resource for Catalog service", "false");
            AssertSelectionCheckbox(cut, "Select Console logs for Catalog service", "false");
            AssertNoButtonHasAccessibleName(cut, "Select Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });
    }

    private void SetupManageDataDialogServices(TestDashboardClient dashboardClient)
    {
        FluentUISetupHelpers.AddCommonDashboardServices(this);
        Services.AddLogging();
        Services.AddOptions<DashboardOptions>().Configure(options => options.UI.DisableImport = true);
        Services.AddSingleton<IconResolver>();
        Services.AddSingleton<IDashboardClient>(dashboardClient);
        Services.AddScoped<ConsoleLogsManager>();
        Services.AddScoped<ConsoleLogsFetcher>();
        Services.AddScoped<TelemetryExportService>();
        Services.AddScoped<TelemetryImportService>();

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

    private static void AssertAllSelectionControlsSelected(IRenderedComponent<ManageDataDialog> cut)
    {
        AssertSelectionCheckboxCount(cut, 7);
        AssertSelectionCheckbox(cut, "Deselect all", "true");
        AssertSelectionCheckbox(cut, "Deselect Basket service", "true");
        AssertSelectionCheckbox(cut, "Deselect Catalog service", "true");
        AssertSelectionCheckbox(cut, "Deselect Resource for Basket service", "true");
        AssertSelectionCheckbox(cut, "Deselect Console logs for Basket service", "true");
        AssertSelectionCheckbox(cut, "Deselect Resource for Catalog service", "true");
        AssertSelectionCheckbox(cut, "Deselect Console logs for Catalog service", "true");
    }

    private static IElement AssertSelectionCheckbox(IRenderedComponent<ManageDataDialog> cut, string accessibleName, string ariaChecked)
    {
        var button = Assert.Single(GetSelectionCheckboxes(cut), button => ButtonHasAccessibleName(button, accessibleName));

        Assert.Equal("checkbox", button.GetAttribute("role"));
        Assert.Equal(ariaChecked, button.GetAttribute("aria-checked"));

        return button;
    }

    private static void AssertSelectionCheckboxCount(IRenderedComponent<ManageDataDialog> cut, int expectedCount) =>
        Assert.Equal(expectedCount, GetSelectionCheckboxes(cut).Count);

    private static void AssertNoButtonHasAccessibleName(IRenderedComponent<ManageDataDialog> cut, string accessibleName) =>
        Assert.DoesNotContain(
            cut.FindAll("fluent-button"),
            button =>
                string.Equals(button.GetAttribute("title"), accessibleName, StringComparison.Ordinal) ||
                string.Equals(button.GetAttribute("aria-label"), accessibleName, StringComparison.Ordinal));

    private static bool ButtonHasAccessibleName(IElement button, string accessibleName) =>
        string.Equals(button.GetAttribute("title"), accessibleName, StringComparison.Ordinal) &&
        string.Equals(button.GetAttribute("aria-label"), accessibleName, StringComparison.Ordinal);

    private static IReadOnlyList<IElement> GetSelectionCheckboxes(IRenderedComponent<ManageDataDialog> cut)
    {
        return cut.FindComponent<FluentDataGrid<ManageDataGridItem>>().FindAll("[role='checkbox']");
    }
}
