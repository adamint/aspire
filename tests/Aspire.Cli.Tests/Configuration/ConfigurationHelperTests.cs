// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Configuration;
using Aspire.Cli.Utils;
using Microsoft.Extensions.Configuration;

namespace Aspire.Cli.Tests.Configuration;

public class ConfigurationHelperTests(ITestOutputHelper outputHelper)
{
    private static IConfiguration BuildConfigurationFromSettingsFile(
        TemporaryWorkspace workspace, string content)
    {
        var settingsPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(settingsPath, content);

        var globalDir = workspace.CreateDirectory("global-aspire");
        var globalSettingsFile = new FileInfo(Path.Combine(globalDir.FullName, AspireConfigFile.FileName));

        var builder = new ConfigurationBuilder();
        ConfigurationHelper.RegisterSettingsFiles(builder, workspace.WorkspaceRoot, globalSettingsFile);
        return builder.Build();
    }

    [Fact]
    public void RegisterSettingsFiles_LoadsValidJson()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "appHost": { "path": "MyApp.csproj" },
              "channel": "daily"
            }
            """);

        Assert.Equal("MyApp.csproj", config["appHost:path"]);
        Assert.Equal("daily", config["channel"]);
    }

    [Fact]
    public void RegisterSettingsFiles_HandlesJsonComments()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              // This is a comment
              "appHost": {
                "path": "MyApp.csproj" // inline comment
              },
              "channel": "stable"
            }
            """);

        Assert.Equal("MyApp.csproj", config["appHost:path"]);
        Assert.Equal("stable", config["channel"]);
    }

    [Fact]
    public void RegisterSettingsFiles_HandlesTrailingCommas()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "appHost": { "path": "MyApp.csproj", },
              "channel": "stable",
            }
            """);

        Assert.Equal("MyApp.csproj", config["appHost:path"]);
    }

    [Fact]
    public void RegisterSettingsFiles_HandlesBlockComments()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              /* Block comment */
              "channel": "daily"
            }
            """);

        Assert.Equal("daily", config["channel"]);
    }

    [Fact]
    public void RegisterSettingsFiles_HandlesCommentsAndTrailingCommas()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              // Full-line comment
              "appHost": {
                "path": "MyApp.csproj", // trailing comma after value
              },
              /* Block comment */
              "channel": "daily", // trailing comma
            }
            """);

        Assert.Equal("MyApp.csproj", config["appHost:path"]);
        Assert.Equal("daily", config["channel"]);
    }

    [Fact]
    public void RegisterSettingsFiles_NormalizesCaseInsensitiveDuplicateKeysWithoutWriting()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "NuGetSource": "https://first.example/v3/index.json",
              "nugetsource": "https://second.example/v3/index.json"
            }
            """);

        Assert.Equal("https://second.example/v3/index.json", config["nugetSource"]);
        var settings = File.ReadAllText(Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName));
        Assert.Contains("\"NuGetSource\"", settings);
        Assert.Contains("\"nugetsource\"", settings);
    }

    [Fact]
    public void RegisterSettingsFiles_NormalizesExactDuplicateKeysWithoutWriting()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "channel": "stable",
              "channel": "daily"
            }
            """);

        Assert.Equal("daily", config["channel"]);
        var settings = File.ReadAllText(Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName));
        Assert.Equal(2, settings.Split("\"channel\"", StringSplitOptions.None).Length - 1);
    }

    [Fact]
    public void RegisterSettingsFiles_MergesFlattenedObjectPathsInMemory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "docs:api": {
                "sitemapUrl": "old",
                "other": "keep"
              },
              "docs": {
                "api": {
                  "sitemapUrl": "new"
                }
              }
            }
            """);

        Assert.Equal("new", config["docs:api:sitemapUrl"]);
        Assert.Equal("keep", config["docs:api:other"]);
        var settings = File.ReadAllText(Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName));
        Assert.Contains("\"docs:api\"", settings);
    }

    [Fact]
    public void RegisterSettingsFiles_UsesLastValueForDuplicateObjectAndScalarKeys()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "channel": { "name": "old" },
              "CHANNEL": "daily",
              "docs:api": { "sitemapUrl": "flat" },
              "docs": {
                "api": {
                  "sitemapUrl": "nested",
                  "other": "keep"
                }
              }
            }
            """);

        Assert.Equal("daily", config["channel"]);
        Assert.Equal("nested", config["docs:api:sitemapUrl"]);
        Assert.Equal("keep", config["docs:api:other"]);
    }

    [Fact]
    public void RegisterSettingsFiles_PreservesUnknownNestedColonKeys()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "extension": {
                "package:metadata": {
                  "asset:type": "value"
                }
              }
            }
            """);

        Assert.Equal("value", config["extension:package:metadata:asset:type"]);
        var loaded = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);
        Assert.NotNull(loaded?.ExtensionData);
        var extension = loaded.ExtensionData["extension"];
        Assert.Equal(JsonValueKind.Object, extension.ValueKind);
        Assert.True(extension.GetProperty("package:metadata").GetProperty("asset:type").ValueEquals("value"));
    }

    [Fact]
    public void RegisterSettingsFiles_PreservesCommentsAndLiteralColonKeysWithoutWriting()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var content = """
            {
              // Keep this comment in read-only commands.
              "profiles": {
                "https": {
                  "environmentVariables": {
                    "Logging:LogLevel:Default": "Information"
                  }
                }
              },
              "custom": {
                "literal:key": "value"
              }
            }
            """;
        var settingsPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(settingsPath, content);

        var config = BuildConfigurationFromSettingsFile(workspace, content);

        Assert.Equal(content, File.ReadAllText(settingsPath));
        Assert.Equal("Information", AspireConfigFile.Load(workspace.WorkspaceRoot.FullName)!.Profiles!["https"].EnvironmentVariables!["Logging:LogLevel:Default"]);
        Assert.Contains("\"literal:key\"", File.ReadAllText(settingsPath));
        Assert.Equal("Information", config["profiles:https:environmentVariables:Logging:LogLevel:Default"]);
    }

    [Fact]
    public void RegisterSettingsFiles_MergesProfileEnvironmentVariablesAsLiteralKeys()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = BuildConfigurationFromSettingsFile(workspace, """
            {
              "profiles": {
                "http": {
                  "environmentVariables": {
                    "Logging:LogLevel:Default": "nested",
                    "Keep:Nested": "keep"
                  }
                }
              },
              "profiles:http:environmentVariables": {
                "logging:loglevel:default": "flat"
              }
            }
            """);

        Assert.Equal("nested", config["profiles:http:environmentVariables:Logging:LogLevel:Default"]);
        Assert.Equal("keep", config["profiles:http:environmentVariables:Keep:Nested"]);
        Assert.Equal("nested", AspireConfigFile.Load(workspace.WorkspaceRoot.FullName)!.Profiles!["http"].EnvironmentVariables!["Logging:LogLevel:Default"]);
    }

    [Fact]
    public void TryNormalizeSettingsFile_RepairsLiteralColonDuplicateKeys()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var settingsPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(settingsPath, """
            {
              "profiles:http:environmentVariables": {
                "Logging:LogLevel:Default": "first",
                "logging:loglevel:default": "last"
              },
              "extension": {
                "package:metadata": {
                  "asset:type": "first",
                  "ASSET:TYPE": "last"
                }
              }
            }
            """);

        Assert.True(ConfigurationHelper.TryNormalizeSettingsFile(settingsPath));
        var config = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.Equal("last", config!.Profiles!["http"].EnvironmentVariables!["logging:loglevel:default"]);
        Assert.Equal("last", config.ExtensionData!["extension"].GetProperty("package:metadata").GetProperty("ASSET:TYPE").GetString());
        Assert.Equal("last", BuildConfigurationFromSettingsFile(workspace, File.ReadAllText(settingsPath))["profiles:http:environmentVariables:logging:loglevel:default"]);
    }

    [Fact]
    public void TryNormalizeSettingsFile_PreservesBooleanTypes()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var settingsPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        // File has a colon-separated key with a boolean value
        File.WriteAllText(settingsPath, """
            {
              "features:polyglotSupportEnabled": true,
              "features:showAllTemplates": false
            }
            """);

        var normalized = ConfigurationHelper.TryNormalizeSettingsFile(settingsPath);

        Assert.True(normalized);

        var json = JsonNode.Parse(File.ReadAllText(settingsPath));
        var polyglotNode = json!["features"]!["polyglotSupportEnabled"];
        var templatesNode = json!["features"]!["showAllTemplates"];
        Assert.Equal(JsonValueKind.True, polyglotNode!.GetValueKind());
        Assert.Equal(JsonValueKind.False, templatesNode!.GetValueKind());

        // Verify the file can be loaded by AspireConfigFile without error
        var config = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);
        Assert.NotNull(config?.Features);
        Assert.True(config.Features["polyglotSupportEnabled"]);
        Assert.False(config.Features["showAllTemplates"]);
    }

    [Fact]
    public void GetConfigRootDirectory_UsesNearestAspireConfigDirectory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configRoot = workspace.CreateDirectory("project");
        Directory.CreateDirectory(Path.Combine(configRoot.FullName, "nested", "apphost"));
        File.WriteAllText(Path.Combine(configRoot.FullName, AspireConfigFile.FileName), "{}");

        var resolvedRoot = ConfigurationHelper.GetConfigRootDirectory(
            new DirectoryInfo(Path.Combine(configRoot.FullName, "nested", "apphost")));

        Assert.Equal(configRoot.FullName, resolvedRoot.FullName);
    }

    [Fact]
    public void GetWorkspaceAspireDirectory_UsesLegacySettingsParentDirectory()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var appHostDirectory = new DirectoryInfo(Path.Combine(workspace.WorkspaceRoot.FullName, "nested", "apphost"));
        appHostDirectory.Create();

        var aspireDirectory = ConfigurationHelper.GetWorkspaceAspireDirectory(appHostDirectory);

        Assert.Equal(
            Path.Combine(workspace.WorkspaceRoot.FullName, AspireJsonConfiguration.SettingsFolder),
            aspireDirectory.FullName);
    }

    [Fact]
    public void RegisterSettingsFiles_DoesNotMigrateLegacySettingsOnStartup()
    {
        // Read commands (aspire ls, ps, doctor, --version) must not silently write
        // aspire.config.json to disk when a workspace only has the legacy
        // .aspire/settings.json. Earlier versions migrated eagerly here
        // (https://github.com/microsoft/aspire/issues/15488), but that violated the
        // "read commands don't mutate the working tree" contract reported in
        // https://github.com/microsoft/aspire/issues/17615.
        //
        // Migration is now deferred to commands that already mutate the workspace
        // (aspire run/add/init/update/etc.). Startup must register the legacy file
        // directly so legacy settings remain readable from IConfiguration without
        // materializing aspire.config.json.
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var legacyDir = workspace.CreateDirectory(AspireJsonConfiguration.SettingsFolder);
        var legacySettingsPath = Path.Combine(legacyDir.FullName, AspireJsonConfiguration.FileName);
        File.WriteAllText(legacySettingsPath, """
            {
              "appHostPath": "MyApp.csproj",
              "channel": "stable"
            }
            """);

        var aspireConfigPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        Assert.False(File.Exists(aspireConfigPath), "Precondition: aspire.config.json should not yet exist.");

        var globalDir = workspace.CreateDirectory("global-aspire");
        var globalSettingsFile = new FileInfo(Path.Combine(globalDir.FullName, AspireConfigFile.FileName));

        var builder = new ConfigurationBuilder();
        ConfigurationHelper.RegisterSettingsFiles(builder, workspace.WorkspaceRoot, globalSettingsFile);

        Assert.False(
            File.Exists(aspireConfigPath),
            "Startup must not materialize aspire.config.json — that would be a silent write from a read command path.");

        // Legacy values must remain readable via their flat key. Consumers reading the
        // hierarchical key go through AppHostPathConfigurationPolicy.TryFindAppHostPathKey,
        // which falls back to the legacy "appHostPath" key.
        var config = builder.Build();
        Assert.Equal("MyApp.csproj", config["appHostPath"]);
        Assert.Equal("stable", config["channel"]);
    }

    [Fact]
    public void RegisterSettingsFiles_DoesNotOverwriteExistingAspireConfigJson()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        // Both files present: the workspace was already migrated but the legacy file was
        // retained (this is the documented transition state — see AspireConfigFile.LoadOrCreate
        // and https://github.com/microsoft/aspire/issues/15239). Startup must continue to
        // prefer the new file and must not touch either file from a read-command path.
        var aspireConfigPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        var existingContent = """
            {
              "appHost": { "path": "Current.csproj" },
              "channel": "daily"
            }
            """;
        File.WriteAllText(aspireConfigPath, existingContent);

        var legacyDir = workspace.CreateDirectory(AspireJsonConfiguration.SettingsFolder);
        var legacySettingsPath = Path.Combine(legacyDir.FullName, AspireJsonConfiguration.FileName);
        File.WriteAllText(legacySettingsPath, """
            { "appHostPath": "Stale.csproj", "channel": "stable" }
            """);

        var globalDir = workspace.CreateDirectory("global-aspire");
        var globalSettingsFile = new FileInfo(Path.Combine(globalDir.FullName, AspireConfigFile.FileName));

        var builder = new ConfigurationBuilder();
        ConfigurationHelper.RegisterSettingsFiles(builder, workspace.WorkspaceRoot, globalSettingsFile);

        Assert.Equal(existingContent, File.ReadAllText(aspireConfigPath));

        var config = builder.Build();
        Assert.Equal("Current.csproj", config["appHost:path"]);
        Assert.Equal("daily", config["channel"]);
    }

    [Fact]
    public void RegisterSettingsFiles_UnparseableLegacyFileDoesNotCreateAspireConfigJson()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var legacyDir = workspace.CreateDirectory(AspireJsonConfiguration.SettingsFolder);
        var legacySettingsPath = Path.Combine(legacyDir.FullName, AspireJsonConfiguration.FileName);
        File.WriteAllText(legacySettingsPath, "{ this is not valid json");

        var globalDir = workspace.CreateDirectory("global-aspire");
        var globalSettingsFile = new FileInfo(Path.Combine(globalDir.FullName, AspireConfigFile.FileName));

        var builder = new ConfigurationBuilder();
        // AddSettingsFile (JSON configuration provider) may throw on malformed JSON when the
        // configuration is built, but RegisterSettingsFiles itself must not produce a
        // partially-written aspire.config.json on the way through.
        var ex = Record.Exception(() =>
            ConfigurationHelper.RegisterSettingsFiles(builder, workspace.WorkspaceRoot, globalSettingsFile));

        var migratedPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        Assert.False(File.Exists(migratedPath), "Unparseable legacy file must not produce an aspire.config.json on disk.");
        Assert.True(ex is null or InvalidOperationException, $"Unexpected exception type: {ex?.GetType().FullName}");
    }
}
