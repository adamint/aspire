// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Components.Dialogs;
using Aspire.Dashboard.Components.Tests.Shared;
using Bunit;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Localization;
using Xunit;
using DashboardDialogs = Aspire.Dashboard.Resources.Dialogs;

namespace Aspire.Dashboard.Components.Tests.Dialogs;

public class HelpDialogTests : DashboardTestContext
{
    [Fact]
    public void Render_KeyboardShortcuts_UsesAssociatedDescriptionLists()
    {
        SetupHelpDialogServices();
        var loc = Services.GetRequiredService<IStringLocalizer<DashboardDialogs>>();
        var expectedCategoryNames = new[]
        {
            loc[nameof(DashboardDialogs.HelpDialogCategoryPanels)].Value,
            loc[nameof(DashboardDialogs.HelpDialogCategoryPageNavigation)].Value,
            loc[nameof(DashboardDialogs.HelpDialogCategoryNavigation)].Value
        };

        var cut = RenderComponent<HelpDialog>();

        var shortcutLists = cut.FindAll("dl");
        Assert.Equal(expectedCategoryNames.Length, shortcutLists.Count);

        for (var listIndex = 0; listIndex < shortcutLists.Count; listIndex++)
        {
            var shortcutList = shortcutLists[listIndex];
            var labelledBy = shortcutList.GetAttribute("aria-labelledby");
            Assert.False(string.IsNullOrWhiteSpace(labelledBy));

            var heading = cut.Find($"#{labelledBy}");
            Assert.Equal("h6", heading.TagName.ToLowerInvariant());
            Assert.Equal(expectedCategoryNames[listIndex], heading.TextContent.Trim());

            var descriptions = shortcutList.QuerySelectorAll("dt");
            var keyDescriptions = shortcutList.QuerySelectorAll("dd");
            Assert.NotEmpty(descriptions);
            Assert.Equal(descriptions.Length, keyDescriptions.Length);

            for (var i = 0; i < descriptions.Length; i++)
            {
                Assert.False(string.IsNullOrWhiteSpace(descriptions[i].TextContent));

                var keys = keyDescriptions[i].QuerySelectorAll("kbd");
                Assert.NotEmpty(keys);
                Assert.All(keys, key => Assert.False(string.IsNullOrWhiteSpace(key.TextContent)));
            }
        }

        var resetPanelSizesText = loc[nameof(DashboardDialogs.HelpDialogResetPanelSize)].Value;
        var resetPanelSizesTerm = Assert.Single(cut.FindAll("dt"), t => t.TextContent.Trim() == resetPanelSizesText);
        var resetPanelSizesKeys = resetPanelSizesTerm.NextElementSibling;
        Assert.NotNull(resetPanelSizesKeys);
        Assert.Equal("dd", resetPanelSizesKeys.TagName.ToLowerInvariant());
        Assert.Equal(["shift", "r"], resetPanelSizesKeys.QuerySelectorAll("kbd").Select(k => k.TextContent.Trim()).ToArray());
        Assert.Contains("+", resetPanelSizesKeys.TextContent);
    }

    private void SetupHelpDialogServices()
    {
        FluentUISetupHelpers.AddCommonDashboardServices(this);
        FluentUISetupHelpers.SetupFluentUIComponents(this);
        FluentUISetupHelpers.SetupFluentAnchor(this);
    }
}
