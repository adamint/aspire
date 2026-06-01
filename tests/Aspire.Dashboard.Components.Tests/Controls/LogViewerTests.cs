// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using System.Text.RegularExpressions;
using Aspire.Dashboard.Components.Tests.Shared;
using Aspire.Shared.ConsoleLogs;
using Bunit;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Aspire.Dashboard.Components.Tests.Controls;

public class LogViewerTests : DashboardTestContext
{
    private const string AppCssRelativePath = "src/Aspire.Dashboard/wwwroot/css/app.css";
    private const string DarkThemeSelector = "[data-theme=\"dark\"]";

    [Fact]
    public void ResourcePrefixStyle_UsesTextColorWithWcagContrastForDarkAccentPalette()
    {
        var darkAccentColors = ParseDarkAccentPalette();

        foreach (var accentVariableName in ColorGenerator.s_variableNames)
        {
            Assert.True(
                darkAccentColors.TryGetValue(accentVariableName, out var backgroundColor),
                $"{DarkThemeSelector} in {AppCssRelativePath} is missing ColorGenerator variable '{accentVariableName}'. Add it to the dark accent palette or update {nameof(ColorGenerator.s_variableNames)}. Parsed variables: {string.Join(", ", darkAccentColors.Keys.OrderBy(k => k, StringComparer.Ordinal))}.");

            var foregroundColor = ResourcePrefixStyle.GetTextColor(accentVariableName);
            var contrastRatio = GetContrastRatio(foregroundColor, backgroundColor);

            Assert.True(
                contrastRatio >= 4.5,
                $"{accentVariableName} resource prefix uses {foregroundColor} text on {backgroundColor} from {AppCssRelativePath} with {contrastRatio.ToString("0.##", CultureInfo.InvariantCulture)}:1 contrast.");
        }
    }

    [Fact]
    public void LogViewer_RendersResourcePrefixWithGeneratedStyle()
    {
        ColorGenerator.Instance.Clear();

        SetupLogViewerServices();

        var logEntries = new LogEntries(maximumEntryCount: int.MaxValue) { BaseLineNumber = 1 };
        logEntries.InsertSorted(LogEntry.Create(
            timestamp: null,
            logMessage: "Test log message",
            rawLogContent: "Test log message",
            isErrorMessage: false,
            resourcePrefix: $"resource-{Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture)}"));

        var cut = RenderComponent<LogViewer>(builder =>
        {
            builder.Add(p => p.LogEntries, logEntries);
            builder.Add(p => p.ShowResourcePrefix, true);
        });

        cut.WaitForAssertion(() =>
        {
            var prefixElement = Assert.Single(cut.FindAll(".resource-prefix"));
            var style = prefixElement.GetAttribute("style") ?? string.Empty;
            var accentVariableName = GetBackgroundAccentVariableName(style);
            var foregroundColor = GetResourceTextColor(style);

            Assert.True(
                ColorGenerator.s_variableNames.Contains(accentVariableName),
                $"Resource prefix background '{accentVariableName}' from style '{style}' must be generated from {nameof(ColorGenerator.s_variableNames)}.");
            Assert.Equal(ResourcePrefixStyle.GetTextColor(accentVariableName), foregroundColor);
        });
    }

    private static string GetBackgroundAccentVariableName(string style)
    {
        var background = GetCssPropertyValue(style, "background");
        Assert.True(background.StartsWith("var(", StringComparison.Ordinal), $"Unexpected background style: {style}");
        Assert.True(background.EndsWith(')'), $"Unexpected background style: {style}");
        return background[4..^1];
    }

    private static string GetResourceTextColor(string style)
    {
        var color = GetCssPropertyValue(style, "--resource-text-color");

        Assert.False(string.IsNullOrWhiteSpace(color), $"Expected resource prefix style to set --resource-text-color so LogViewer.razor.css can resolve color: var(--resource-text-color). Style: {style}");
        return color;
    }

    private static string GetCssPropertyValue(string style, string propertyName)
    {
        // Resource prefix styles are generated as:
        //   background: var(--accent-bronze); --resource-text-color: #fff;
        // Split declarations because CSS values here do not contain semicolons.
        var declarations = style.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var propertyPrefix = propertyName + ":";

        foreach (var declaration in declarations)
        {
            if (declaration.StartsWith(propertyPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return declaration[propertyPrefix.Length..].Trim();
            }
        }

        return string.Empty;
    }

    private static Dictionary<string, string> ParseDarkAccentPalette()
    {
        var appCssPath = FindAppCssPath();
        var css = File.ReadAllText(appCssPath);
        var darkThemeBlock = GetCssRuleBlock(css, DarkThemeSelector, appCssPath);
        var declarations = ParseCssDeclarations(darkThemeBlock);
        var palette = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (propertyName, value) in declarations)
        {
            if (propertyName.StartsWith("--accent-", StringComparison.Ordinal))
            {
                palette[propertyName] = value;
            }
        }

        Assert.NotEmpty(palette);
        return palette;
    }

    private static string FindAppCssPath()
    {
        foreach (var startDirectory in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var directory = new DirectoryInfo(startDirectory);

            while (directory is not null)
            {
                var candidate = Path.Combine(directory.FullName, AppCssRelativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"Could not find {AppCssRelativePath} by walking up from {AppContext.BaseDirectory} or {Directory.GetCurrentDirectory()}.");
    }

    private static string GetCssRuleBlock(string css, string selector, string appCssPath)
    {
        var selectorIndex = css.IndexOf(selector, StringComparison.Ordinal);
        Assert.True(selectorIndex >= 0, $"Could not find selector '{selector}' in {appCssPath}.");

        var blockStartIndex = css.IndexOf('{', selectorIndex);
        Assert.True(blockStartIndex >= 0, $"Could not find opening '{{' for selector '{selector}' in {appCssPath}.");

        var depth = 0;
        for (var i = blockStartIndex; i < css.Length; i++)
        {
            depth += css[i] switch
            {
                '{' => 1,
                '}' => -1,
                _ => 0
            };

            if (depth == 0)
            {
                return css[(blockStartIndex + 1)..i];
            }
        }

        throw new InvalidOperationException($"Could not find closing '}}' for selector '{selector}' in {appCssPath}.");
    }

    private static List<(string PropertyName, string Value)> ParseCssDeclarations(string cssBlock)
    {
        // The dark theme rule in app.css is a flat declaration block:
        //   [data-theme="dark"] {
        //       --accent-teal: #2CB7BD;
        //       --accent-marigold: #F3D58E;
        //   }
        // Strip block comments so section labels like "/* accent variables */" don't become
        // part of the following declaration's property name.
        var blockWithoutComments = Regex.Replace(cssBlock, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline);
        var declarations = new List<(string PropertyName, string Value)>();

        foreach (var declaration in blockWithoutComments.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var separatorIndex = declaration.IndexOf(':', StringComparison.Ordinal);
            if (separatorIndex < 0)
            {
                continue;
            }

            var propertyName = declaration[..separatorIndex].Trim();
            var value = declaration[(separatorIndex + 1)..].Trim();

            if (propertyName.Length > 0 && value.Length > 0)
            {
                declarations.Add((propertyName, value));
            }
        }

        return declarations;
    }

    private static double GetContrastRatio(string foregroundColor, string backgroundColor)
    {
        var foregroundLuminance = GetRelativeLuminance(foregroundColor);
        var backgroundLuminance = GetRelativeLuminance(backgroundColor);
        var lighter = Math.Max(foregroundLuminance, backgroundLuminance);
        var darker = Math.Min(foregroundLuminance, backgroundLuminance);

        return (lighter + 0.05) / (darker + 0.05);
    }

    private static double GetRelativeLuminance(string color)
    {
        var (red, green, blue) = ParseHexColor(color);

        return 0.2126 * GetLinearColorValue(red) + 0.7152 * GetLinearColorValue(green) + 0.0722 * GetLinearColorValue(blue);
    }

    private static double GetLinearColorValue(int value)
    {
        var channel = value / 255d;

        return channel <= 0.04045
            ? channel / 12.92
            : Math.Pow((channel + 0.055) / 1.055, 2.4);
    }

    private static (int Red, int Green, int Blue) ParseHexColor(string color)
    {
        if (color is ['#', var shortRed, var shortGreen, var shortBlue])
        {
            return (
                ParseHexByte(shortRed, shortRed),
                ParseHexByte(shortGreen, shortGreen),
                ParseHexByte(shortBlue, shortBlue));
        }

        Assert.True(color.Length == 7 && color[0] == '#', $"Unexpected color format: {color}");

        return (
            ParseHexByte(color[1], color[2]),
            ParseHexByte(color[3], color[4]),
            ParseHexByte(color[5], color[6]));
    }

    private static int ParseHexByte(char high, char low)
    {
        return int.Parse([high, low], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    }

    private void SetupLogViewerServices()
    {
        FluentUISetupHelpers.AddCommonDashboardServices(this, browserTimeProvider: new TestTimeProvider());
        Services.AddLogging();

        JSInterop.SetupVoid("initializeContinuousScroll");
        JSInterop.SetupVoid("resetContinuousScrollPosition");
    }
}
