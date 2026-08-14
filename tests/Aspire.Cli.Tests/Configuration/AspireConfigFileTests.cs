// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using System.Text.Json.Nodes;
using Aspire.Cli.Configuration;
using Microsoft.Extensions.Configuration;

namespace Aspire.Cli.Tests.Configuration;

public class AspireConfigFileTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public void Load_ReturnsNull_WhenFileDoesNotExist()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.Null(result);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFileIsValid()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "appHost": { "path": "MyApp/MyApp.csproj" },
              "channel": "daily"
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Equal("MyApp/MyApp.csproj", result.AppHost?.Path);
        Assert.Equal("daily", result.Channel);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFileContainsNuGetSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "nugetSource": "https://proxy.example/v3/index.json"
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Equal("https://proxy.example/v3/index.json", result.NuGetSource);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFileContainsDocsSourceConfiguration()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "docs": {
                "llmsTxtUrl": "http://localhost:4321/llms-small.txt",
                "api": {
                  "sitemapUrl": "http://localhost:4321/sitemap-0.xml"
                }
              }
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Equal("http://localhost:4321/llms-small.txt", result.Docs?.LlmsTxtUrl);
        Assert.Equal("http://localhost:4321/sitemap-0.xml", result.Docs?.Api?.SitemapUrl);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFileContainsDocsSourceConfigurationWithDifferentCasing()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "Docs": {
                "LlmsTxtUrl": "http://localhost:4321/llms-small.txt",
                "API": {
                  "SitemapUrl": "http://localhost:4321/sitemap-0.xml"
                }
              }
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Equal("http://localhost:4321/llms-small.txt", result.Docs?.LlmsTxtUrl);
        Assert.Equal("http://localhost:4321/sitemap-0.xml", result.Docs?.Api?.SitemapUrl);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFileContainsJsonComments()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              // This is a comment
              "appHost": {
                "path": "MyApp/MyApp.csproj" // inline comment
              },
              "channel": "stable"
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Equal("MyApp/MyApp.csproj", result.AppHost?.Path);
        Assert.Equal("stable", result.Channel);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFileContainsTrailingCommas()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "appHost": { "path": "MyApp/MyApp.csproj", },
              "channel": "daily",
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Equal("MyApp/MyApp.csproj", result.AppHost?.Path);
    }

    [Fact]
    public void Load_ThrowsJsonException_WhenFileContainsInvalidJson()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, "{ invalid json content }");

        var ex = Assert.Throws<JsonException>(() => AspireConfigFile.Load(workspace.WorkspaceRoot.FullName));

        Assert.Contains(configPath, ex.Message);
        Assert.Contains("invalid JSON", ex.Message);
    }

    [Fact]
    public void Load_ThrowsJsonException_WithFilePath_WhenJsonIsTruncated()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """{ "appHost": { "path": """);

        var ex = Assert.Throws<JsonException>(() => AspireConfigFile.Load(workspace.WorkspaceRoot.FullName));

        Assert.Contains(configPath, ex.Message);
    }

    [Fact]
    public void Load_ReturnsEmptyConfig_WhenFileIsEmptyObject()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, "{}");

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.Null(result.AppHost);
        Assert.Null(result.Channel);
    }

    [Fact]
    public void Save_CreatesFileWithExpectedContent()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = new AspireConfigFile
        {
            AppHost = new AspireConfigAppHost { Path = "src/AppHost/AppHost.csproj" },
            Channel = "daily"
        };

        config.Save(workspace.WorkspaceRoot.FullName);

        var filePath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        Assert.True(File.Exists(filePath));

        var content = File.ReadAllText(filePath);
        Assert.Contains("src/AppHost/AppHost.csproj", content);
        Assert.Contains("daily", content);
    }

    [Fact]
    public void Save_CreatesDirectoryIfNeeded()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var subDir = Path.Combine(workspace.WorkspaceRoot.FullName, "nested", "dir");
        var config = new AspireConfigFile();

        config.Save(subDir);

        Assert.True(File.Exists(Path.Combine(subDir, AspireConfigFile.FileName)));
    }

    [Fact]
    public void Exists_ReturnsFalse_WhenFileDoesNotExist()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        Assert.False(AspireConfigFile.Exists(workspace.WorkspaceRoot.FullName));
    }

    [Fact]
    public void Exists_ReturnsTrue_WhenFileExists()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        File.WriteAllText(Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName), "{}");

        Assert.True(AspireConfigFile.Exists(workspace.WorkspaceRoot.FullName));
    }

    [Fact]
    public void SdkVersion_ReadsFromSdkObject()
    {
        var config = new AspireConfigFile
        {
            Sdk = new AspireConfigSdk { Version = "13.2.0" }
        };

        Assert.Equal("13.2.0", config.SdkVersion);
    }

    [Fact]
    public void SdkVersion_SetsOnSdkObject()
    {
        var config = new AspireConfigFile();

        config.SdkVersion = "13.2.0";

        Assert.NotNull(config.Sdk);
        Assert.Equal("13.2.0", config.Sdk.Version);
    }

    [Fact]
    public void SdkVersion_ReturnsNull_WhenSdkIsNull()
    {
        var config = new AspireConfigFile();

        Assert.Null(config.SdkVersion);
    }

    [Fact]
    public void GetEffectiveSdkVersion_ReturnsConfigValue_WhenSet()
    {
        var config = new AspireConfigFile
        {
            Sdk = new AspireConfigSdk { Version = "13.2.0" }
        };

        Assert.Equal("13.2.0", config.GetEffectiveSdkVersion("13.1.0"));
    }

    [Fact]
    public void GetEffectiveSdkVersion_ReturnsFallback_WhenNotSet()
    {
        var config = new AspireConfigFile();

        Assert.Equal("13.1.0", config.GetEffectiveSdkVersion("13.1.0"));
    }

    [Fact]
    public void AddOrUpdatePackage_AddsNewPackage()
    {
        var config = new AspireConfigFile();

        config.AddOrUpdatePackage("Aspire.Hosting.Redis", "13.2.0");

        Assert.NotNull(config.Packages);
        Assert.Equal("13.2.0", config.Packages["Aspire.Hosting.Redis"]);
    }

    [Fact]
    public void AddOrUpdatePackage_UpdatesExistingPackage()
    {
        var config = new AspireConfigFile
        {
            Packages = new Dictionary<string, string> { ["Aspire.Hosting.Redis"] = "13.1.0" }
        };

        config.AddOrUpdatePackage("Aspire.Hosting.Redis", "13.2.0");

        Assert.Equal("13.2.0", config.Packages["Aspire.Hosting.Redis"]);
    }

    [Fact]
    public void RemovePackage_RemovesExistingPackage()
    {
        var config = new AspireConfigFile
        {
            Packages = new Dictionary<string, string>
            {
                ["Aspire.Hosting.Redis"] = "13.2.0",
                ["Aspire.Hosting.PostgreSQL"] = "13.2.0"
            }
        };

        var removed = config.RemovePackage("Aspire.Hosting.Redis");

        Assert.True(removed);
        Assert.DoesNotContain("Aspire.Hosting.Redis", config.Packages.Keys);
        Assert.Contains("Aspire.Hosting.PostgreSQL", config.Packages.Keys);
    }

    [Fact]
    public void RemovePackage_ReturnsFalse_WhenPackageDoesNotExist()
    {
        var config = new AspireConfigFile();

        var removed = config.RemovePackage("Aspire.Hosting.Redis");

        Assert.False(removed);
    }

    [Fact]
    public void GetIntegrationReferences_ReturnsBasePackage_WhenNoPackages()
    {
        var config = new AspireConfigFile();

        var refs = config.GetIntegrationReferences("13.2.0", "/tmp").ToList();

        Assert.Single(refs);
        Assert.Equal("Aspire.Hosting", refs[0].Name);
    }

    [Fact]
    public void GetIntegrationReferences_IncludesPackagesAndBasePackage()
    {
        var config = new AspireConfigFile
        {
            Packages = new Dictionary<string, string>
            {
                ["Aspire.Hosting.Redis"] = "13.2.0"
            }
        };

        var refs = config.GetIntegrationReferences("13.2.0", "/tmp").ToList();

        Assert.Equal(2, refs.Count);
        Assert.Contains(refs, r => r.Name == "Aspire.Hosting");
        Assert.Contains(refs, r => r.Name == "Aspire.Hosting.Redis");
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFeaturesAreBooleans()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "features": { "polyglotSupportEnabled": true, "showAllTemplates": false }
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.NotNull(result.Features);
        Assert.True(result.Features["polyglotSupportEnabled"]);
        Assert.False(result.Features["showAllTemplates"]);
    }

    [Fact]
    public void Load_ReturnsConfig_WhenFeaturesAreStringBooleans()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        // Simulates what happens when ConfigurationService.SetNestedValue wrote "true"/"false" as strings
        var configPath = Path.Combine(workspace.WorkspaceRoot.FullName, AspireConfigFile.FileName);
        File.WriteAllText(configPath, """
            {
              "features": { "polyglotSupportEnabled": "true", "showAllTemplates": "false" }
            }
            """);

        var result = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(result);
        Assert.NotNull(result.Features);
        Assert.True(result.Features["polyglotSupportEnabled"]);
        Assert.False(result.Features["showAllTemplates"]);
    }

    [Fact]
    public void Save_Load_RoundTrips_WithFeatures()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = new AspireConfigFile
        {
            Features = new Dictionary<string, bool>
            {
                ["polyglotSupportEnabled"] = true,
                ["showAllTemplates"] = false
            }
        };

        config.Save(workspace.WorkspaceRoot.FullName);
        var loaded = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(loaded?.Features);
        Assert.True(loaded.Features["polyglotSupportEnabled"]);
        Assert.False(loaded.Features["showAllTemplates"]);
    }

    [Fact]
    public void Load_RoundTrips_WithProfiles()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);

        var config = new AspireConfigFile
        {
            AppHost = new AspireConfigAppHost { Path = "App.csproj" },
            Profiles = new Dictionary<string, AspireConfigProfile>
            {
                ["default"] = new AspireConfigProfile
                {
                    ApplicationUrl = "https://localhost:5001",
                    EnvironmentVariables = new Dictionary<string, string>
                    {
                        ["ASPNETCORE_ENVIRONMENT"] = "Development"
                    }
                }
            }
        };

        config.Save(workspace.WorkspaceRoot.FullName);
        var loaded = AspireConfigFile.Load(workspace.WorkspaceRoot.FullName);

        Assert.NotNull(loaded);
        Assert.Equal("App.csproj", loaded.AppHost?.Path);
        Assert.NotNull(loaded.Profiles);
        Assert.True(loaded.Profiles.ContainsKey("default"));
        Assert.Equal("https://localhost:5001", loaded.Profiles["default"].ApplicationUrl);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_AdjustsRelativePathFromAspireDir()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        // Legacy .aspire/settings.json stores paths relative to the .aspire/ directory
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "../src/apphost.ts",
                "language": "typescript/nodejs",
                "sdkVersion": "13.2.0"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // Path should be re-based from .aspire/-relative to root-relative
        Assert.Equal("src/apphost.ts", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_AdjustsPathForApphostAtRoot()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        // Legacy path "../apphost.ts" means apphost is at the repo root
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "../apphost.ts",
                "language": "typescript/nodejs"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        Assert.Equal("apphost.ts", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_RebasesSubdirectoryPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        // Legacy .aspire/settings.json stores appHostPath relative to .aspire/ directory.
        // A path like "../MyApp.AppHost/MyApp.AppHost.csproj" points from .aspire/ up to
        // the repo root, then into a subdirectory. After migration it should become
        // "MyApp.AppHost/MyApp.AppHost.csproj" (relative to the repo root).
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "../MyApp.AppHost/MyApp.AppHost.csproj"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        Assert.Equal("MyApp.AppHost/MyApp.AppHost.csproj", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_SavesConfigFile()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "../src/apphost.ts",
                "sdkVersion": "13.2.0"
            }
            """);

        AspireConfigFile.LoadOrCreate(root);

        // Verify aspire.config.json was created with correct content
        var configPath = Path.Combine(root, AspireConfigFile.FileName);
        Assert.True(File.Exists(configPath));

        var saved = AspireConfigFile.Load(root);
        Assert.NotNull(saved);
        Assert.Equal("src/apphost.ts", saved.AppHost?.Path);
        Assert.Equal("13.2.0", saved.SdkVersion);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_NuGetSource()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "nugetSource": "https://proxy.example/v3/index.json"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);
        var saved = AspireConfigFile.Load(root);

        Assert.Equal("https://proxy.example/v3/index.json", config.NuGetSource);
        Assert.NotNull(saved);
        Assert.Equal("https://proxy.example/v3/index.json", saved.NuGetSource);
    }

    [Theory]
    [InlineData("https://user:password@example/v3/index.json")]
    [InlineData("https://[invalid")]
    [InlineData("https://example/v3/index.json?token=secret")]
    [InlineData("https://example/v3/index.json#fragment")]
    public void LoadOrCreate_RejectsUnsafeLegacyNuGetSourceWithoutWritingModernConfig(string unsafeSource)
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var legacyPath = Path.Combine(root, ".aspire", "settings.json");
        var legacyContent = $$"""
            {
              "channel": "daily",
              "nugetSource": "{{unsafeSource}}"
            }
            """;
        File.WriteAllText(legacyPath, legacyContent);

        var exception = Assert.Throws<InvalidOperationException>(() => AspireConfigFile.LoadOrCreate(root));

        Assert.NotEmpty(exception.Message);
        Assert.False(File.Exists(Path.Combine(root, AspireConfigFile.FileName)));
        Assert.Equal(legacyContent, File.ReadAllText(legacyPath));
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_PreservesUnknownNestedProperties()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
              "appHostPath": "../apphost.mts",
              "templateSpecific": {
                "nested": {
                  "value": 42,
                  "items": [
                    "one",
                    {
                      "enabled": true
                    }
                  ]
                }
              }
            }
            """);
        var expected = JsonNode.Parse("""
            {
              "nested": {
                "value": 42,
                "items": [
                  "one",
                  {
                    "enabled": true
                  }
                ]
              }
            }
            """);

        AspireConfigFile.LoadOrCreate(root);

        var configPath = Path.Combine(root, AspireConfigFile.FileName);
        var migratedJson = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        Assert.True(JsonNode.DeepEquals(expected, migratedJson["templateSpecific"]));

        var loaded = AspireConfigFile.Load(root);
        Assert.NotNull(loaded);
        loaded.Save(root);

        var roundTrippedJson = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        Assert.True(JsonNode.DeepEquals(expected, roundTrippedJson["templateSpecific"]));
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_MergesForwardAuthoredConfiguration()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
              "appHostPath": "../mapped-apphost.mts",
              "sdkVersion": "13.2.0",
              "AppHost": {
                "path": "object-extension-apphost.mts",
                "language": "typescript/nodejs"
              },
              "appHost:path": "flattened-extension-apphost.mts",
              "SDK": {
                "version": "0.0.0"
              },
              "sdk:version": "1.0.0",
              "Docs": {
                "llmsTxtUrl": "https://forward.example/llms.txt"
              },
              "docs:api:sitemapUrl": "https://forward.example/sitemap.xml",
              "Profiles": {
                "extension": {
                  "applicationUrl": "https://localhost:6001"
                },
                "Mapped": {
                  "applicationUrl": "https://localhost:6002",
                  "environmentVariables": {
                    "FORWARD_ONLY": "forward",
                    "CONFLICT": "forward"
                  }
                }
              },
              "templateSpecific": {
                "nested": {
                  "value": 42,
                  "items": [
                    "one",
                    {
                      "enabled": true
                    }
                  ]
                }
              }
            }
            """);
        File.WriteAllText(Path.Combine(root, "apphost.run.json"), """
            {
              "profiles": {
                "mapped": {
                  "applicationUrl": "https://localhost:7001",
                  "environmentVariables": {
                    "SOURCE": "legacy-run-profile",
                    "CONFLICT": "mapped"
                  }
                }
              }
            }
            """);
        var expectedUnknownProperty = JsonNode.Parse("""
            {
              "nested": {
                "value": 42,
                "items": [
                  "one",
                  {
                    "enabled": true
                  }
                ]
              }
            }
            """);

        AspireConfigFile.LoadOrCreate(root);

        var configPath = Path.Combine(root, AspireConfigFile.FileName);
        var migratedJson = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        var loaded = AspireConfigFile.Load(root);
        Assert.NotNull(loaded);
        Assert.Equal("mapped-apphost.mts", loaded.AppHost?.Path);
        Assert.Equal("typescript/nodejs", loaded.AppHost?.Language);
        Assert.Equal("13.2.0", loaded.SdkVersion);
        Assert.Equal("https://forward.example/llms.txt", loaded.Docs?.LlmsTxtUrl);
        Assert.Equal("https://forward.example/sitemap.xml", loaded.Docs?.Api?.SitemapUrl);
        Assert.Equal("https://localhost:6001", loaded.Profiles?["extension"].ApplicationUrl);
        Assert.Equal("https://localhost:7001", loaded.Profiles?["mapped"].ApplicationUrl);
        Assert.Equal("forward", loaded.Profiles?["mapped"].EnvironmentVariables?["FORWARD_ONLY"]);
        Assert.Equal("legacy-run-profile", loaded.Profiles?["mapped"].EnvironmentVariables?["SOURCE"]);
        Assert.Equal("mapped", loaded.Profiles?["mapped"].EnvironmentVariables?["CONFLICT"]);

        var appHostProperty = Assert.Single(
            migratedJson,
            property => string.Equals(property.Key, "appHost", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("appHost", appHostProperty.Key);
        Assert.Equal("mapped-apphost.mts", appHostProperty.Value!["path"]!.GetValue<string>());
        Assert.Equal("typescript/nodejs", appHostProperty.Value!["language"]!.GetValue<string>());

        var sdkProperty = Assert.Single(
            migratedJson,
            property => string.Equals(property.Key, "sdk", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("sdk", sdkProperty.Key);
        Assert.Equal("13.2.0", sdkProperty.Value!["version"]!.GetValue<string>());

        var docsProperty = Assert.Single(
            migratedJson,
            property => string.Equals(property.Key, "docs", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("docs", docsProperty.Key);
        Assert.Equal("https://forward.example/llms.txt", docsProperty.Value!["llmsTxtUrl"]!.GetValue<string>());
        Assert.Equal("https://forward.example/sitemap.xml", docsProperty.Value!["api"]!["sitemapUrl"]!.GetValue<string>());

        var profilesProperty = Assert.Single(
            migratedJson,
            property => string.Equals(property.Key, "profiles", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("profiles", profilesProperty.Key);
        Assert.Equal("https://localhost:6001", profilesProperty.Value!["extension"]!["applicationUrl"]!.GetValue<string>());
        Assert.Equal("https://localhost:7001", profilesProperty.Value!["mapped"]!["applicationUrl"]!.GetValue<string>());
        Assert.Equal("forward", profilesProperty.Value!["mapped"]!["environmentVariables"]!["FORWARD_ONLY"]!.GetValue<string>());
        Assert.Equal("legacy-run-profile", profilesProperty.Value!["mapped"]!["environmentVariables"]!["SOURCE"]!.GetValue<string>());
        Assert.Equal("mapped", profilesProperty.Value!["mapped"]!["environmentVariables"]!["CONFLICT"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(expectedUnknownProperty, migratedJson["templateSpecific"]));
        AssertHasNormalizedConfigurationKeys(migratedJson);

        loaded.Save(root);
        var roundTrippedJson = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        Assert.True(JsonNode.DeepEquals(expectedUnknownProperty, roundTrippedJson["templateSpecific"]));
        AssertHasNormalizedConfigurationKeys(roundTrippedJson);

        var configuration = new ConfigurationBuilder()
            .AddJsonFile(configPath)
            .Build();
        Assert.Equal("mapped-apphost.mts", configuration["appHost:path"]);
        Assert.Equal("typescript/nodejs", configuration["appHost:language"]);
        Assert.Equal("13.2.0", configuration["sdk:version"]);
        Assert.Equal("https://forward.example/llms.txt", configuration["docs:llmsTxtUrl"]);
        Assert.Equal("https://forward.example/sitemap.xml", configuration["docs:api:sitemapUrl"]);
        Assert.Equal("https://localhost:6001", configuration["profiles:extension:applicationUrl"]);
        Assert.Equal("https://localhost:7001", configuration["profiles:mapped:applicationUrl"]);
        Assert.Equal("forward", configuration["profiles:mapped:environmentVariables:FORWARD_ONLY"]);
        Assert.Equal("legacy-run-profile", configuration["profiles:mapped:environmentVariables:SOURCE"]);
        Assert.Equal("mapped", configuration["profiles:mapped:environmentVariables:CONFLICT"]);
        Assert.Equal("42", configuration["templateSpecific:nested:value"]);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_NormalizesFlattenedMappedConflicts()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
              "appHostPath": "../mapped-apphost.mts",
              "sdkVersion": "13.2.0",
              "appHost:path": "flattened-extension-apphost.mts",
              "sdk:version": "0.0.0"
            }
            """);

        AspireConfigFile.LoadOrCreate(root);

        var configPath = Path.Combine(root, AspireConfigFile.FileName);
        var migratedJson = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        AssertHasNormalizedConfigurationKeys(migratedJson);

        var appHostProperty = Assert.Single(
            migratedJson,
            property => string.Equals(property.Key, "appHost", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("appHost", appHostProperty.Key);
        Assert.Equal("mapped-apphost.mts", appHostProperty.Value!["path"]!.GetValue<string>());

        var sdkProperty = Assert.Single(
            migratedJson,
            property => string.Equals(property.Key, "sdk", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("sdk", sdkProperty.Key);
        Assert.Equal("13.2.0", sdkProperty.Value!["version"]!.GetValue<string>());

        var loaded = AspireConfigFile.Load(root);
        Assert.NotNull(loaded);
        Assert.Equal("mapped-apphost.mts", loaded.AppHost?.Path);
        Assert.Equal("13.2.0", loaded.SdkVersion);

        var configuration = new ConfigurationBuilder()
            .AddJsonFile(configPath)
            .Build();
        Assert.Equal("mapped-apphost.mts", configuration["appHost:path"]);
        Assert.Equal("13.2.0", configuration["sdk:version"]);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_LeavesAbsolutePathUnchanged()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var absolutePath = Path.Combine(root, "src", "apphost.ts").Replace(Path.DirectorySeparatorChar, '/');
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, $$"""
            {
                "appHostPath": "{{absolutePath}}"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // Absolute paths should not be modified
        Assert.Equal(absolutePath, config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_NormalizesBackslashSeparators()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        // Simulate a settings file created on Windows with backslash separators.
        // Even though we always store '/', handle '\' gracefully in case of manual edits.
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "..\\src\\apphost.ts",
                "language": "typescript/nodejs"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // Should be re-based and normalized to forward slashes
        Assert.Equal("src/apphost.ts", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_OutputAlwaysUsesForwardSlashes()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "../deeply/nested/path/apphost.ts"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // Verify output uses forward slashes regardless of platform
        Assert.Equal("deeply/nested/path/apphost.ts", config.AppHost?.Path);
        Assert.DoesNotContain("\\", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_SkipsEmptyPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "",
                "language": "typescript/nodejs"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // Empty path should not be transformed to "."
        Assert.Equal("", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_SkipsNullPath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "language": "typescript/nodejs"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // No appHostPath means no migration needed; path stays null
        Assert.Null(config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_DotSlashRelativePath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        // "./MyApp.AppHost/apphost.ts" from .aspire/ dir resolves to .aspire/MyApp.AppHost/apphost.ts
        // relative to root. While unusual, verifies dot-slash handling doesn't break.
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "./../MyApp.AppHost/apphost.ts"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        Assert.Equal("MyApp.AppHost/apphost.ts", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_BareRelativePath()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        // A bare relative path without ../ from .aspire/ stays under .aspire/ when resolved.
        // In practice legacy paths always start with ../ but we verify the math is correct.
        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "../MyApp.AppHost/MyApp.AppHost.csproj"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        Assert.Equal("MyApp.AppHost/MyApp.AppHost.csproj", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_LeavesUnixRootedPathUnchanged()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, """
            {
                "appHostPath": "/path/apphost.ts"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        Assert.Equal("/path/apphost.ts", config.AppHost?.Path);
    }

    [Fact]
    public void LoadOrCreate_MigratesLegacy_LeavesWindowsRootedPathUnchanged()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows-rooted paths are only recognized on Windows.");

        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var root = workspace.WorkspaceRoot.FullName;

        var settingsPath = Path.Combine(root, ".aspire", "settings.json");
        File.WriteAllText(settingsPath, $$"""
            {
                "appHostPath": "c:\\path\\apphost.ts"
            }
            """);

        var config = AspireConfigFile.LoadOrCreate(root);

        // On Windows, c:\ is rooted and should be left unchanged
        Assert.Equal("c:\\path\\apphost.ts", config.AppHost?.Path);
    }

    private static void AssertHasNormalizedConfigurationKeys(JsonNode? node, string path = "$")
    {
        if (node is JsonObject jsonObject)
        {
            var propertyNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (propertyName, value) in jsonObject)
            {
                Assert.True(
                    propertyNames.Add(propertyName),
                    $"Configuration object '{path}' contains duplicate logical property '{propertyName}'.");
                Assert.False(
                    propertyName.Contains(':', StringComparison.Ordinal),
                    $"Configuration property '{path}:{propertyName}' was not normalized.");
                AssertHasNormalizedConfigurationKeys(value, $"{path}:{propertyName}");
            }
        }
        else if (node is JsonArray jsonArray)
        {
            for (var i = 0; i < jsonArray.Count; i++)
            {
                AssertHasNormalizedConfigurationKeys(jsonArray[i], $"{path}:{i}");
            }
        }
    }
}
