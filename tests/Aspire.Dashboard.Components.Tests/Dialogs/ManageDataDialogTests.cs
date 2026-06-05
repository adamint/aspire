// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
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
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.FluentUI.AspNetCore.Components;
using Xunit;

namespace Aspire.Dashboard.Components.Tests.Dialogs;

[UseCulture("en-US")]
public sealed class ManageDataDialogTests : DashboardTestContext
{
    [Fact]
    public async Task Render_SelectionControlsExposeAccessibleNamesCheckboxRoleAndState()
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
            Assert.Contains(JSInterop.Invocations, invocation => invocation.Identifier == "initializeSelectionCheckboxKeyboard");
            AssertSelectionCheckboxCount(cut, 3);
            AssertSelectionCheckbox(cut, "All data", "true");
            AssertSelectionCheckbox(cut, "Basket service", "true");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
            AssertSelectionCheckboxesHaveNoActionLabels(cut);
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        await ClickSelectionCheckboxAsync(cut, "Basket service", "true");

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 3);
            AssertSelectionCheckbox(cut, "All data", "mixed");
            AssertSelectionCheckbox(cut, "Basket service", "false");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
        });

        await ClickSelectionCheckboxAsync(cut, "Basket service", "false");

        cut.WaitForAssertion(() =>
        {
            AssertSelectionCheckboxCount(cut, 3);
            AssertSelectionCheckbox(cut, "All data", "true");
            AssertSelectionCheckbox(cut, "Basket service", "true");
            AssertSelectionCheckbox(cut, "Catalog service", "true");
        });

        await ExpandResourceRowsAsync(cut, expectedCount: 2);

        cut.WaitForAssertion(() =>
        {
            AssertAllSelectionControlsSelected(cut);
            AssertNoSelectionCheckboxHasAccessibleName(cut, "Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        await ClickSelectionCheckboxAsync(cut, "Console logs for Basket service", "true");

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

        await ClickSelectionCheckboxAsync(cut, "All data", "mixed");

        cut.WaitForAssertion(() =>
        {
            AssertAllSelectionControlsSelected(cut);
            AssertNoSelectionCheckboxHasAccessibleName(cut, "Console logs");
            AssertNoButtonHasAccessibleName(cut, "Name");
        });

        await ClickSelectionCheckboxAsync(cut, "All data", "true");

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

    [Fact]
    public async Task SelectionCheckboxKeyboardScript_HandlesOnlyEnabledSpaceKey()
    {
        var scriptPath = GetManageDataDialogScriptPath();
        var script = """
            import { readFileSync } from 'node:fs';
            import assert from 'node:assert/strict';

            const source = readFileSync(process.argv[2], 'utf8');
            const manageDataModule = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

            function createKeydownEvent(options = {}) {
                return {
                    key: options.key ?? ' ',
                    code: options.code ?? '',
                    repeat: options.repeat ?? false,
                    target: options.target,
                    prevented: false,
                    stopped: false,
                    preventDefault() {
                        this.prevented = true;
                    },
                    stopPropagation() {
                        this.stopped = true;
                    }
                };
            }

            class FakeElement {
                children = [];
                listeners = new Map();
                parentElement = null;
                clickCount = 0;

                constructor(tagName, attributes = {}) {
                    this.tagName = tagName.toUpperCase();
                    this.attributes = new Map(Object.entries(attributes));
                }

                appendChild(child) {
                    child.parentElement = this;
                    this.children.push(child);
                }

                contains(element) {
                    let current = element;
                    while (current) {
                        if (current === this) {
                            return true;
                        }

                        current = current.parentElement;
                    }

                    return false;
                }

                getAttribute(name) {
                    return this.attributes.get(name) ?? null;
                }

                setAttribute(name, value) {
                    this.attributes.set(name, value);
                }

                matches(selector) {
                    if (selector.startsWith('.')) {
                        return (this.attributes.get('class') ?? '')
                            .split(/\s+/)
                            .includes(selector.substring(1));
                    }

                    return this.tagName.toLowerCase() === selector;
                }

                closest(selector) {
                    let current = this;
                    while (current) {
                        if (current.matches(selector)) {
                            return current;
                        }

                        current = current.parentElement;
                    }

                    return null;
                }

                addEventListener(type, listener, options = false) {
                    const listeners = this.listeners.get(type) ?? [];
                    listeners.push({ listener, capture: getCapture(options) });
                    this.listeners.set(type, listeners);
                }

                removeEventListener(type, listener, options = false) {
                    const capture = getCapture(options);
                    const listeners = this.listeners.get(type) ?? [];
                    this.listeners.set(type, listeners.filter(l => l.listener !== listener || l.capture !== capture));
                }

                dispatchKeydown(event) {
                    for (const registration of this.listeners.get('keydown') ?? []) {
                        registration.listener(event);
                    }

                    return event;
                }

                click() {
                    this.clickCount++;
                }
            }

            function getCapture(options) {
                return typeof options === 'boolean'
                    ? options
                    : options?.capture === true;
            }

            globalThis.Element = FakeElement;

            const container = new FakeElement('div');
            const checkbox = new FakeElement('span', { class: 'manage-data-selection-checkbox' });
            const child = new FakeElement('span');
            container.appendChild(checkbox);
            checkbox.appendChild(child);

            manageDataModule.initializeSelectionCheckboxKeyboard(container);

            const space = container.dispatchKeydown(createKeydownEvent({ target: child }));
            assert.equal(space.prevented, true);
            assert.equal(space.stopped, true);
            assert.equal(checkbox.clickCount, 1);

            const legacySpace = container.dispatchKeydown(createKeydownEvent({ key: 'Spacebar', target: checkbox }));
            assert.equal(legacySpace.prevented, true);
            assert.equal(legacySpace.stopped, true);
            assert.equal(checkbox.clickCount, 2);

            const codeSpace = container.dispatchKeydown(createKeydownEvent({ key: 'Unidentified', code: 'Space', target: checkbox }));
            assert.equal(codeSpace.prevented, true);
            assert.equal(codeSpace.stopped, true);
            assert.equal(checkbox.clickCount, 3);

            const repeatSpace = container.dispatchKeydown(createKeydownEvent({ repeat: true, target: checkbox }));
            assert.equal(repeatSpace.prevented, false);
            assert.equal(repeatSpace.stopped, false);
            assert.equal(checkbox.clickCount, 3);

            const enter = container.dispatchKeydown(createKeydownEvent({ key: 'Enter', target: checkbox }));
            assert.equal(enter.prevented, false);
            assert.equal(enter.stopped, false);
            assert.equal(checkbox.clickCount, 3);

            checkbox.setAttribute('aria-disabled', 'true');
            const disabledSpace = container.dispatchKeydown(createKeydownEvent({ target: checkbox }));
            assert.equal(disabledSpace.prevented, false);
            assert.equal(disabledSpace.stopped, false);
            assert.equal(checkbox.clickCount, 3);

            const outsideCheckbox = new FakeElement('span', { class: 'manage-data-selection-checkbox' });
            const outsideSpace = container.dispatchKeydown(createKeydownEvent({ target: outsideCheckbox }));
            assert.equal(outsideSpace.prevented, false);
            assert.equal(outsideSpace.stopped, false);
            assert.equal(outsideCheckbox.clickCount, 0);

            manageDataModule.disposeSelectionCheckboxKeyboard(container);

            checkbox.setAttribute('aria-disabled', 'false');
            const disposedSpace = container.dispatchKeydown(createKeydownEvent({ target: checkbox }));
            assert.equal(disposedSpace.prevented, false);
            assert.equal(disposedSpace.stopped, false);
            assert.equal(checkbox.clickCount, 3);
            """;

        await RunNodeScriptAsync(script, scriptPath);
    }

    private static string GetManageDataDialogScriptPath()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            var scriptPath = Path.Combine(directory.FullName, "src", "Aspire.Dashboard", "Components", "Dialogs", "ManageDataDialog.razor.js");
            if (File.Exists(scriptPath))
            {
                return scriptPath;
            }

            directory = directory.Parent;
        }

        Assert.Skip("ManageDataDialog.razor.js is required to run the Manage Data selection checkbox keyboard JavaScript test.");
        return string.Empty;
    }

    private static async Task RunNodeScriptAsync(string script, string scriptPath)
    {
        await SkipIfNodeUnavailableAsync();

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
        };
        process.StartInfo.ArgumentList.Add("--input-type=module");
        process.StartInfo.ArgumentList.Add("-");
        process.StartInfo.ArgumentList.Add(scriptPath);

        process.Start();

        await process.StandardInput.WriteAsync(script);
        process.StandardInput.Close();

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var waitTask = process.WaitForExitAsync();

        if (await Task.WhenAny(waitTask, Task.Delay(TimeSpan.FromSeconds(30))) != waitTask)
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("Timed out waiting for the Manage Data selection checkbox keyboard JavaScript test to complete.");
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        Assert.True(process.ExitCode == 0, $"""
            node exited with code {process.ExitCode}.

            stdout:
            {stdout}

            stderr:
            {stderr}
            """);
    }

    private static async Task SkipIfNodeUnavailableAsync()
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
        };
        process.StartInfo.ArgumentList.Add("--version");

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            Assert.Skip("Node.js is required to run the Manage Data selection checkbox keyboard JavaScript test.");
            return;
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var waitTask = process.WaitForExitAsync();

        if (await Task.WhenAny(waitTask, Task.Delay(TimeSpan.FromSeconds(10))) != waitTask)
        {
            process.Kill(entireProcessTree: true);
            Assert.Skip("Node.js is required to run the Manage Data selection checkbox keyboard JavaScript test, but `node --version` did not complete.");
            return;
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (process.ExitCode != 0)
        {
            Assert.Skip($"""
                Node.js is required to run the Manage Data selection checkbox keyboard JavaScript test, but `node --version` exited with code {process.ExitCode}.

                stdout:
                {stdout}

                stderr:
                {stderr}
                """);
        }
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

    private static async Task ExpandResourceRowsAsync(IRenderedComponent<ManageDataDialog> cut, int expectedCount)
    {
        for (var i = 0; i < expectedCount; i++)
        {
            await cut.InvokeAsync(() =>
            {
                var toggleButtons = cut.FindAll("fluent-button[aria-label='Toggle nesting']");

                Assert.Equal(expectedCount, toggleButtons.Count);

                toggleButtons[i].Click();
            });
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

    private static Task ClickSelectionCheckboxAsync(IRenderedComponent<ManageDataDialog> cut, string accessibleName, string ariaChecked) =>
        cut.InvokeAsync(() => AssertSelectionCheckbox(cut, accessibleName, ariaChecked).Click());

    private static IReadOnlyList<IElement> GetSelectionCheckboxes(IRenderedComponent<ManageDataDialog> cut)
    {
        return cut.FindComponent<FluentDataGrid<ManageDataGridItem>>().FindAll("[role='checkbox']");
    }
}
