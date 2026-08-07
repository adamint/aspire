// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using Xunit;

namespace Infrastructure.Tests;

/// <summary>
/// Guards the npm lockfiles that ship in templates and test fixtures against acquiring packages from
/// outside the approved dotnet-public-npm feed.
/// </summary>
/// <remarks>
/// extension/scripts/validate-lockfile-registry.cjs performs the same check for extension/yarn.lock,
/// but it only covers that one file. The npm lockfiles are just as load-bearing: ts-starter and
/// py-starter ship theirs to users through `aspire new`, so a stray public-registry URL there becomes
/// a package every scaffolded app downloads from an unapproved source.
///
/// This also catches a drift npm produces on its own. Azure Artifacts answers tarball requests with a
/// redirect to a CDN host, and npm records the redirect target rather than the configured registry:
///
///   "resolved": "https://ms-feed-17.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/typescript/-/typescript-6.0.3.tgz"
///
/// Only entries added or refreshed by a given `npm install` pick up that form, so a lockfile ends up
/// with a mix of hosts and reviewers see nothing obviously wrong. Rewrite the host back to the
/// canonical feed when regenerating a lockfile.
/// </remarks>
public class NpmLockfileRegistryTests
{
    private const string ApprovedFeed = "pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm";

    /// <summary>
    /// The shipped and fixture lockfiles are enumerated from known directories rather than by a
    /// repo-wide glob, so the set stays bounded. A repo-wide glob would pick up lockfiles under
    /// node_modules, build output, and scratch directories left behind by local runs.
    /// </summary>
    public static TheoryData<string> LockfilePaths
    {
        get
        {
            var paths = new TheoryData<string>
            {
                Path.Combine("src", "Aspire.Cli", "Templating", "Templates", "ts-starter", "package-lock.json"),
                Path.Combine("src", "Aspire.Cli", "Templating", "Templates", "py-starter", "package-lock.json"),
                Path.Combine("tests", "Aspire.Hosting.CodeGeneration.TypeScript.JsTests", "package-lock.json"),
            };

            // The polyglot validation fixtures install their declared toolchain before type-checking
            // the generated API surface, so they acquire packages in CI just like the shipped
            // templates do.
            var polyglotRoot = Path.Combine(RepoRoot.Path, "tests", "PolyglotAppHosts");
            foreach (var lockfile in Directory.EnumerateFiles(polyglotRoot, "package-lock.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
            {
                paths.Add(Path.GetRelativePath(RepoRoot.Path, lockfile));
            }

            return paths;
        }
    }

    [Theory]
    [MemberData(nameof(LockfilePaths))]
    public void Lockfile_ResolvesEveryPackageThroughTheApprovedFeed(string relativePath)
    {
        var lockfilePath = Path.Combine(RepoRoot.Path, relativePath);
        Assert.True(File.Exists(lockfilePath), $"{relativePath} does not exist. Update {nameof(LockfilePaths)} if it moved or was removed.");

        using var document = JsonDocument.Parse(File.ReadAllText(lockfilePath));

        // lockfileVersion 2 and 3 both key every dependency under "packages"; the root project is the
        // empty-string key and has no "resolved" of its own.
        var packages = document.RootElement.GetProperty("packages");

        var offenders = new List<string>();
        foreach (var package in packages.EnumerateObject())
        {
            if (!package.Value.TryGetProperty("resolved", out var resolved) || resolved.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var url = resolved.GetString()!;

            // Link and workspace entries resolve to a relative path on disk rather than a registry.
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!url.Contains(ApprovedFeed, StringComparison.OrdinalIgnoreCase))
            {
                offenders.Add($"{package.Name} -> {url}");
            }
        }

        Assert.Empty(offenders);
    }
}
