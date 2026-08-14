// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Configuration;
using Aspire.Cli.Tests.Utils;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Cli.Tests.Configuration;

public class ConfigurationServiceTests(ITestOutputHelper outputHelper)
{
    private static (ConfigurationService Service, string SettingsFilePath) CreateService(
        TemporaryWorkspace workspace,
        string? existingContent = null)
    {
        var globalSettingsDir = workspace.CreateDirectory(".aspire-global");
        var globalSettingsFile = new FileInfo(Path.Combine(globalSettingsDir.FullName, AspireConfigFile.FileName));

        var settingsFilePath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        if (existingContent is not null)
        {
            File.WriteAllText(settingsFilePath, existingContent);
        }

        var executionContext = workspace.CreateExecutionContext();

        var configBuilder = new ConfigurationBuilder();
        var configuration = configBuilder.Build();

        var logger = NullLogger<ConfigurationService>.Instance;
        var service = new ConfigurationService(configuration, executionContext, globalSettingsFile, logger);

        return (service, settingsFilePath);
    }

    private static string GetGlobalSettingsFilePath(TemporaryWorkspace workspace)
    {
        return Path.Combine(workspace.WorkspaceRoot.FullName, ".aspire-global", AspireConfigFile.FileName);
    }

    [Fact]
    public async Task SetConfigurationAsync_WorksWithJsonComments()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var contentWithComments = """
            {
              // This is a comment about the apphost
              "appHost": {
                "path": "MyApp.csproj" // path to the project
              }
            }
            """;

        var (service, settingsFilePath) = CreateService(workspace, contentWithComments);

        await service.SetConfigurationAsync("channel", "daily", isGlobal: false);

