// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Resources;
using Aspire.Cli.Utils;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Aspire.Cli.Configuration;

internal sealed class ConfigurationService(IConfiguration configuration, CliExecutionContext executionContext, FileInfo globalSettingsFile, ILogger<ConfigurationService> logger) : IConfigurationService
{
    public async Task SetConfigurationAsync(string key, string value, bool isGlobal = false, CancellationToken cancellationToken = default)
    {
        var settingsFilePath = GetSettingsFilePath(isGlobal);
        if (!isGlobal && AppHostPathConfigurationPolicy.IsHierarchicalAppHostPathKey(key))
        {
            settingsFilePath = EnsureAspireConfigFileForAppHostPathSettings(settingsFilePath);
        }

        await SetConfigurationInFileAsync(settingsFilePath, key, value, cancellationToken);
    }

    internal static async Task SetConfigurationInFileAsync(string settingsFilePath, string key, string value, CancellationToken cancellationToken = default)
    {
        JsonObject settings;

        // Read existing settings or create new
        if (File.Exists(settingsFilePath))
        {
            var existingContent = await File.ReadAllTextAsync(settingsFilePath, cancellationToken);
            // Handle empty files or whitespace-only content
            settings = string.IsNullOrWhiteSpace(existingContent)
                ? new JsonObject()
                : ConfigurationHelper.ParseSettingsObject(existingContent) ?? new JsonObject();
        }
        else
        {
            settings = new JsonObject();
        }

        // Set the configuration value using dot notation support
        SetNestedValue(settings, key, value);

        await ConfigurationHelper.WriteSettingsFileAsync(settingsFilePath, settings, cancellationToken);
    }

    public async Task<bool> DeleteConfigurationAsync(string key, bool isGlobal = false, CancellationToken cancellationToken = default)
    {
        var settingsFilePath = GetSettingsFilePath(isGlobal);

        if (!File.Exists(settingsFilePath))
        {
            return false;
        }

        try
        {
            var existingContent = await File.ReadAllTextAsync(settingsFilePath, cancellationToken);

            // Handle empty files or whitespace-only content
            if (string.IsNullOrWhiteSpace(existingContent))
            {
                return false;
            }

            var settings = ConfigurationHelper.ParseSettingsObject(existingContent);

            if (settings is null)
            {
                return false;
            }

            // Delete using dot notation support and return whether deletion occurred
            var deleted = DeleteNestedValue(settings, key);

            if (deleted)
            {
                await ConfigurationHelper.WriteSettingsFileAsync(settingsFilePath, settings, cancellationToken);
            }

            return deleted;
        }
        catch
        {
            return false;
        }
    }

    public string GetSettingsFilePath(bool isGlobal)
    {
        if (isGlobal)
        {
            return globalSettingsFile.FullName;
        }
        else
        {
            return FindNearestSettingsFile();
        }
    }

    private string FindNearestSettingsFile()
    {
        var searchDirectory = executionContext.WorkingDirectory;

        // Walk up the directory tree to find existing settings file
        while (searchDirectory is not null)
        {
            // Prefer aspire.config.json (new format)
            var newSettingsPath = Path.Combine(searchDirectory.FullName, AspireConfigFile.FileName);
            if (File.Exists(newSettingsPath))
            {
                logger.LogInformation("Found settings file at {Path}", newSettingsPath);
                return newSettingsPath;
            }

            // TODO: Remove legacy .aspire/settings.json fallback once confident most users have migrated.
            // Tracked by https://github.com/microsoft/aspire/issues/15239
            // Fall back to .aspire/settings.json (legacy)
            var legacySettingsPath = ConfigurationHelper.BuildPathToSettingsJsonFile(searchDirectory.FullName);
            if (File.Exists(legacySettingsPath))
            {
                logger.LogInformation("Found legacy settings file at {Path}", legacySettingsPath);
                return legacySettingsPath;
            }

            searchDirectory = searchDirectory.Parent;
        }

        // If no existing settings file found, default to aspire.config.json in current directory
        var defaultPath = Path.Combine(executionContext.WorkingDirectory.FullName, AspireConfigFile.FileName);
        logger.LogDebug("No existing settings file found, defaulting to {Path}", defaultPath);
        return defaultPath;
    }

