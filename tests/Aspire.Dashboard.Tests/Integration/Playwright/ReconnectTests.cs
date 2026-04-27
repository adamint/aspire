// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Tests.Integration.Playwright.Infrastructure;
using Aspire.TestUtilities;
using Microsoft.AspNetCore.InternalTesting;
using Xunit;

namespace Aspire.Dashboard.Tests.Integration.Playwright;

[RequiresFeature(TestFeature.Playwright)]
public class ReconnectTests : PlaywrightTestsBase<DashboardServerFixture>
{
    public ReconnectTests(DashboardServerFixture dashboardServerFixture)
        : base(dashboardServerFixture)
    {
    }

    [Fact]
    [OuterloopTest("Resource-intensive Playwright browser test")]
    public async Task ReconnectNotice_Shown_IsModeless()
    {
        await RunTestAsync(async page =>
        {
            await PlaywrightFixture.GoToHomeAndWaitForDataGridLoad(page).DefaultTimeout();

            var reconnectState = await page.EvaluateAsync<bool[]>(
                """
                () => {
                    const reconnectDialog = document.getElementById("components-reconnect-modal");
                    reconnectDialog.dispatchEvent(new CustomEvent("components-reconnect-state-changed", { detail: { state: "show" } }));

                    return [reconnectDialog.open, reconnectDialog.matches(":modal")];
                }
                """).DefaultTimeout();

            Assert.Collection(
                reconnectState,
                open => Assert.True(open),
                modal => Assert.False(modal));

            var isOpenAfterHide = await page.EvaluateAsync<bool>(
                """
                () => {
                    const reconnectDialog = document.getElementById("components-reconnect-modal");
                    reconnectDialog.dispatchEvent(new CustomEvent("components-reconnect-state-changed", { detail: { state: "hide" } }));

                    return reconnectDialog.open;
                }
                """).DefaultTimeout();

            Assert.False(isOpenAfterHide);
        });
    }
}