        var result = File.ReadAllText(settingsFilePath);
        Assert.Contains("daily", result);
        Assert.Contains("appHost", result);
    }

    [Fact]
    public async Task SetConfigurationAsync_WorksWithTrailingCommas()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var contentWithTrailingCommas = """
            {
              "appHost": {
                "path": "MyApp.csproj",
              },
              "channel": "stable",
            }
            """;

        var (service, settingsFilePath) = CreateService(workspace, contentWithTrailingCommas);

        await service.SetConfigurationAsync("features.polyglotSupportEnabled", "true", isGlobal: false);

        var result = File.ReadAllText(settingsFilePath);
        Assert.Contains("polyglotSupportEnabled", result);
    }

    [Fact]
    public async Task SetConfigurationAsync_WorksWithCommentsAndTrailingCommas()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var content = """
            {
              // Comment
              "appHost": {
                "path": "MyApp.csproj", // trailing comma
              },
            }
            """;

        var (service, settingsFilePath) = CreateService(workspace, content);

        await service.SetConfigurationAsync("channel", "daily", isGlobal: false);

        var result = File.ReadAllText(settingsFilePath);
        Assert.Contains("daily", result);
    }

    [Fact]
    public async Task SetConfigurationAsync_CreatesNewFile_WhenNoneExists()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        // The workspace has .aspire/settings.json (the legacy sentinel) but no
        // aspire.config.json. FindNearestSettingsFile will find the sentinel and
        // write to it.
        var legacySettingsPath = Path.Combine(workspace.WorkspaceRoot.FullName, ".aspire", "settings.json");
        var (service, _) = CreateService(workspace);

        await service.SetConfigurationAsync("channel", "staging", isGlobal: false);

        Assert.True(File.Exists(legacySettingsPath));
        var result = File.ReadAllText(legacySettingsPath);
        Assert.Contains("staging", result);
    }

    [Fact]
    public async Task SetConfigurationAsync_HandlesEmptyFile()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(workspace, "");

        await service.SetConfigurationAsync("channel", "daily", isGlobal: false);

        var result = File.ReadAllText(settingsFilePath);
        Assert.Contains("daily", result);
    }

    [Fact]
    public async Task DeleteConfigurationAsync_WorksWithJsonComments()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var contentWithComments = """
            {
              // Comment
              "channel": "daily",
              "appHost": { "path": "MyApp.csproj" }
            }
            """;

        var (service, settingsFilePath) = CreateService(workspace, contentWithComments);

        var deleted = await service.DeleteConfigurationAsync("channel", isGlobal: false);

        Assert.True(deleted);
        var result = File.ReadAllText(settingsFilePath);
        Assert.DoesNotContain("daily", result);
        Assert.Contains("appHost", result);
    }

    [Fact]
    public async Task DeleteConfigurationAsync_ReturnsFalse_WhenFileDoesNotExist()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, _) = CreateService(workspace);

        var deleted = await service.DeleteConfigurationAsync("channel", isGlobal: false);

        Assert.False(deleted);
    }

    [Fact]
    public async Task DeleteConfigurationAsync_ReturnsFalse_WhenFileIsEmpty()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, _) = CreateService(workspace, "");

        var deleted = await service.DeleteConfigurationAsync("channel", isGlobal: false);

        Assert.False(deleted);
    }

    [Fact]
    public async Task GetAllConfigurationAsync_ParsesCommentsCorrectly()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var contentWithComments = """
            {
              // This config has comments
              "channel": "daily",
              "features": {
                "polyglotSupportEnabled": true // enabled for testing
              }
            }
            """;

        var (service, _) = CreateService(workspace, contentWithComments);

        var config = await service.GetAllConfigurationAsync();

        Assert.Contains("channel", config.Keys);
        Assert.Equal("daily", config["channel"]);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryAsync_WithContinueSearchWhenKeyMissing_WalksUpWhenNearestConfigDoesNotContainKey()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, _) = CreateService(
            workspace,
            """
            {
              "sdk": {
                "version": "10.0.0-preview.5.26311.1"
              }
            }
            """);

        var srcDirectory = workspace.WorkspaceRoot.CreateSubdirectory("src");
        await File.WriteAllTextAsync(
            Path.Combine(srcDirectory.FullName, AspireConfigFile.FileName),
            """
            {
              "packages": {
                "Aspire.Hosting.Redis": ""
              }
            }
            """);

        var value = await service.GetConfigurationFromDirectoryAsync("sdk.version", srcDirectory, continueSearchWhenKeyMissing: true);

        Assert.Equal("10.0.0-preview.5.26311.1", value);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryAsync_WhenNearestConfigDoesNotContainKey_DoesNotReadParentConfig()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, _) = CreateService(
            workspace,
            """
            {
              "channel": "daily"
            }
            """);

        var srcDirectory = workspace.WorkspaceRoot.CreateSubdirectory("src");
        await File.WriteAllTextAsync(
            Path.Combine(srcDirectory.FullName, AspireConfigFile.FileName),
            """
            {
              "language": "csharp"
            }
            """);

        var value = await service.GetConfigurationFromDirectoryAsync("channel", srcDirectory);

        Assert.Null(value);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryAsync_FindsNearestParentConfigWhenStartDirectoryHasNoConfig()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, _) = CreateService(
            workspace,
            """
            {
              "channel": "daily"
            }
            """);

        var srcDirectory = workspace.WorkspaceRoot.CreateSubdirectory("src");

        var value = await service.GetConfigurationFromDirectoryAsync("channel", srcDirectory);

        Assert.Equal("daily", value);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryWithOriginAsync_FindsNearestParentModernConfigAndReturnsConfigDirectory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(
            workspace,
            """
            {
              "nugetSource": "feed"
            }
            """);

        var srcDirectory = workspace.WorkspaceRoot.CreateSubdirectory("src");
        var nestedDirectory = srcDirectory.CreateSubdirectory("nested");

        var result = await service.GetConfigurationFromDirectoryWithOriginAsync(AspireConfigFile.NuGetSourceKey, nestedDirectory);

        Assert.NotNull(result);
        Assert.Equal("feed", result.Value);
        Assert.Equal(new FileInfo(settingsFilePath).Directory!.FullName, result.BaseDirectory.FullName);
        Assert.False(result.IsGlobal);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryWithOriginAsync_FallsBackToGlobalConfigAndReturnsGlobalConfigDirectory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        Directory.CreateDirectory(Path.GetDirectoryName(GetGlobalSettingsFilePath(workspace))!);
        await File.WriteAllTextAsync(
            GetGlobalSettingsFilePath(workspace),
            """
            {
              "nugetSource": "global-feed"
            }
            """);

        var (service, _) = CreateService(workspace);
        var srcDirectory = workspace.WorkspaceRoot.CreateSubdirectory("src");

        var result = await service.GetConfigurationFromDirectoryWithOriginAsync(AspireConfigFile.NuGetSourceKey, srcDirectory);

        Assert.NotNull(result);
        Assert.Equal("global-feed", result.Value);
        Assert.Equal(workspace.WorkspaceRoot.FullName, result.BaseDirectory.Parent!.FullName);
        Assert.True(result.IsGlobal);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryWithOriginAsync_ContinuesToGlobalWhenNearestConfigOmitsKey()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        await File.WriteAllTextAsync(
            Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName),
            "{}");

        Directory.CreateDirectory(Path.GetDirectoryName(GetGlobalSettingsFilePath(workspace))!);
        await File.WriteAllTextAsync(
            GetGlobalSettingsFilePath(workspace),
            """
            {
              "nugetSource": "global-feed"
            }
            """);

        var (service, _) = CreateService(workspace);
        var result = await service.GetConfigurationFromDirectoryWithOriginAsync(
            AspireConfigFile.NuGetSourceKey,
            workspace.WorkspaceRoot);

        Assert.NotNull(result);
        Assert.Equal("global-feed", result.Value);
        Assert.True(result.IsGlobal);
    }

    [Fact]
    public async Task GetConfigurationFromDirectoryWithOriginAsync_LegacyConfigReturnsWorkspaceRoot()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        await File.WriteAllTextAsync(
            Path.Combine(workspace.WorkspaceRoot.FullName, ".aspire", "settings.json"),
            """
            {
              "nugetSource": "legacy-feed"
            }
            """);

        var (service, _) = CreateService(workspace);
        var srcDirectory = workspace.WorkspaceRoot.CreateSubdirectory("src");

        var result = await service.GetConfigurationFromDirectoryWithOriginAsync(AspireConfigFile.NuGetSourceKey, srcDirectory);

        Assert.NotNull(result);
        Assert.Equal("legacy-feed", result.Value);
        Assert.Equal(workspace.WorkspaceRoot.FullName, result.BaseDirectory.FullName);
    }

    [Fact]
    public async Task SetConfigurationAsync_SetsNestedValues()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(workspace, "{}");

        await service.SetConfigurationAsync("appHost.path", "MyApp/MyApp.csproj", isGlobal: false);

        var result = File.ReadAllText(settingsFilePath);
        Assert.Contains("appHost", result);
        Assert.Contains("MyApp/MyApp.csproj", result);
    }

    [Fact]
    public async Task SetConfigurationAsync_ReplacesCaseInsensitivePropertyWithoutDuplicateConfigurationKeys()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(
            workspace,
            """
            {
              "NuGetSource": "https://old.example/v3/index.json"
            }
            """);

        const string configuredSource = "https://configured.example/v3/index.json";
        await service.SetConfigurationAsync(AspireConfigFile.NuGetSourceKey, configuredSource, isGlobal: false);

        var json = JsonNode.Parse(File.ReadAllText(settingsFilePath))!.AsObject();
        var matchingProperties = json
            .Where(property => string.Equals(property.Key, AspireConfigFile.NuGetSourceKey, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        var property = Assert.Single(matchingProperties);
        Assert.Equal(AspireConfigFile.NuGetSourceKey, property.Key);
        Assert.Equal(configuredSource, property.Value!.GetValue<string>());

        var configuration = new ConfigurationBuilder()
            .AddJsonFile(settingsFilePath)
            .Build();
        Assert.Equal(configuredSource, configuration[AspireConfigFile.NuGetSourceKey]);
    }

    [Fact]
    public async Task SetConfigurationAsync_ReusesCaseInsensitiveObjectAndRemovesFlattenedConflicts()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(
            workspace,
            """
            {
              "APPHOST": {
                "PATH": "old-apphost.mts",
                "language": "typescript/nodejs"
              },
              "APPHOST:PATH": "flattened-apphost.mts"
            }
            """);
        await service.SetConfigurationAsync("appHost.path", "apphost.mts", isGlobal: false);
        var json = JsonNode.Parse(File.ReadAllText(settingsFilePath))!.AsObject();
        Assert.Equal(["APPHOST"], json.Select(property => property.Key));
        var appHostProperty = Assert.Single(
            json,
            property => string.Equals(property.Key, "appHost", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("APPHOST", appHostProperty.Key);

        var appHost = Assert.IsType<JsonObject>(appHostProperty.Value);
        var pathProperty = Assert.Single(
            appHost,
            property => string.Equals(property.Key, "path", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("path", pathProperty.Key);
        Assert.Equal("apphost.mts", pathProperty.Value!.GetValue<string>());
        Assert.Equal("typescript/nodejs", appHost["language"]!.GetValue<string>());

        var configuration = new ConfigurationBuilder()
            .AddJsonFile(settingsFilePath)
            .Build();
        Assert.Equal("apphost.mts", configuration["appHost:path"]);
        Assert.Equal("typescript/nodejs", configuration["appHost:language"]);
    }

    [Fact]
    public async Task SetConfigurationAsync_MergesDisjointCaseVariantObjectsIntoExactTarget()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(
            workspace,
            """
            {
              "APPHOST": {
                "language": "typescript/nodejs",
                "runtime": "bun",
                "Metadata": {
                  "owner": "sibling",
                  "version": 2,
                  "Details": {
                    "sourceOnly": "source",
                    "Conflict": "sibling"
                  }
                },
                "future": {
                  "enabled": true
                }
              },
              "appHost": {
                "PATH": "target-apphost.mts",
                "Runtime": "node",
                "metadata": {
                  "owner": "target",
                  "details": {
                    "targetOnly": "target",
                    "conflict": "target"
                  }
                }
              },
              "AppHost": "invalid"
            }
            """);

        await service.SetConfigurationAsync("appHost.path", "updated-apphost.mts", isGlobal: false);

        var json = JsonNode.Parse(File.ReadAllText(settingsFilePath))!.AsObject();
        var appHostProperty = Assert.Single(
            json,
            property => string.Equals(property.Key, "appHost", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("appHost", appHostProperty.Key);

        var appHost = Assert.IsType<JsonObject>(appHostProperty.Value);
        Assert.Equal(5, appHost.Count);
        Assert.Equal(
            appHost.Count,
            appHost.Select(property => property.Key).Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.Equal("updated-apphost.mts", appHost["path"]!.GetValue<string>());
        Assert.Equal("node", appHost["Runtime"]!.GetValue<string>());
        Assert.Equal("typescript/nodejs", appHost["language"]!.GetValue<string>());
        Assert.True(appHost["future"]!["enabled"]!.GetValue<bool>());

        var metadata = Assert.IsType<JsonObject>(appHost["metadata"]);
        Assert.Equal(3, metadata.Count);
        Assert.Equal(
            metadata.Count,
            metadata.Select(property => property.Key).Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.Equal("target", metadata["owner"]!.GetValue<string>());
        Assert.Equal(2, metadata["version"]!.GetValue<int>());

        var details = Assert.IsType<JsonObject>(metadata["details"]);
        Assert.Equal(3, details.Count);
        Assert.Equal(
            details.Count,
            details.Select(property => property.Key).Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.Equal("target", details["targetOnly"]!.GetValue<string>());
        Assert.Equal("source", details["sourceOnly"]!.GetValue<string>());
        Assert.Equal("target", details["conflict"]!.GetValue<string>());

        var configuration = new ConfigurationBuilder()
            .AddJsonFile(settingsFilePath)
            .Build();
        Assert.Equal("updated-apphost.mts", configuration["appHost:path"]);
        Assert.Equal("node", configuration["appHost:runtime"]);
        Assert.Equal("target", configuration["appHost:metadata:owner"]);
        Assert.Equal("2", configuration["appHost:metadata:version"]);
        Assert.Equal("target", configuration["appHost:metadata:details:targetOnly"]);
        Assert.Equal("source", configuration["appHost:metadata:details:sourceOnly"]);
        Assert.Equal("target", configuration["appHost:metadata:details:conflict"]);
        Assert.Equal("typescript/nodejs", configuration["appHost:language"]);
    }

    [Fact]
    public async Task SetConfigurationAsync_WritesBooleanStringAsJsonString()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(workspace, "{}");

        await service.SetConfigurationAsync("features.polyglotSupportEnabled", "true", isGlobal: false);

        // Value is written as a JSON string "true", not a JSON boolean true.
        // The FlexibleBooleanConverter handles parsing "true" -> bool on read.
        var json = JsonNode.Parse(File.ReadAllText(settingsFilePath));
        var node = json!["features"]!["polyglotSupportEnabled"];
        Assert.Equal(JsonValueKind.String, node!.GetValueKind());
        Assert.Equal("true", node.GetValue<string>());

        // Verify round-trip through AspireConfigFile.Load still works
        var config = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);
        Assert.NotNull(config?.Features);
        Assert.True(config.Features["polyglotSupportEnabled"]);
    }

    [Fact]
    public async Task SetConfigurationAsync_ChannelWithBooleanLikeValue_StaysAsString()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(workspace, "{}");

        // "true" is a valid channel value and must remain a string in JSON
        // to avoid corrupting the string-typed Channel property.
        await service.SetConfigurationAsync("channel", "true", isGlobal: false);

        // Must be a JSON string "true", not a JSON boolean true
        var json = JsonNode.Parse(File.ReadAllText(settingsFilePath));
        var node = json!["channel"];
        Assert.Equal(JsonValueKind.String, node!.GetValueKind());
        Assert.Equal("true", node.GetValue<string>());

        // Verify it round-trips correctly through AspireConfigFile.Load
        var config = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);
        Assert.NotNull(config);
        Assert.Equal("true", config.Channel);
    }

    [Fact]
    public async Task SetConfigurationAsync_WritesStringValueAsString()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var (service, settingsFilePath) = CreateService(workspace, "{}");

        await service.SetConfigurationAsync("channel", "daily", isGlobal: false);

        var json = JsonNode.Parse(File.ReadAllText(settingsFilePath));
        var node = json!["channel"];
        Assert.Equal(JsonValueKind.String, node!.GetValueKind());
        Assert.Equal("daily", node.GetValue<string>());
    }
}