    private string EnsureAspireConfigFileForAppHostPathSettings(string settingsFilePath)
    {
        var settingsFile = new FileInfo(settingsFilePath);
        var legacySettingsRootDirectory = ConfigurationHelper.GetLegacySettingsRootDirectory(settingsFile);
        if (legacySettingsRootDirectory is null)
        {
            return settingsFilePath;
        }

        var aspireConfigPath = Path.Combine(legacySettingsRootDirectory.FullName, AspireConfigFile.FileName);
        if (!File.Exists(aspireConfigPath))
        {
            logger.LogInformation("Migrating legacy settings from {LegacyDir} to {ConfigFile}", legacySettingsRootDirectory.FullName, aspireConfigPath);
            _ = AspireConfigFile.LoadOrCreate(legacySettingsRootDirectory.FullName);
        }

        return aspireConfigPath;
    }

    public async Task<Dictionary<string, string>> GetAllConfigurationAsync(CancellationToken cancellationToken = default)
    {
        var allConfig = new Dictionary<string, string>();

        var nearestSettingFilePath = FindNearestSettingsFile();
        await LoadConfigurationFromFileAsync(nearestSettingFilePath, allConfig, cancellationToken);
        await LoadConfigurationFromFileAsync(globalSettingsFile.FullName, allConfig, cancellationToken);

        return allConfig;
    }

    public async Task<Dictionary<string, string>> GetLocalConfigurationAsync(CancellationToken cancellationToken = default)
    {
        var localConfig = new Dictionary<string, string>();
        var nearestSettingFilePath = FindNearestSettingsFile();
        await LoadConfigurationFromFileAsync(nearestSettingFilePath, localConfig, cancellationToken);
        return localConfig;
    }

    public async Task<Dictionary<string, string>> GetGlobalConfigurationAsync(CancellationToken cancellationToken = default)
    {
        var globalConfig = new Dictionary<string, string>();
        await LoadConfigurationFromFileAsync(globalSettingsFile.FullName, globalConfig, cancellationToken);
        return globalConfig;
    }

    private static async Task LoadConfigurationFromFileAsync(string filePath, Dictionary<string, string> config, CancellationToken cancellationToken)
    {
        try
        {
            var content = await File.ReadAllTextAsync(filePath, cancellationToken);

            // Handle empty files or whitespace-only content
            if (string.IsNullOrWhiteSpace(content))
            {
                return;
            }

            var settings = ConfigurationHelper.ParseSettingsObject(content);

            if (settings is not null)
            {
                FlattenJsonObject(settings, config, string.Empty);
            }
        }
        catch
        {
            // Ignore errors reading configuration files
        }
    }

    /// <summary>
    /// Sets a nested value in a JsonObject using dot notation.
    /// Creates intermediate objects as needed and replaces primitives with objects when necessary.
    /// Property matching is case-insensitive to match Microsoft.Extensions.Configuration semantics.
    /// Also removes any conflicting flattened keys (colon-separated format) to prevent duplicate key errors.
    /// </summary>
    private static void SetNestedValue(JsonObject settings, string key, string value)
    {
        // Normalize colon-separated keys to dot notation since both represent
        // the same configuration hierarchy (e.g., "features:polyglotSupportEnabled"
        // is equivalent to "features.polyglotSupportEnabled")
        key = key.Replace(':', '.');

        var keyParts = key.Split('.');

        var currentObject = settings;

        // Navigate to the parent object, creating objects as needed
        for (int i = 0; i < keyParts.Length - 1; i++)
        {
            // A flattened key can occur at any level:
            //   { "appHost": { "path:language": "..." } }
            // Remove conflicts relative to the current object before descending.
            RemoveConflictingFlattenedKeys(currentObject, keyParts, i);

            var part = keyParts[i];
            currentObject = GetOrCreateNestedObject(currentObject, part);
        }

        // Microsoft.Extensions.Configuration treats JSON keys case-insensitively. Remove every
        // logical match before writing the canonical requested casing so invalid duplicates such
        // as "NuGetSource" plus "nugetSource" are repaired instead of preserved.
        var finalKey = keyParts[keyParts.Length - 1];
        RemovePropertiesCaseInsensitive(currentObject, finalKey);
        currentObject[finalKey] = value;
    }

