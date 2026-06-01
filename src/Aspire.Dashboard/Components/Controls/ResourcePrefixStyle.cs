// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Dashboard.Components;

/// <summary>
/// Generates inline styles for console log resource prefixes.
/// </summary>
internal static class ResourcePrefixStyle
{
    internal const string DarkTextColor = "#000";
    internal const string LightTextColor = "#fff";

    internal static string GetStyle(string resourcePrefix)
    {
        var colorIndex = ColorGenerator.Instance.GetColorIndex(resourcePrefix);
        var accentVariableName = ColorGenerator.s_variableNames[colorIndex];
        var textColor = GetTextColor(accentVariableName);

        return $"background: var({accentVariableName}); --resource-text-color: {textColor};";
    }

    internal static string GetTextColor(string accentVariableName)
    {
        // The log viewer uses the dashboard dark accent palette for resource prefixes.
        // Most accents meet WCAG AA contrast with black text, but these dark accents do not.
        // See https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
        return accentVariableName switch
        {
            "--accent-bronze" or "--accent-navy" or "--accent-ocean" => LightTextColor,
            _ => DarkTextColor
        };
    }
}
