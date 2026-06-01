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
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
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
            AssertSelectionCheckbox(cut, "All data", "true");
            AssertSelectionCheckbox(cut, "Basket service", "true");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
            AssertSelectionCheckboxesHaveNoActionLabels(cut);
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        PressKey(AssertSelectionCheckbox(cut, "Basket service", "true"), "Tab");
        AssertSelectionCheckbox(cut, "Basket service", "true");

        PressKey(AssertSelectionCheckbox(cut, "Basket service", "true"), "Tab", shiftKey: true);
        AssertSelectionCheckbox(cut, "Basket service", "true");

        PressKey(AssertSelectionCheckbox(cut, "Basket service", "true"), "Enter");
        AssertSelectionCheckbox(cut, "Basket service", "true");

        PressSpace(AssertSelectionCheckbox(cut, "Basket service", "true"));

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 3);
            AssertSelectionCheckbox(cut, "All data", "mixed");
            AssertSelectionCheckbox(cut, "Basket service", "false");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
        });

        PressSpace(AssertSelectionCheckbox(cut, "Basket service", "false"));

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 3);
            AssertSelectionCheckbox(cut, "All data", "true");
            AssertSelectionCheckbox(cut, "Basket service", "true");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
        });

        ExpandResourceRows(cut, expectedCount: 2);

        cut.WaitForAssertion(() =>
        {
            AssertAllSelectionControlsSelected(cut);
            AssertNoSelectionCheckboxHasAccessibleName(cut, "Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        AssertSelectionCheckbox(cut, "Console logs for Basket service", "true").Click();

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 7);
            AssertSelectionCheckbox(cut, "All data", "mixed");
            AssertSelectionCheckbox(cut, "Basket service", "mixed");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
            AssertSelectionCheckbox(cut, "Resource for Basket service", "true");
            AssertSelectionCheckbox(cut, "Console logs for Basket service", "false");
            AssertSelectionCheckbox(cut, "Resource for Catalog service", "true");
            AssertSelectionCheckbox(cut, "Console logs for Catalog service", "true");
            AssertSelectionCheckboxesHaveNoActionLabels(cut);
            AssertNoSelectionCheckboxHasAccessibleName(cut, "Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        AssertSelectionCheckbox(cut, "All data", "mixed").Click();

        cut.WaitForAssertion(() =>
        {
            AssertAllSelectionControlsSelected(cut);
            AssertNoSelectionCheckboxHasAccessibleName(cut, "Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        AssertSelectionCheckbox(cut, "All data", "true").Click();

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 7);
            AssertSelectionCheckbox(cut, "All data", "false");
            AssertSelectionCheckbox(cut, "Basket service", "false");
            AssertSelectionCheckbox(cut, "Catalog service", "false");
            AssertSelectionCheckbox(cut, "Resource for Basket service", "false");
            AssertSelectionCheckbox(cut, "Console logs for Basket service", "false");
            AssertSelectionCheckbox(cut, "Resource for Catalog service", "false");
            AssertSelectionCheckbox(cut, "Console logs for Catalog service", "false");
            AssertSelectionCheckboxesHaveNoActionLabels(cut);
            AssertNoSelectionCheckboxHasAccessibleName(cut, "Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });
    }

    private void SetupManageDataDialogServices(TestDashboardClient dashboardClient)
    {
        FluentUISetupHelpers.AddCommonDashboardServices(this);
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

        var module = JSInterop.SetupModule("./Components/Dialogs/ManageDataDialog.razor.js");
        module.SetupVoid("initializeSelectionCheckboxKeyboard", _ => true);
        module.SetupVoid("disposeSelectionCheckboxKeyboard", _ => true);
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
        AssertSelectionCheckbox(cut, "All data", "true");
        AssertSelectionCheckbox(cut, "Basket service", "true");
        AssertSelectionCheckbox(cut, "Catalog service", "true");
        AssertSelectionCheckbox(cut, "Resource for Basket service", "true");
        AssertSelectionCheckbox(cut, "Console logs for Basket service", "true");
        AssertSelectionCheckbox(cut, "Resource for Catalog service", "true");
        AssertSelectionCheckbox(cut, "Console logs for Catalog service", "true");
        AssertSelectionCheckboxesHaveNoActionLabels(cut);
    }

    private static IElement AssertSelectionCheckbox(IRenderedComponent<ManageDataDialog> cut, string accessibleName, string ariaChecked)
    {
        var checkbox = Assert.Single(GetSelectionCheckboxes(cut), checkbox => ElementHasAccessibleName(checkbox, accessibleName));

        Assert.Equal("span", checkbox.LocalName);
        Assert.Equal("checkbox", checkbox.GetAttribute("role"));
        Assert.Equal(ariaChecked, checkbox.GetAttribute("aria-checked"));
        Assert.Equal("0", checkbox.GetAttribute("tabindex"));
        Assert.Empty(checkbox.QuerySelectorAll("fluent-button"));

        return checkbox;
    }

    private static void AssertSelectionCheckboxCount(IRenderedComponent<ManageDataDialog> cut, int expectedCount)
    {
        Assert.Empty(cut.FindAll("fluent-button[role='checkbox']"));
        Assert.Equal(expectedCount, GetSelectionCheckboxes(cut).Count);
    }

    private static void AssertSelectionCheckboxesHaveNoActionLabels(IRenderedComponent<ManageDataDialog> cut)
    {
        Assert.DoesNotContain(GetSelectionCheckboxes(cut), button =>
        {
            var accessibleName = button.GetAttribute("aria-label");

            return accessibleName is not null &&
                (accessibleName.StartsWith("Select ", StringComparison.Ordinal) ||
                 accessibleName.StartsWith("Deselect ", StringComparison.Ordinal));
        });
    }

    private static void AssertNoSelectionCheckboxHasAccessibleName(IRenderedComponent<ManageDataDialog> cut, string accessibleName) =>
        Assert.DoesNotContain(GetSelectionCheckboxes(cut), checkbox => ElementHasAccessibleName(checkbox, accessibleName));

    private static void AssertNoButtonHasAccessibleName(IRenderedComponent<ManageDataDialog> cut, string accessibleName) =>
        Assert.DoesNotContain(
            cut.FindAll("fluent-button"),
            element =>
                string.Equals(element.GetAttribute("title"), accessibleName, StringComparison.Ordinal) ||
                string.Equals(element.GetAttribute("aria-label"), accessibleName, StringComparison.Ordinal));

    private static bool ElementHasAccessibleName(IElement element, string accessibleName) =>
        string.Equals(element.GetAttribute("title"), accessibleName, StringComparison.Ordinal) &&
        string.Equals(element.GetAttribute("aria-label"), accessibleName, StringComparison.Ordinal);

    private static void PressSpace(IElement element) =>
        PressKey(element, " ", code: "Space");

    private static void PressKey(IElement element, string key, string? code = null, bool shiftKey = false) =>
        element.TriggerEvent("onkeydown", new KeyboardEventArgs { Key = key, Code = code ?? string.Empty, ShiftKey = shiftKey });

    private static IReadOnlyList<IElement> GetSelectionCheckboxes(IRenderedComponent<ManageDataDialog> cut)
    {
        return cut.FindComponent<FluentDataGrid<ManageDataGridItem>>().FindAll("[role='checkbox']");
    }
}