    /// <summary>
    /// Removes any flattened keys (colon-separated) that would conflict with a nested structure.
    /// For example, when setting "features.showAllTemplates", remove "features:showAllTemplates".
    /// </summary>
    private static void RemoveConflictingFlattenedKeys(JsonObject settings, string[] keyParts, int startIndex)
    {
        for (var length = keyParts.Length - startIndex; length > 1; length--)
        {
            var flattenedKey = string.Join(":", keyParts, startIndex, length);
            var matchingPropertyNames = GetPropertyNamesCaseInsensitive(settings, flattenedKey);

            foreach (var propertyName in matchingPropertyNames)
            {
                // Preserve the existing behavior for partial flattened objects because their
                // child values do not conflict with the value being written. A full flattened
                // match conflicts regardless of its node type.
                if (length == keyParts.Length - startIndex || settings[propertyName] is not JsonObject)
                {
                    settings.Remove(propertyName);
                }
            }
        }
    }

    private static JsonObject GetOrCreateNestedObject(JsonObject settings, string propertyName)
    {
        var matchingPropertyNames = GetPropertyNamesCaseInsensitive(settings, propertyName);
        var objectPropertyName = matchingPropertyNames.FirstOrDefault(
            name => string.Equals(name, propertyName, StringComparison.Ordinal) && settings[name] is JsonObject)
            ?? matchingPropertyNames.FirstOrDefault(name => settings[name] is JsonObject);

        if (objectPropertyName is not null)
        {
            var targetObject = settings[objectPropertyName]!.AsObject();
            foreach (var matchingPropertyName in matchingPropertyNames)
            {
                if (string.Equals(matchingPropertyName, objectPropertyName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (settings[matchingPropertyName] is JsonObject siblingObject)
                {
                    MergeDisjointProperties(targetObject, siblingObject);
                }
            }

            RemovePropertiesCaseInsensitive(settings, propertyName, objectPropertyName);

            return targetObject;
        }

        RemovePropertiesCaseInsensitive(settings, propertyName);
        var nestedObject = new JsonObject();
        settings[propertyName] = nestedObject;

        return nestedObject;
    }

    private static void MergeDisjointProperties(JsonObject target, JsonObject source)
    {
        foreach (var (propertyName, value) in source)
        {
            var targetPropertyName = GetPropertyNamesCaseInsensitive(target, propertyName).FirstOrDefault();
            if (targetPropertyName is null)
            {
                target[propertyName] = value?.DeepClone();
            }
            else if (target[targetPropertyName] is JsonObject targetObject && value is JsonObject sourceObject)
            {
                // Invalid case variants can each contain valid nested settings. Merge object
                // children recursively, while the selected target wins leaf and type conflicts.
                MergeDisjointProperties(targetObject, sourceObject);
            }
        }
    }

    private static string[] GetPropertyNamesCaseInsensitive(JsonObject settings, string propertyName)
    {
        return
        [
            .. settings
                .Select(property => property.Key)
                .Where(name => string.Equals(name, propertyName, StringComparison.OrdinalIgnoreCase))
        ];
    }

    private static void RemovePropertiesCaseInsensitive(JsonObject settings, string propertyName, string? propertyNameToPreserve = null)
    {
        foreach (var matchingPropertyName in GetPropertyNamesCaseInsensitive(settings, propertyName))
        {
            if (!string.Equals(matchingPropertyName, propertyNameToPreserve, StringComparison.Ordinal))
            {
                settings.Remove(matchingPropertyName);
            }
        }
    }

    /// <summary>
    /// Deletes a nested value from a JsonObject using dot notation.
    /// Cleans up empty parent objects after deletion.
    /// </summary>
    private static bool DeleteNestedValue(JsonObject settings, string key)
    {
        // Normalize colon-separated keys to dot notation
        key = key.Replace(':', '.');

        var keyParts = key.Split('.');

        // Remove any flat colon-separated key at root level (legacy format)
        var flattenedKey = string.Join(":", keyParts);
        var removedFlat = settings.Remove(flattenedKey);

        var currentObject = settings;
        var objectPath = new List<(JsonObject obj, string key)>();

        // Navigate to the target value, keeping track of the path
        for (int i = 0; i < keyParts.Length - 1; i++)
        {
            var part = keyParts[i];
            objectPath.Add((currentObject, part));

            if (!currentObject.ContainsKey(part) || currentObject[part] is not JsonObject)
            {
                return removedFlat; // Path doesn't exist, but may have removed flat key
            }

            currentObject = currentObject[part]!.AsObject();
        }

        var finalKey = keyParts[keyParts.Length - 1];

        // Check if the final key exists
        if (!currentObject.ContainsKey(finalKey))
        {
            return removedFlat;
        }

        // Remove the final key
        currentObject.Remove(finalKey);

        // Clean up empty parent objects, working backwards
        for (int i = objectPath.Count - 1; i >= 0; i--)
        {
            var (parentObject, parentKey) = objectPath[i];

            // If the current object is empty, remove it from its parent
            if (currentObject.Count == 0)
            {
                parentObject.Remove(parentKey);
                currentObject = parentObject;
            }
            else
            {
                break; // Stop cleanup if we encounter a non-empty object
            }
        }

        return true;
    }

    /// <summary>
    /// Recursively flattens a JsonObject into a dictionary with dot notation keys.
    /// </summary>
    private static void FlattenJsonObject(JsonObject obj, Dictionary<string, string> result, string prefix)
    {
        foreach (var kvp in obj)
        {
            // Normalize colon-separated keys to dot notation for consistent display
            var normalizedKey = kvp.Key.Replace(':', '.');
            var key = string.IsNullOrEmpty(prefix) ? normalizedKey : $"{prefix}.{normalizedKey}";

            if (kvp.Value is JsonObject nestedObj)
            {
                FlattenJsonObject(nestedObj, result, key);
            }
            else if (kvp.Value is not null)
            {
                result[key] = kvp.Value.ToString();
            }
        }
    }

    public Task<string?> GetConfigurationAsync(string key, CancellationToken cancellationToken = default)
    {
        // Convert dot notation to colon notation for IConfiguration access
        var configKey = key.Replace('.', ':');
        return Task.FromResult(configuration[configKey]);
    }

    public async Task<string?> GetConfigurationFromDirectoryAsync(string key, DirectoryInfo startDirectory, bool continueSearchWhenKeyMissing = false, CancellationToken cancellationToken = default)
    {
        var result = await GetConfigurationFromDirectoryWithOriginAsync(key, startDirectory, continueSearchWhenKeyMissing, cancellationToken).ConfigureAwait(false);

        return result?.Value;
    }

    public Task<ConfigurationValueWithOrigin?> GetConfigurationFromDirectoryWithOriginAsync(string key, DirectoryInfo startDirectory, bool continueSearchWhenKeyMissing = false, CancellationToken cancellationToken = default)
    {
        return GetConfigurationFromDirectoryWithOriginCoreAsync(key, startDirectory, continueSearchWhenKeyMissing, includeGlobalSettings: true);
    }

    public Task<ConfigurationValueWithOrigin?> GetLocalConfigurationFromDirectoryWithOriginAsync(string key, DirectoryInfo startDirectory, bool continueSearchWhenKeyMissing = false, CancellationToken cancellationToken = default)
    {
        return GetConfigurationFromDirectoryWithOriginCoreAsync(key, startDirectory, continueSearchWhenKeyMissing, includeGlobalSettings: false);
    }

    private Task<ConfigurationValueWithOrigin?> GetConfigurationFromDirectoryWithOriginCoreAsync(string key, DirectoryInfo startDirectory, bool continueSearchWhenKeyMissing, bool includeGlobalSettings)
    {
        ArgumentNullException.ThrowIfNull(startDirectory);

        var configKey = key.Replace('.', ':');

        // 1. Project-relative local settings: walk up from startDirectory to find the nearest
        //    config file. Most command lookups stop at that file, even when it omits the key,
        //    so a parent directory's unrelated app config doesn't override global settings.
        //    Targeted inheritance paths can explicitly continue past a key-missing file.
        //    Intentionally bypasses the process-wide IConfiguration (which is rooted at the
        //    CLI's launch cwd via ConfigurationHelper.RegisterSettingsFiles) so that commands
        //    that operate on a path other than cwd (e.g. `aspire update --apphost <elsewhere>`)
        //    consult the project's own aspire.config.json instead of the caller's cwd.
        for (var searchDirectory = startDirectory; searchDirectory is not null; searchDirectory = searchDirectory.Parent)
        {
            var configFilePath = Path.Combine(searchDirectory.FullName, AspireConfigFile.FileName);
            var configFile = new FileInfo(configFilePath);
            if (TryReadConfigurationValueWithOrigin(configFilePath, configKey, GetBaseDirectoryForSettingsFile(configFile), out var configFileValue))
            {
                return Task.FromResult<ConfigurationValueWithOrigin?>(configFileValue);
            }
            else if (File.Exists(configFilePath) && !continueSearchWhenKeyMissing)
            {
                break;
            }

            var legacySettingsPath = ConfigurationHelper.BuildPathToSettingsJsonFile(searchDirectory.FullName);
            var legacySettingsFile = new FileInfo(legacySettingsPath);
            if (TryReadConfigurationValueWithOrigin(legacySettingsPath, configKey, GetBaseDirectoryForSettingsFile(legacySettingsFile), out var legacySettingsValue))
            {
                return Task.FromResult<ConfigurationValueWithOrigin?>(legacySettingsValue);
            }
            else if (File.Exists(legacySettingsPath) && !continueSearchWhenKeyMissing)
            {
                break;
            }
        }

        if (!includeGlobalSettings)
        {
            return Task.FromResult<ConfigurationValueWithOrigin?>(null);
        }

        // 2. Global settings file fallback (lower precedence).
        //
        // Transitional path: identity-channel is now baked into the CLI binary (AspireCliChannel
        // assembly metadata) and the acquisition scripts no longer seed a "channel" field into
        // global settings. The read here remains so a user who deliberately ran
        // `aspire config set -g channel <x>` continues to get their preference honored by
        // `aspire update` until that workflow is removed in a follow-up. Most per-project flows still
        // avoid global fallback, but source selection intentionally allows local-then-global
        // `nugetSource` precedence so `aspire add` / integration discovery can honor the user's
        // configured feed when no explicit `--source` was supplied.
        if (File.Exists(globalSettingsFile.FullName))
        {
            var globalConfig = LoadSettingsFileForReading(globalSettingsFile.FullName);
            var globalValue = globalConfig[configKey];
            if (!string.IsNullOrWhiteSpace(globalValue))
            {
                return Task.FromResult<ConfigurationValueWithOrigin?>(
                    new ConfigurationValueWithOrigin(globalValue, GetBaseDirectoryForSettingsFile(globalSettingsFile), IsGlobal: true));
            }
        }

        return Task.FromResult<ConfigurationValueWithOrigin?>(null);
    }

    private DirectoryInfo GetBaseDirectoryForSettingsFile(FileInfo settingsFile)
    {
        return ConfigurationHelper.GetLegacySettingsRootDirectory(settingsFile)
            ?? settingsFile.Directory
            ?? executionContext.WorkingDirectory;
    }

    private static bool TryReadConfigurationValueWithOrigin(string settingsFilePath, string configKey, DirectoryInfo baseDirectory, [NotNullWhen(true)] out ConfigurationValueWithOrigin? value)
    {
        value = null;

        if (!File.Exists(settingsFilePath))
        {
            return false;
        }

        var config = LoadSettingsFileForReading(settingsFilePath);
        var candidateValue = config[configKey];
        if (string.IsNullOrWhiteSpace(candidateValue))
        {
            return false;
        }

        value = new ConfigurationValueWithOrigin(candidateValue, baseDirectory);
        return true;
    }

    /// <summary>
    /// Loads a single settings file into an isolated <see cref="IConfigurationRoot"/> for
    /// directory-scoped lookups, mirroring <c>ConfigurationHelper.AddSettingsFile</c>'s
    /// JSON-with-comments parsing and "throw on invalid JSON" behavior so directory-scoped
    /// reads fail loudly the same way startup-time loads do.
    /// </summary>
    private static IConfigurationRoot LoadSettingsFileForReading(string filePath)
    {
        string content;
        try
        {
            content = File.ReadAllText(filePath);
        }
        catch (IOException)
        {
            return new ConfigurationBuilder().Build();
        }
        catch (UnauthorizedAccessException)
        {
            return new ConfigurationBuilder().Build();
        }

        if (string.IsNullOrWhiteSpace(content))
        {
            return new ConfigurationBuilder().Build();
        }

        JsonObject? node;
        try
        {
            node = ConfigurationHelper.ParseSettingsObject(content);
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                string.Format(CultureInfo.CurrentCulture, ErrorStrings.InvalidJsonInConfigFile, filePath, ex.Message),
                ex);
        }

        if (node is null)
        {
            return new ConfigurationBuilder().Build();
        }

        var cleanJson = node.ToJsonString();
        var bytes = System.Text.Encoding.UTF8.GetBytes(cleanJson);
        return new ConfigurationBuilder()
            .AddJsonStream(new MemoryStream(bytes))
            .Build();
    }
}
