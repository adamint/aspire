// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Semver;

namespace Aspire.Cli.Utils.EnvironmentChecker;

/// <summary>
/// Queries the Visual Studio Marketplace for the latest stable Aspire VS Code extension version.
/// </summary>
internal sealed class VsCodeExtensionMarketplaceClient : IVsCodeExtensionMarketplaceClient
{
    internal const string ExtensionId = "microsoft-aspire.aspire-vscode";

    private const string PreReleasePropertyName = "Microsoft.VisualStudio.Code.PreRelease";
    // The Marketplace query contract uses numeric filters and bit flags. These values mirror VS Code:
    // ExtensionName (7), Target (8), ExcludeWithFlags (12), IncludeVersionProperties (0x10),
    // ExcludeNonValidated (0x20), and IncludeLatestPrereleaseAndStableVersionOnly (0x10000).
    // See https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts.
    private const int QueryFlags = 0x10 | 0x20 | 0x10000;
    private static readonly string s_queryJson = $$"""
        {
          "filters": [
            {
              "criteria": [
                {
                  "filterType": 7,
                  "value": "{{ExtensionId}}"
                },
                {
                  "filterType": 8,
                  "value": "Microsoft.VisualStudio.Code"
                },
                {
                  "filterType": 12,
                  "value": "4096"
                }
              ],
              "pageNumber": 1,
              "pageSize": 1,
              "sortBy": 0,
              "sortOrder": 0
            }
          ],
          "assetTypes": [],
          "flags": {{QueryFlags}}
        }
        """;

    private static readonly Uri s_queryUri = new("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery");
    private static readonly TimeSpan s_defaultTimeout = TimeSpan.FromSeconds(5);

    private readonly HttpClient _httpClient;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _timeout;

    public VsCodeExtensionMarketplaceClient(HttpClient httpClient, TimeProvider timeProvider)
        : this(httpClient, timeProvider, s_defaultTimeout)
    {
    }

    internal VsCodeExtensionMarketplaceClient(HttpClient httpClient, TimeProvider timeProvider, TimeSpan timeout)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(timeProvider);

        _httpClient = httpClient;
        _timeProvider = timeProvider;
        _timeout = timeout;
    }

    public async Task<SemVersion> GetLatestStableVersionAsync(CancellationToken cancellationToken)
    {
        using var timeoutCts = new CancellationTokenSource(_timeout, _timeProvider);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        using var request = new HttpRequestMessage(HttpMethod.Post, s_queryUri)
        {
            Content = new StringContent(s_queryJson, Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.Add(MediaTypeWithQualityHeaderValue.Parse("application/json;api-version=3.0-preview.1"));

        try
        {
            using var response = await _httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                linkedCts.Token).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();

            await using var responseStream = await response.Content.ReadAsStreamAsync(linkedCts.Token).ConfigureAwait(false);
            using var responseJson = await JsonDocument.ParseAsync(
                responseStream,
                cancellationToken: linkedCts.Token).ConfigureAwait(false);

            return ParseLatestStableVersion(responseJson.RootElement);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested && timeoutCts.IsCancellationRequested)
        {
            throw new TimeoutException($"The VS Code Marketplace request timed out after {_timeout.TotalSeconds} seconds.", ex);
        }
    }

    internal static SemVersion ParseLatestStableVersion(JsonElement root)
    {
        SemVersion? latestVersion = null;

        // The Marketplace extension query response is shaped as:
        //   { "results": [{ "extensions": [{ "versions": [{ "version": "1.16.0",
        //       "properties": [{ "key": "Microsoft.VisualStudio.Code.PreRelease", "value": "true" }] }] }] }] }
        if (root.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
        {
            foreach (var result in results.EnumerateArray())
            {
                if (!result.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var extension in extensions.EnumerateArray())
                {
                    if (!extension.TryGetProperty("versions", out var versions) || versions.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var versionElement in versions.EnumerateArray())
                    {
                        if (!versionElement.TryGetProperty("version", out var versionProperty)
                            || versionProperty.ValueKind != JsonValueKind.String
                            || versionProperty.GetString() is not { Length: > 0 } versionString
                            || !SemVersion.TryParse(versionString, SemVersionStyles.Strict, out var version)
                            || version.IsPrerelease
                            || IsMarketplacePreRelease(versionElement))
                        {
                            continue;
                        }

                        if (latestVersion is null || SemVersion.ComparePrecedence(version, latestVersion) > 0)
                        {
                            latestVersion = version;
                        }
                    }
                }
            }
        }

        return latestVersion
            ?? throw new InvalidDataException("The VS Code Marketplace response did not contain a stable extension version.");
    }

    private static bool IsMarketplacePreRelease(JsonElement versionElement)
    {
        if (!versionElement.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var property in properties.EnumerateArray())
        {
            if (property.TryGetProperty("key", out var key)
                && key.ValueKind == JsonValueKind.String
                && string.Equals(key.GetString(), PreReleasePropertyName, StringComparison.OrdinalIgnoreCase)
                && property.TryGetProperty("value", out var value)
                && value.ValueKind == JsonValueKind.String
                && bool.TryParse(value.GetString(), out var isPreRelease)
                && isPreRelease)
            {
                return true;
            }
        }

        return false;
    }
}
