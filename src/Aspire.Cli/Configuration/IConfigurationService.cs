// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Cli.Configuration;

internal interface IConfigurationService
{
    Task SetConfigurationAsync(string key, string value, bool isGlobal = false, CancellationToken cancellationToken = default);
    Task<bool> DeleteConfigurationAsync(string key, bool isGlobal = false, CancellationToken cancellationToken = default);
    Task<Dictionary<string, string>> GetAllConfigurationAsync(CancellationToken cancellationToken = default);
    Task<Dictionary<string, string>> GetLocalConfigurationAsync(CancellationToken cancellationToken = default);
    Task<Dictionary<string, string>> GetGlobalConfigurationAsync(CancellationToken cancellationToken = default);
    Task<string?> GetConfigurationAsync(string key, CancellationToken cancellationToken = default);

    /// <summary>
    /// Reads a configuration value scoped to a specific directory rather than the
    /// process-wide working directory. The lookup walks upward from
    /// <paramref name="startDirectory"/> for the nearest <c>aspire.config.json</c>
    /// (or legacy <c>.aspire/settings.json</c>). The two switches act on different stages
    /// and do not interact: <paramref name="continueSearchWhenKeyMissing"/> decides whether the
    /// upward walk stops at the nearest config file that omits the key or keeps climbing, and
    /// <paramref name="includeGlobalSettings"/> decides whether the global settings file is
    /// consulted once the walk finds nothing. Requesting the longer walk therefore still falls
    /// back to global settings. The process-wide
    /// <see cref="Microsoft.Extensions.Configuration.IConfiguration"/> (which is rooted at
    /// the working directory the CLI was launched from) is intentionally NOT consulted,
    /// so commands like <c>aspire update --apphost &lt;path&gt;</c> can resolve config
    /// from the project's directory tree instead of the caller's cwd.
    /// </summary>
    /// <remarks>
    /// Throws <see cref="System.InvalidOperationException"/> if any settings file encountered
    /// during the walk cannot be parsed as JSON, matching the behavior of startup-time settings load.
    /// </remarks>
    Task<string?> GetConfigurationFromDirectoryAsync(string key, DirectoryInfo startDirectory, bool continueSearchWhenKeyMissing = false, CancellationToken cancellationToken = default, bool includeGlobalSettings = true);
    string GetSettingsFilePath(bool isGlobal);
}
