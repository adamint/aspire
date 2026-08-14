// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Configuration;
using Aspire.Cli.Resources;
using Microsoft.Extensions.Configuration;

namespace Aspire.Cli.Utils;

internal static class ConfigurationHelper
{
    internal const string IntegrationCacheFolderName = "integrations";

    /// <summary>
    /// Standard options for parsing JSON that may contain non-spec features like comments and trailing commas.
    /// </summary>
    public static readonly JsonDocumentOptions ParseOptions = new()
    {
        CommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    internal static void RegisterSettingsFiles(IConfigurationBuilder configuration, DirectoryInfo workingDirectory, FileInfo globalSettingsFile)
    {
        var currentDirectory = workingDirectory;

        // Find the nearest local settings file (prefer aspire.config.json, fall back to .aspire/settings.json)
        FileInfo? localSettingsFile = null;

        while (currentDirectory is not null)
        {
            // Check for aspire.config.json first (new format)
            var newSettingsPath = Path.Combine(currentDirectory.FullName, AspireConfigFile.FileName);
            if (File.Exists(newSettingsPath))
            {
                localSettingsFile = new FileInfo(newSettingsPath);
                break;
            }

            // TODO: Remove legacy .aspire/settings.json fallback once confident most users have migrated.
            // Tracked by https://github.com/microsoft/aspire/issues/15239
            // Fall back to .aspire/settings.json (legacy format).
            //
            // Startup is shared by every command — including read-only ones (aspire ls, ps,
            // doctor, describe, --version). Earlier versions eagerly migrated the legacy file
            // to aspire.config.json here so the workspace would move forward on the user's
            // first run of a newer CLI (https://github.com/microsoft/aspire/issues/15488),
            // but that broke the "read commands don't mutate the working tree" contract:
            // running aspire ls in a workspace that only had .aspire/settings.json was
            // silently writing aspire.config.json, polluting git status and tripping CI
            // dirty-tree checks (https://github.com/microsoft/aspire/issues/17615).
            //
            // Migration is now deferred to commands that already mutate the workspace
            // (aspire run/add/init/update/etc. via ProjectLocator.CreateSettingsFileAsync ->
            // AspireConfigFile.LoadOrCreate). Read commands continue to work against the
            // legacy file directly: AppHostPathConfigurationPolicy.TryFindAppHostPathKey
            // accepts both the legacy flat "appHostPath" key and the modern "appHost:path"
            // hierarchical key, and ProjectLocator's settings-file reader has its own legacy
            // fallback that does not write.
            var legacySettingsPath = BuildPathToSettingsJsonFile(currentDirectory.FullName);
            if (File.Exists(legacySettingsPath))
            {
                localSettingsFile = new FileInfo(legacySettingsPath);
                break;
            }

            currentDirectory = currentDirectory.Parent;
        }

        // Add global settings first (if it exists) - lower precedence
        if (File.Exists(globalSettingsFile.FullName))
        {
            AddSettingsFile(configuration, globalSettingsFile.FullName);
        }

        // Then add local settings (if found) - this will override global settings
        if (localSettingsFile is not null)
        {
            AddSettingsFile(configuration, localSettingsFile.FullName);
        }
    }

    internal static string BuildPathToSettingsJsonFile(string workingDirectory)
    {
        return Path.Combine(workingDirectory, ".aspire", "settings.json");
    }

    internal static DirectoryInfo? GetLegacySettingsRootDirectory(FileInfo settingsFile)
    {
        if (!string.Equals(settingsFile.Name, AspireJsonConfiguration.FileName, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var settingsDirectory = settingsFile.Directory;
        if (settingsDirectory is null || !string.Equals(settingsDirectory.Name, AspireJsonConfiguration.SettingsFolder, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return settingsDirectory.Parent;
    }

    internal static DirectoryInfo GetConfigRootDirectory(DirectoryInfo startDirectory)
    {
        ArgumentNullException.ThrowIfNull(startDirectory);

        var configPath = FindNearestConfigFilePath(startDirectory);
        if (configPath is null)
        {
            return startDirectory;
        }

        var configFile = new FileInfo(configPath);

        // Legacy layout: <root>/.aspire/settings.json -> <root>
        var legacyRoot = GetLegacySettingsRootDirectory(configFile);
        if (legacyRoot is not null)
        {
            return legacyRoot;
        }

        // Modern layout: <root>/aspire.config.json -> <root>
        return configFile.Directory is { Exists: true } configDirectory
            ? configDirectory
            : startDirectory;
    }

    internal static DirectoryInfo GetWorkspaceAspireDirectory(DirectoryInfo startDirectory)
    {
        var configRoot = GetConfigRootDirectory(startDirectory);
        return new DirectoryInfo(Path.Combine(configRoot.FullName, AspireJsonConfiguration.SettingsFolder));
    }

    internal static DirectoryInfo GetIntegrationCacheDirectory(DirectoryInfo startDirectory)
    {
        var workspaceAspireDirectory = GetWorkspaceAspireDirectory(startDirectory);
        return new DirectoryInfo(Path.Combine(workspaceAspireDirectory.FullName, IntegrationCacheFolderName));
    }

    /// <summary>
    /// Searches upward from <paramref name="startDirectory"/> for the nearest
    /// <c>aspire.config.json</c> or legacy <c>.aspire/settings.json</c>.
    /// </summary>
    /// <returns>The full path to the config file, or <c>null</c> if none is found.</returns>
    internal static string? FindNearestConfigFilePath(DirectoryInfo startDirectory)
    {
        var searchDir = startDirectory;
        while (searchDir is not null)
        {
            var configPath = Path.Combine(searchDir.FullName, AspireConfigFile.FileName);
            if (File.Exists(configPath))
            {
                return configPath;
            }

            var legacyPath = BuildPathToSettingsJsonFile(searchDir.FullName);
            if (File.Exists(legacyPath))
            {
                return legacyPath;
            }

            searchDir = searchDir.Parent;
        }

        return null;
    }

    internal static bool TryLoadSettingsFile(string filePath, out IConfigurationRoot configuration)
    {
        configuration = new ConfigurationRoot([]);

        if (!File.Exists(filePath))
        {
            return false;
        }

        try
        {
            var content = File.ReadAllText(filePath);

            if (string.IsNullOrWhiteSpace(content))
            {
                return false;
            }

            var node = ParseSettingsObject(content);
            if (node is null)
            {
                return false;
            }

            var cleanJson = node.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            var bytes = System.Text.Encoding.UTF8.GetBytes(cleanJson);
            configuration = new ConfigurationBuilder()
                .AddJsonStream(new MemoryStream(bytes))
                .Build();

            return true;
        }
        catch (JsonException)
        {
            return false;
        }
        catch (InvalidDataException)
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
    }

    /// <summary>
    /// Serializes a JsonObject and writes it to a settings file, creating the directory if needed.
    /// </summary>
    internal static async Task WriteSettingsFileAsync(string filePath, JsonObject settings, CancellationToken cancellationToken = default)
    {
        var jsonContent = JsonSerializer.Serialize(settings, JsonSourceGenerationContext.Default.JsonObject);

        EnsureDirectoryExists(filePath);
        await File.WriteAllTextAsync(filePath, jsonContent, cancellationToken);
    }

    /// <summary>
    /// Serializes a JsonObject and writes it to a settings file, creating the directory if needed.
    /// </summary>
    internal static void WriteSettingsFile(string filePath, JsonObject settings)
    {
        var jsonContent = JsonSerializer.Serialize(settings, JsonSourceGenerationContext.Default.JsonObject);

        EnsureDirectoryExists(filePath);
        File.WriteAllText(filePath, jsonContent);
    }

    private static void EnsureDirectoryExists(string filePath)
    {
        var directory = Path.GetDirectoryName(filePath);
        if (directory is not null && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    private static void AddSettingsFile(IConfigurationBuilder configuration, string filePath)
    {
        // Proactively normalize the settings file to prevent duplicate key errors.
        // This handles files corrupted by mixing colon and dot notation
        // (e.g., both "features:key" flat entry and "features" nested object).
        TryNormalizeSettingsFile(filePath);

        // Pre-process the file to handle comments and trailing commas.
        // Microsoft.Extensions.Configuration.Json doesn't support JSON comments,
        // so we parse with comment support and load the clean JSON via stream.
        try
        {
            var content = File.ReadAllText(filePath);
            var node = ParseSettingsObject(content);
            if (node is not null)
            {
                var cleanJson = node.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
                var bytes = System.Text.Encoding.UTF8.GetBytes(cleanJson);
                configuration.AddJsonStream(new MemoryStream(bytes));
                return;
            }
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                string.Format(CultureInfo.CurrentCulture, ErrorStrings.InvalidJsonInConfigFile, filePath, ex.Message),
                ex);
        }

        configuration.AddJsonFile(filePath, optional: true);
    }

    /// <summary>
    /// Normalizes a settings file by converting flat colon-separated keys to nested JSON objects.
    /// </summary>
    internal static bool TryNormalizeSettingsFile(string filePath)
    {
        try
        {
            var content = File.ReadAllText(filePath);

            if (string.IsNullOrWhiteSpace(content))
            {
                return false;
            }

            using var document = JsonDocument.Parse(content, ParseOptions);
            if (document.RootElement.ValueKind is not JsonValueKind.Object ||
                !NeedsNormalization(document.RootElement))
            {
                return false;
            }

            WriteSettingsFile(filePath, NormalizeSettingsObject(document.RootElement));

            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Parses a settings JSON document while normalizing the case-insensitive configuration
    /// hierarchy before Microsoft.Extensions.Configuration sees it.
    /// </summary>
    /// <remarks>
    /// JSON permits duplicate property names, while the configuration provider treats keys
    /// case-insensitively. Enumerating with <see cref="JsonDocument"/> preserves duplicate
    /// properties long enough to merge them deterministically instead of letting the provider
    /// throw for inputs such as <c>{"NuGetSource":"a","nugetsource":"b"}</c>.
    /// </remarks>
    internal static JsonObject? ParseSettingsObject(string content)
    {
        using var document = JsonDocument.Parse(content, ParseOptions);
        return document.RootElement.ValueKind is JsonValueKind.Object
            ? NormalizeSettingsObject(document.RootElement)
            : null;
    }

    private static JsonObject NormalizeSettingsObject(JsonElement element)
    {
        var normalized = new JsonObject();
        var properties = element.EnumerateObject().ToArray();

        foreach (var property in properties)
        {
            if (!property.Name.Contains(':', StringComparison.Ordinal))
            {
                OverlayJsonPath(normalized, property.Name.Split(':'), NormalizeJsonElement(property.Value));
            }
        }

        // A nested JSON object is the authoritative representation when a file contains both
        // "features":{"flag":false} and "features:flag":true. Process flat entries in reverse
        // order so duplicate flat keys still use the last value, while existing nested leaves
        // and their disjoint children are preserved.
        for (var i = properties.Length - 1; i >= 0; i--)
        {
            var property = properties[i];
            if (property.Name.Contains(':', StringComparison.Ordinal))
            {
                OverlayJsonPathPreservingExisting(
                    normalized,
                    property.Name.Split(':'),
                    NormalizeJsonElement(property.Value));
            }
        }

        return normalized;
    }

    private static JsonNode? NormalizeJsonElement(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => NormalizeSettingsObject(element),
            JsonValueKind.Array => NormalizeJsonArray(element),
            JsonValueKind.Null => null,
            _ => JsonNode.Parse(element.GetRawText())
        };
    }

    private static JsonArray NormalizeJsonArray(JsonElement element)
    {
        var normalized = new JsonArray();
        foreach (var item in element.EnumerateArray())
        {
            normalized.Add(NormalizeJsonElement(item));
        }

        return normalized;
    }

    private static bool NeedsNormalization(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => NeedsObjectNormalization(element),
            JsonValueKind.Array => element.EnumerateArray().Any(NeedsNormalization),
            _ => false
        };
    }

    private static bool NeedsObjectNormalization(JsonElement element)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in element.EnumerateObject())
        {
            if (property.Name.Contains(':', StringComparison.Ordinal) ||
                !names.Add(property.Name) ||
                NeedsNormalization(property.Value))
            {
                return true;
            }
        }

        return false;
    }

    private static void OverlayJsonPath(JsonObject target, string[] pathSegments, JsonNode? value)
    {
        var current = target;
        for (var i = 0; i < pathSegments.Length - 1; i++)
        {
            var pathSegment = pathSegments[i];
            if (TryGetPropertyName(current, pathSegment, out var existingName) &&
                current[existingName!] is JsonObject existingObject)
            {
                if (!string.Equals(existingName, pathSegment, StringComparison.Ordinal))
                {
                    current.Remove(existingName!);
                    current[pathSegment] = existingObject;
                }

                current = existingObject;
            }
            else
            {
                if (existingName is not null)
                {
                    current.Remove(existingName!);
                }

                var child = new JsonObject();
                current[pathSegment] = child;
                current = child;
            }
        }

        var finalSegment = pathSegments[^1];
        if (TryGetPropertyName(current, finalSegment, out var finalName))
        {
            if (current[finalName!] is JsonObject existingObject && value is JsonObject sourceObject)
            {
                if (!string.Equals(finalName, finalSegment, StringComparison.Ordinal))
                {
                    current.Remove(finalName!);
                    current[finalSegment] = existingObject;
                }

                OverlayJsonObject(existingObject, sourceObject);
                return;
            }

            if (current[finalName!] is JsonObject)
            {
                return;
            }

            current.Remove(finalName!);
        }

        current[finalSegment] = value?.DeepClone();
    }

    private static void OverlayJsonObject(JsonObject target, JsonObject source)
    {
        foreach (var (propertyName, value) in source)
        {
            OverlayJsonPath(target, propertyName.Split(':'), value);
        }
    }

    private static void OverlayJsonPathPreservingExisting(JsonObject target, string[] pathSegments, JsonNode? value)
    {
        var current = target;
        for (var i = 0; i < pathSegments.Length - 1; i++)
        {
            var pathSegment = pathSegments[i];
            if (TryGetPropertyName(current, pathSegment, out var existingName))
            {
                if (current[existingName!] is not JsonObject existingObject)
                {
                    return;
                }

                current = existingObject;
            }
            else
            {
                var child = new JsonObject();
                current[pathSegment] = child;
                current = child;
            }
        }

        var finalSegment = pathSegments[^1];
        if (TryGetPropertyName(current, finalSegment, out var finalName))
        {
            if (current[finalName!] is JsonObject existingObject && value is JsonObject sourceObject)
            {
                OverlayJsonObjectPreservingExisting(existingObject, sourceObject);
            }

            return;
        }

        current[finalSegment] = value?.DeepClone();
    }

    private static void OverlayJsonObjectPreservingExisting(JsonObject target, JsonObject source)
    {
        foreach (var (propertyName, value) in source)
        {
            OverlayJsonPathPreservingExisting(target, propertyName.Split(':'), value);
        }
    }

    private static bool TryGetPropertyName(JsonObject jsonObject, string propertyName, out string? existingName)
    {
        foreach (var property in jsonObject)
        {
            if (string.Equals(property.Key, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                existingName = property.Key;
                return true;
            }
        }

        existingName = null;
        return false;
    }
}
