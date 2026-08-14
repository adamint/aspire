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

    private enum NormalizationScope
    {
        Root,
        AppHost,
        Sdk,
        Docs,
        DocsApi,
        Profiles,
        Profile,
        Literal
    }

    private static JsonObject NormalizeSettingsObject(JsonElement element)
    {
        return NormalizeObject(element, NormalizationScope.Root);
    }

    private static JsonObject NormalizeObject(JsonElement element, NormalizationScope scope)
    {
        if (scope is NormalizationScope.Literal)
        {
            var literal = new JsonObject();
            foreach (var property in element.EnumerateObject())
            {
                if (TryGetPropertyName(literal, property.Name, out var existingName))
                {
                    literal.Remove(existingName!);
                }

                literal[property.Name] = NormalizeJsonElement(property.Value, NormalizationScope.Literal);
            }

            return literal;
        }

        var direct = new JsonObject();
        var flattened = new JsonObject();

        foreach (var property in element.EnumerateObject())
        {
            var path = GetNormalizedPath(property.Name, scope);
            var normalizedValue = NormalizeJsonElement(property.Value, GetChildScope(path));

            if (path.Length == 1)
            {
                OverlayJsonPath(direct, path, normalizedValue);
            }
            else
            {
                OverlayJsonPath(flattened, path, normalizedValue);
            }
        }

        // Explicit nested objects win over their flattened aliases, while flattened
        // representations still contribute disjoint children.
        OverlayJsonObjectPreservingExisting(direct, flattened);
        return direct;
    }

    private static JsonNode? NormalizeJsonElement(JsonElement element, NormalizationScope scope)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => NormalizeObject(element, scope),
            JsonValueKind.Array => NormalizeJsonArray(element, scope),
            JsonValueKind.Null => null,
            _ => JsonNode.Parse(element.GetRawText())
        };
    }

    private static JsonArray NormalizeJsonArray(JsonElement element, NormalizationScope scope)
    {
        var normalized = new JsonArray();
        foreach (var item in element.EnumerateArray())
        {
            normalized.Add(NormalizeJsonElement(item, scope));
        }

        return normalized;
    }

    private static bool NeedsNormalization(JsonElement element)
    {
        return NeedsNormalization(element, NormalizationScope.Root);
    }

    private static bool NeedsNormalization(JsonElement element, NormalizationScope scope)
    {
        if (scope is NormalizationScope.Literal)
        {
            if (element.ValueKind is JsonValueKind.Array)
            {
                return element.EnumerateArray().Any(item => NeedsNormalization(item, scope));
            }

            if (element.ValueKind is not JsonValueKind.Object)
            {
                return false;
            }

            var literalNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var property in element.EnumerateObject())
            {
                if (!literalNames.Add(property.Name) ||
                    NeedsNormalization(property.Value, scope))
                {
                    return true;
                }
            }

            return false;
        }

        if (element.ValueKind is JsonValueKind.Array)
        {
            return element.EnumerateArray().Any(item => NeedsNormalization(item, scope));
        }

        if (element.ValueKind is not JsonValueKind.Object)
        {
            return false;
        }

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in element.EnumerateObject())
        {
            var path = GetNormalizedPath(property.Name, scope);
            if (!names.Add(string.Join('\0', path)) ||
                path.Length > 1 ||
                NeedsNormalization(property.Value, GetChildScope(path)))
            {
                return true;
            }
        }

        return false;
    }

    private static string[] GetNormalizedPath(string propertyName, NormalizationScope scope)
    {
        if (!propertyName.Contains(':', StringComparison.Ordinal))
        {
            return [propertyName];
        }

        var segments = propertyName.Split(':');
        return scope switch
        {
            NormalizationScope.Root => GetRootPath(segments, propertyName),
            NormalizationScope.AppHost => GetKnownPath(segments, propertyName, "path", "language"),
            NormalizationScope.Sdk => GetKnownPath(segments, propertyName, "version"),
            NormalizationScope.Docs => GetKnownPath(segments, propertyName, "llmsTxtUrl", "api", "sitemapUrl"),
            NormalizationScope.DocsApi => GetKnownPath(segments, propertyName, "sitemapUrl"),
            NormalizationScope.Profile => GetProfilePath(segments, propertyName),
            _ => [propertyName]
        };
    }

    private static string[] GetRootPath(string[] segments, string originalName)
    {
        if (segments.Length == 0)
        {
            return [originalName];
        }

        if (segments[0].Equals("features", StringComparison.OrdinalIgnoreCase) ||
            segments[0].Equals("packages", StringComparison.OrdinalIgnoreCase))
        {
            return [segments[0], string.Join(':', segments.Skip(1))];
        }

        if (segments[0].Equals("profiles", StringComparison.OrdinalIgnoreCase))
        {
            if (segments.Length >= 3 &&
                segments[2].Equals("environmentVariables", StringComparison.OrdinalIgnoreCase))
            {
                return segments.Length == 3
                    ? segments
                    : [segments[0], segments[1], segments[2], string.Join(':', segments.Skip(3))];
            }

            if (segments.Length is 2 or 3 &&
                (segments.Length == 2 ||
                 segments[2].Equals("applicationUrl", StringComparison.OrdinalIgnoreCase)))
            {
                return segments;
            }
        }

        if (segments[0].Equals("appHost", StringComparison.OrdinalIgnoreCase) ||
            segments[0].Equals("sdk", StringComparison.OrdinalIgnoreCase) ||
            segments[0].Equals("docs", StringComparison.OrdinalIgnoreCase))
        {
            return segments;
        }

        return [originalName];
    }

    private static string[] GetKnownPath(string[] segments, string originalName, params string[] knownNames)
    {
        if (segments.Length > 0 &&
            knownNames.Any(name => segments[0].Equals(name, StringComparison.OrdinalIgnoreCase)))
        {
            return segments;
        }

        return [originalName];
    }

    private static string[] GetProfilePath(string[] segments, string originalName)
    {
        if (segments.Length >= 2 &&
            segments[0].Equals("environmentVariables", StringComparison.OrdinalIgnoreCase))
        {
            return [segments[0], string.Join(':', segments.Skip(1))];
        }

        if (segments.Length == 1 &&
            segments[0].Equals("applicationUrl", StringComparison.OrdinalIgnoreCase))
        {
            return segments;
        }

        return [originalName];
    }

    private static NormalizationScope GetChildScope(string[] path)
    {
        if (path.Length == 0)
        {
            return NormalizationScope.Literal;
        }

        return path[0].ToLowerInvariant() switch
        {
            "apphost" when path.Length == 1 => NormalizationScope.AppHost,
            "sdk" when path.Length == 1 => NormalizationScope.Sdk,
            "docs" when path.Length == 1 => NormalizationScope.Docs,
            "docs" when path.Length == 2 && path[1].Equals("api", StringComparison.OrdinalIgnoreCase) => NormalizationScope.DocsApi,
            "profiles" when path.Length == 1 => NormalizationScope.Profiles,
            "profiles" when path.Length == 2 => NormalizationScope.Profile,
            "profiles" when path.Length >= 3 && path[2].Equals("environmentVariables", StringComparison.OrdinalIgnoreCase) => NormalizationScope.Literal,
            _ => NormalizationScope.Literal
        };
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

            current.Remove(finalName!);
        }

        current[finalSegment] = value?.DeepClone();
    }

    private static void OverlayJsonObject(JsonObject target, JsonObject source)
    {
        foreach (var (propertyName, value) in source)
        {
            // Source properties have already been split and normalized by the caller.
            // Treat the remaining name as one segment so literal keys such as
            // "Logging:LogLevel:Default" are not split a second time.
            OverlayJsonPath(target, [propertyName], value);
        }
    }

    private static void OverlayJsonObjectPreservingExisting(JsonObject target, JsonObject source)
    {
        foreach (var (propertyName, value) in source)
        {
            if (TryGetPropertyName(target, propertyName, out var existingName))
            {
                if (target[existingName!] is JsonObject existingObject && value is JsonObject sourceObject)
                {
                    OverlayJsonObjectPreservingExisting(existingObject, sourceObject);
                }

                continue;
            }

            target[propertyName] = value?.DeepClone();
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
