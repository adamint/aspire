// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Xunit;

namespace Aspire.Dashboard.Tests;

public class ReconnectScriptTests
{
    [Fact]
    public void ReconnectScript_OpensReconnectDialogModelessly()
    {
        var script = ReadDashboardScript("app-reconnect.js");

        Assert.DoesNotContain("showModal", script);
        Assert.Contains("reconnectModal.show();", script);
    }

    private static string ReadDashboardScript(string scriptName)
    {
        var dashboardAssemblyDirectory = Path.GetDirectoryName(typeof(DashboardWebApplication).Assembly.Location);
        Assert.NotNull(dashboardAssemblyDirectory);

        var scriptPath = Path.Combine(dashboardAssemblyDirectory, "wwwroot", "js", scriptName);
        Assert.True(File.Exists(scriptPath), $"Expected dashboard script to exist at '{scriptPath}'.");

        return File.ReadAllText(scriptPath);
    }
}
