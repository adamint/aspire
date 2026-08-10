// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text;
using System.Text.Json;
using Semver;

namespace Aspire.Cli.Utils.EnvironmentChecker;

/// <summary>
/// Queries the Visual Studio Marketplace for Aspire VS Code extension versions.
/// </summary>
internal sealed class VsCodeExtensionMarketplaceClient(HttpClient httpClient) : IVsCodeExtensionMarketplaceClient
{
    private const string MarketplaceQueryUrl = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
    private const string PreReleasePropertyName = "Microsoft.VisualStudio.Code.PreRelease";

    public async Task<VsCodeExtensionMarketplaceVersions> GetLatestVersionsAsync(CancellationToken cancellationToken)
    {
        // The numeric filter and flag values are the Marketplace protocol used by VS Code:
        // ExtensionName (7), Target (8), ExcludeWithFlags (12), IncludeVersionProperties (0x10),
        // ExcludeNonValidated (0x20), and IncludeLatestPrereleaseAndStableVersionOnly (0x10000).
        // See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts.
        const string requestBody = """
            {
              "filters": [{
                "criteria": [
                  { "filterType": 7, "value": "microsoft-aspire.aspire-vscode" },
                  { "filterType": 8, "value": "Microsoft.VisualStudio.Code" },
                  { "filterType": 12, "value": "4096" }
                ]
              }],
              "assetTypes": [],
              "flags": 65584
            }
            """;
        using var request = new HttpRequestMessage(HttpMethod.Post, MarketplaceQueryUrl)
        {
            Content = new StringContent(requestBody, Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.ParseAdd("application/json; api-version=3.0-preview.1");

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var responseStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var responseJson = await JsonDocument.ParseAsync(responseStream, cancellationToken: cancellationToken);

        return ParseVersions(responseJson.RootElement);
    }

    private static VsCodeExtensionMarketplaceVersions ParseVersions(JsonElement root)
    {
        // The response nests the two requested channel entries as:
        //   { "results": [{ "extensions": [{ "versions": [
        //       { "version": "1.3.0" },
        //       { "version": "1.4.0", "properties": [{
        //           "key": "Microsoft.VisualStudio.Code.PreRelease", "value": "true" }] }
        //   ] }] }] }
        SemVersion? stableVersion = null;
        SemVersion? preReleaseVersion = null;

        if (root.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
        {
            foreach (var result in results.EnumerateArray())
            {
                if (result.ValueKind != JsonValueKind.Object ||
                    !result.TryGetProperty("extensions", out var extensions) ||
                    extensions.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var extension in extensions.EnumerateArray())
                {
                    if (extension.ValueKind != JsonValueKind.Object ||
                        !extension.TryGetProperty("versions", out var versions) ||
                        versions.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var versionEntry in versions.EnumerateArray())
                    {
                        if (versionEntry.ValueKind != JsonValueKind.Object ||
                            !versionEntry.TryGetProperty("version", out var versionElement) ||
                            versionElement.ValueKind != JsonValueKind.String ||
                            !SemVersion.TryParse(versionElement.GetString(), SemVersionStyles.Strict, out var version))
                        {
                            continue;
                        }

                        if (IsPreRelease(versionEntry))
                        {
                            preReleaseVersion = SelectLatest(preReleaseVersion, version);
                        }
                        else
                        {
                            stableVersion = SelectLatest(stableVersion, version);
                        }
                    }
                }
            }
        }

        return new VsCodeExtensionMarketplaceVersions(stableVersion, preReleaseVersion);
    }

    private static bool IsPreRelease(JsonElement versionEntry)
    {
        if (!versionEntry.TryGetProperty("properties", out var properties) ||
            properties.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var property in properties.EnumerateArray())
        {
            if (property.ValueKind == JsonValueKind.Object &&
                property.TryGetProperty("key", out var key) &&
                key.ValueKind == JsonValueKind.String &&
                string.Equals(key.GetString(), PreReleasePropertyName, StringComparison.OrdinalIgnoreCase) &&
                property.TryGetProperty("value", out var value) &&
                value.ValueKind == JsonValueKind.String &&
                bool.TryParse(value.GetString(), out var isPreRelease))
            {
                return isPreRelease;
            }
        }

        return false;
    }

    private static SemVersion SelectLatest(SemVersion? current, SemVersion candidate)
        => current is null || SemVersion.ComparePrecedence(candidate, current) > 0
            ? candidate
            : current;
}
