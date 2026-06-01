// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Components.Layout;
using Aspire.Dashboard.Components.Tests.Shared;
using Aspire.Dashboard.Tests.Shared;
using Bunit;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Aspire.Dashboard.Components.Tests.Layout;

[UseCulture("en-US")]
public class MobileNavMenuTests : DashboardTestContext
{
    [Fact]
    public void MobileNavMenu_ConstrainedToRemainingViewport()
    {
        FluentUISetupHelpers.AddCommonDashboardServices(this);
        Services.AddSingleton<IDashboardClient>(new TestDashboardClient(isEnabled: true));
        FluentUISetupHelpers.SetupFluentUIComponents(this);
        FluentUISetupHelpers.SetupFluentDivider(this);
        FluentUISetupHelpers.SetupFluentAnchoredRegion(this);
        FluentUISetupHelpers.SetupFluentMenu(this);

        var cut = RenderComponent<MobileNavMenu>(builder =>
        {
            builder.Add(p => p.IsNavMenuOpen, true);
            builder.Add(p => p.IsAIEnabled, false);
            builder.Add(p => p.IsAgentHelpEnabled, false);
            builder.Add(p => p.CloseNavMenu, () => { });
            builder.Add(p => p.LaunchHelpAsync, () => Task.CompletedTask);
            builder.Add(p => p.LaunchAIAgentsAsync, () => Task.CompletedTask);
            builder.Add(p => p.LaunchAIAssistantAsync, () => Task.CompletedTask);
            builder.Add(p => p.LaunchNotificationsAsync, () => Task.CompletedTask);
            builder.Add(p => p.LaunchSettingsAsync, () => Task.CompletedTask);
        });

        var style = cut.Find("fluent-menu").GetAttribute("style");

        Assert.Contains("max-height: calc(100dvh - var(--mobile-header-height) - var(--mobile-nav-menu-offset))", style);
        Assert.DoesNotContain("height: 100vh", style);
        Assert.Contains("margin-top: var(--mobile-nav-menu-offset)", style);
        Assert.Contains("overflow-y: auto", style);
    }
}
