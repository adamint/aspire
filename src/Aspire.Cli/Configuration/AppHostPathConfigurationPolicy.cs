// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Utils;

namespace Aspire.Cli.Configuration;

internal static class AppHostPathConfigurationPolicy
{
    public const string LegacyAppHostPathKey = "appHostPath";
    public const string AppHostKey = "appHost";
    public const string PathKey = "path";
    public const string AppHostPathKey = "appHost.path";
    public const string AppHostPathConfigurationKey = "appHost:path";

    public static bool IsLegacyAppHostPathKey(string key) =>
        string.Equals(key, LegacyAppHostPathKey, StringComparison.OrdinalIgnoreCase);

    public static bool IsAppHostPathKey(string key)
    {
        var normalizedKey = key.Replace(':', '.');

        return string.Equals(normalizedKey, AppHostPathKey, StringComparison.OrdinalIgnoreCase)
            || string.Equals(normalizedKey, LegacyAppHostPathKey, StringComparison.OrdinalIgnoreCase);
    }

    public static bool TryFindAppHostPathKey(string filePath, out string? key)
    {
        key = null;

        if (!File.Exists(filePath))
        {
            return false;
        }

        JsonObject? settings;
        try
        {
            var content = File.ReadAllText(filePath);
            if (string.IsNullOrWhiteSpace(content))
            {
                return false;
            }

            settings = JsonNode.Parse(content, documentOptions: ConfigurationHelper.ParseOptions)?.AsObject();
        }
        catch (JsonException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }

        if (settings is null)
        {
            return false;
        }

        if (settings.ContainsKey(LegacyAppHostPathKey))
        {
            key = LegacyAppHostPathKey;
            return true;
        }

        if (settings.ContainsKey(AppHostPathConfigurationKey))
        {
            key = AppHostPathConfigurationKey;
            return true;
        }

        if (settings.TryGetPropertyValue(AppHostKey, out var appHostNode) &&
            appHostNode is JsonObject appHost &&
            appHost.ContainsKey(PathKey))
        {
            key = AppHostPathKey;
            return true;
        }

        return false;
    }
}
