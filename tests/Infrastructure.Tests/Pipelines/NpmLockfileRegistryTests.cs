// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using Xunit;
using YamlDotNet.RepresentationModel;

namespace Infrastructure.Tests;

/// <summary>
/// Guards the npm-ecosystem lockfiles that ship in templates and test fixtures against acquiring
/// packages from outside the approved dotnet-public-npm feed.
/// </summary>
/// <remarks>
/// extension/scripts/validate-lockfile-registry.cjs performs the same check for extension/yarn.lock,
/// but it only covers that one file. The lockfiles guarded here are just as load-bearing: ts-starter
/// and py-starter ship theirs to users through `aspire new`, so a stray public-registry URL there
/// becomes a package every scaffolded app downloads from an unapproved source. The
/// tests/PolyglotAppHosts fixtures are installed in CI by
/// .github/workflows/polyglot-validation/test-typescript-playground.sh, which runs `npm install`,
/// `pnpm install --ignore-workspace`, `yarn install`, or `bun install` depending on the fixture, so
/// every package manager's lockfile is an acquisition path of its own.
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
    private const string ApprovedFeedHost = "pkgs.dev.azure.com";

    // The trailing slash matters: without it "/dnceng/public/_packaging/dotnet-public-npm-evil/"
    // would satisfy the prefix test.
    private const string ApprovedFeedPathPrefix = "/dnceng/public/_packaging/dotnet-public-npm/";

    /// <summary>
    /// A lockfile value is treated as a remote acquisition only when it names a scheme with an
    /// authority. That excludes the intra-lockfile references every format uses for local packages —
    /// npm's <c>"resolved": "node_modules/foo"</c>, Bun's <c>"pkg@workspace:packages/foo"</c>, and
    /// Yarn's <c>"pkg@npm:1.0.0"</c> — while still catching non-HTTP origins such as
    /// <c>git+ssh://git@github.com/...</c>, which a scheme-specific check would let through.
    /// </summary>
    private const string RemoteReferenceMarker = "://";

    /// <summary>
    /// The shipped and fixture lockfiles are enumerated from known directories rather than by a
    /// repo-wide glob, so the set stays bounded. A repo-wide glob would pick up lockfiles under
    /// node_modules, build output, and scratch directories left behind by local runs.
    /// </summary>
    public static TheoryData<string> NpmLockfilePaths
    {
        get
        {
            var paths = new TheoryData<string>
            {
                Path.Combine("src", "Aspire.Cli", "Templating", "Templates", "ts-starter", "package-lock.json"),
                Path.Combine("src", "Aspire.Cli", "Templating", "Templates", "py-starter", "package-lock.json"),
                Path.Combine("tests", "Aspire.Hosting.CodeGeneration.TypeScript.JsTests", "package-lock.json"),
            };

            foreach (var lockfile in EnumeratePolyglotLockfiles("package-lock.json"))
            {
                paths.Add(lockfile);
            }

            return paths;
        }
    }

    public static TheoryData<string> BunLockfilePaths => ToTheoryData(EnumeratePolyglotLockfiles("bun.lock"));

    public static TheoryData<string> PnpmLockfilePaths => ToTheoryData(EnumeratePolyglotLockfiles("pnpm-lock.yaml"));

    public static TheoryData<string> YarnLockfilePaths => ToTheoryData(EnumeratePolyglotLockfiles("yarn.lock"));

    [Theory]
    [MemberData(nameof(NpmLockfilePaths))]
    public void NpmLockfile_ResolvesEveryPackageThroughTheApprovedFeed(string relativePath)
    {
        var scan = ScanNpmLockfile(ReadLockfile(relativePath));

        // A lockfile that parsed into zero remote references would pass the offender check
        // vacuously, which is exactly how this guard would rot without anyone noticing.
        Assert.NotEqual(0, scan.RemoteReferenceCount);
        Assert.Empty(scan.Offenders);
    }

    [Theory]
    [MemberData(nameof(BunLockfilePaths))]
    public void BunLockfile_ResolvesEveryPackageThroughTheApprovedFeed(string relativePath)
    {
        var scan = ScanBunLockfile(ReadLockfile(relativePath));

        Assert.NotEqual(0, scan.RemoteReferenceCount);
        Assert.Empty(scan.Offenders);
    }

    [Theory]
    [MemberData(nameof(PnpmLockfilePaths))]
    public void PnpmLockfile_ResolvesEveryPackageThroughTheApprovedFeed(string relativePath)
    {
        var scan = ScanPnpmLockfile(ReadLockfile(relativePath));

        Assert.NotEqual(0, scan.RemoteReferenceCount);
        Assert.Empty(scan.Offenders);
    }

    [Theory]
    [MemberData(nameof(YarnLockfilePaths))]
    public void YarnLockfile_ResolvesEveryPackageThroughTheApprovedFeed(string relativePath)
    {
        var contents = ReadLockfile(relativePath);

        // Unlike the other three formats, a Yarn Berry lockfile records no tarball host at all: the
        // registry comes from .yarnrc.yml / YARN_NPM_REGISTRY_SERVER at install time. So the
        // offender scan below is a tripwire for URL-pinned entries rather than the main assertion,
        // and the format check is what keeps it meaningful. Yarn Classic *does* pin an absolute
        // `resolved` URL per entry, and test-typescript-playground.sh refuses to run a Classic
        // lockfile, so a downgrade has to fail loudly here instead of silently changing where
        // packages come from.
        Assert.Equal(YarnLockfileFormat.Berry, GetYarnLockfileFormat(contents));

        Assert.Empty(ScanYarnLockfile(contents).Offenders);
    }

    [Theory]
    // The canonical form every guarded lockfile uses today.
    [InlineData("https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", true)]
    // Uri lower-cases the host during canonicalization, so a shouted host is still the approved one.
    [InlineData("https://PKGS.DEV.AZURE.COM/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", true)]
    // Plaintext transport: the tarball is the same, but it arrives over a channel anyone on the path can rewrite.
    [InlineData("http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Approved-feed text pushed into the path of an attacker-controlled host.
    [InlineData("https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Userinfo trick: everything before '@' is credentials, so the real host is evil.example.com.
    [InlineData("https://pkgs.dev.azure.com@evil.example.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Suffix host spoof.
    [InlineData("https://pkgs.dev.azure.com.evil.example.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Subdomain host spoof.
    [InlineData("https://evil.pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Right host, wrong port: a proxy on 8443 is not the feed.
    [InlineData("https://pkgs.dev.azure.com:8443/dnceng/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Right host, different feed on the same organization.
    [InlineData("https://pkgs.dev.azure.com/dnceng/internal/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Feed name that merely starts with the approved one.
    [InlineData("https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm-evil/npm/registry/ms/-/ms-2.1.3.tgz", false)]
    // Path traversal, raw and percent-encoded. Uri collapses both to /dnceng/evil/... before the prefix test runs.
    [InlineData("https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/../../../evil/ms-2.1.3.tgz", false)]
    [InlineData("https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/%2e%2e/%2e%2e/%2e%2e/evil/ms-2.1.3.tgz", false)]
    // The Azure Artifacts CDN redirect target npm records on its own; a different feed entirely.
    [InlineData("https://ms-feed-17.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/typescript/-/typescript-6.0.3.tgz", false)]
    // The public registry.
    [InlineData("https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", false)]
    // Non-HTTP origins.
    [InlineData("git+ssh://git@github.com/someone/ms.git#0000000000000000000000000000000000000000", false)]
    [InlineData("file:///etc/ms-2.1.3.tgz", false)]
    public void IsApprovedFeedUrl_AcceptsOnlyTheExactHttpsFeedPrefix(string url, bool expected)
    {
        Assert.Equal(expected, IsApprovedFeedUrl(url));
    }

    [Fact]
    public void ScanNpmLockfile_FlagsUnapprovedResolvedUrls()
    {
        // Mirrors the shape npm writes: every dependency is keyed under "packages", the root project
        // is the empty-string key with no "resolved", and link/workspace entries resolve to a path on
        // disk instead of a registry.
        const string Lockfile = """
            {
              "name": "fixture",
              "lockfileVersion": 3,
              "packages": {
                "": { "name": "fixture", "version": "1.0.0" },
                "node_modules/approved": {
                  "version": "2.1.3",
                  "resolved": "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/approved/-/approved-2.1.3.tgz"
                },
                "node_modules/insecure": {
                  "version": "2.1.3",
                  "resolved": "http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/insecure/-/insecure-2.1.3.tgz"
                },
                "node_modules/spoofed": {
                  "version": "2.1.3",
                  "resolved": "https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/spoofed/-/spoofed-2.1.3.tgz"
                },
                "node_modules/linked": { "resolved": "packages/linked", "link": true }
              }
            }
            """;

        var scan = ScanNpmLockfile(Lockfile);

        string[] expected =
        [
            "node_modules/insecure -> http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/insecure/-/insecure-2.1.3.tgz",
            "node_modules/spoofed -> https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/spoofed/-/spoofed-2.1.3.tgz",
        ];

        Assert.Equal(3, scan.RemoteReferenceCount);
        Assert.Equal(expected, scan.Offenders);
    }

    [Fact]
    public void ScanBunLockfile_FlagsUnapprovedTarballUrls()
    {
        // Mirrors the shape bun writes. The file is JSONC: object members carry trailing commas, so a
        // plain JSON reader rejects it. Registry entries are 4-element arrays
        // ["name@version", tarball, metadata, integrity]; workspace and git entries are shorter and
        // carry their reference in element 0 instead, which is why the scan checks every string
        // element rather than a fixed index.
        const string Lockfile = """
            {
              "lockfileVersion": 1,
              "workspaces": {
                "": {
                  "name": "fixture",
                },
              },
              "packages": {
                "approved": ["approved@2.1.3", "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/approved/-/approved-2.1.3.tgz", {}, "sha512-AAAA"],
                "insecure": ["insecure@2.1.3", "http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/insecure/-/insecure-2.1.3.tgz", {}, "sha512-BBBB"],
                "spoofed": ["spoofed@2.1.3", "https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/spoofed/-/spoofed-2.1.3.tgz", {}, "sha512-CCCC"],
                "workspace-only": ["workspace-only@workspace:packages/workspace-only"],
              }
            }
            """;

        var scan = ScanBunLockfile(Lockfile);

        string[] expected =
        [
            "insecure -> http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/insecure/-/insecure-2.1.3.tgz",
            "spoofed -> https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/spoofed/-/spoofed-2.1.3.tgz",
        ];

        Assert.Equal(3, scan.RemoteReferenceCount);
        Assert.Equal(expected, scan.Offenders);
    }

    [Fact]
    public void ScanPnpmLockfile_FlagsUnapprovedTarballUrls()
    {
        // Mirrors the shape pnpm writes. Hosts appear only under `packages.<id>.resolution`, as a
        // flow mapping whose `tarball` member is a plain (unquoted) scalar:
        //
        //   resolution: {integrity: sha512-AAAA, tarball: https://host/path.tgz}
        //
        // `importers` and `snapshots` restate the same packages without any host, so scanning
        // `resolution` alone covers every acquisition without double-counting. A `resolution` can
        // also describe a git or direct-tarball dependency, so every scalar in it is checked, not
        // just `tarball`.
        const string Lockfile = """
            lockfileVersion: '9.0'

            importers:

              .:
                dependencies:
                  approved:
                    specifier: ^2.1.3
                    version: 2.1.3

            packages:

              approved@2.1.3:
                resolution: {integrity: sha512-AAAA, tarball: https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/approved/-/approved-2.1.3.tgz}

              insecure@2.1.3:
                resolution: {integrity: sha512-BBBB, tarball: http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/insecure/-/insecure-2.1.3.tgz}

              spoofed@2.1.3:
                resolution: {integrity: sha512-CCCC, tarball: https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/spoofed/-/spoofed-2.1.3.tgz}

              local@2.1.3:
                resolution: {directory: packages/local, type: directory}

            snapshots:

              approved@2.1.3: {}
            """;

        var scan = ScanPnpmLockfile(Lockfile);

        string[] expected =
        [
            "insecure@2.1.3 -> http://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/insecure/-/insecure-2.1.3.tgz",
            "spoofed@2.1.3 -> https://evil.example.com/pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/spoofed/-/spoofed-2.1.3.tgz",
        ];

        Assert.Equal(3, scan.RemoteReferenceCount);
        Assert.Equal(expected, scan.Offenders);
    }

    [Fact]
    public void ScanYarnLockfile_FlagsUnapprovedResolutionUrls()
    {
        // Mirrors the shape Yarn Berry writes. Berry lockfiles are YAML, and a registry dependency
        // records no host — `resolution: "approved@npm:2.1.3"` defers to the configured registry.
        // A dependency pinned to a URL in package.json is the one case where a host lands in the
        // file, and it shows up inside the `resolution` locator after the '@':
        //
        //   resolution: "spoofed@https://evil.example.com/spoofed-2.1.3.tgz"
        const string Lockfile = """
            # This file is generated by running "yarn install" inside your project.
            # Manual changes might be lost - proceed with caution!

            __metadata:
              version: 9
              cacheKey: 10c0

            "approved@npm:2.1.3":
              version: 2.1.3
              resolution: "approved@npm:2.1.3"
              checksum: 10c0/aaaa
              languageName: node
              linkType: hard

            "spoofed@https://evil.example.com/spoofed-2.1.3.tgz":
              version: 2.1.3
              resolution: "spoofed@https://evil.example.com/spoofed-2.1.3.tgz"
              checksum: 10c0/cccc
              languageName: node
              linkType: hard
            """;

        var scan = ScanYarnLockfile(Lockfile);

        // The descriptor key and the `resolution` locator hold the same URL, and the scan reports one
        // acquisition per distinct entry/URL pair rather than one per occurrence.
        string[] expected = ["spoofed@https://evil.example.com/spoofed-2.1.3.tgz -> https://evil.example.com/spoofed-2.1.3.tgz"];

        Assert.Equal(1, scan.RemoteReferenceCount);
        Assert.Equal(expected, scan.Offenders);
    }

    [Fact]
    public void GetYarnLockfileFormat_DetectsClassic()
    {
        // Yarn Classic is not YAML and pins an absolute `resolved` URL per entry. The polyglot script
        // refuses to install it, so the guard has to recognize the format rather than parse it.
        const string Lockfile = """
            # THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
            # yarn lockfile v1

            approved@^2.1.3:
              version "2.1.3"
              resolved "https://registry.yarnpkg.com/approved/-/approved-2.1.3.tgz#0000"
            """;

        Assert.Equal(YarnLockfileFormat.Classic, GetYarnLockfileFormat(Lockfile));
    }

    /// <summary>
    /// Compares the parsed scheme, host, port, and path of <paramref name="url"/> against the
    /// approved feed. A substring search over the raw text is not enough: it accepts
    /// <c>http://pkgs.dev.azure.com/...</c>, which downloads over plaintext, and
    /// <c>https://evil.example.com/pkgs.dev.azure.com/...</c>, which puts the approved feed's text in
    /// the path of a host nobody approved. Both are packages fetched from an unapproved origin.
    /// </summary>
    private static bool IsApprovedFeedUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal))
        {
            return false;
        }

        // Uri.Host excludes userinfo, so "https://pkgs.dev.azure.com@evil.example.com/..." reports
        // the host as evil.example.com and is rejected here.
        if (!string.Equals(uri.Host, ApprovedFeedHost, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!uri.IsDefaultPort)
        {
            return false;
        }

        // AbsolutePath is canonicalized before this comparison: Uri collapses "../" segments and
        // decodes "%2e%2e" first, so "/dnceng/public/_packaging/dotnet-public-npm/%2e%2e/evil/x.tgz"
        // arrives here as "/dnceng/public/evil/x.tgz" and fails the prefix test.
        return uri.AbsolutePath.StartsWith(ApprovedFeedPathPrefix, StringComparison.Ordinal);
    }

    private static LockfileScan ScanNpmLockfile(string contents)
    {
        // lockfileVersion 2 and 3 both key every dependency under "packages"; the root project is the
        // empty-string key and has no "resolved" of its own.
        using var document = JsonDocument.Parse(contents);
        var packages = document.RootElement.GetProperty("packages");

        var scan = new LockfileScanBuilder();

        foreach (var package in packages.EnumerateObject())
        {
            if (!package.Value.TryGetProperty("resolved", out var resolved) || resolved.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            scan.Inspect(package.Name, resolved.GetString()!);
        }

        return scan.Build();
    }

    private static LockfileScan ScanBunLockfile(string contents)
    {
        // bun.lock is JSONC, not JSON: bun writes a trailing comma after every object member, so the
        // reader has to allow them. Registry entries look like
        //
        //   "ms": ["ms@2.1.3", "https://<feed>/npm/registry/ms/-/ms-2.1.3.tgz", {}, "sha512-6Flz..."],
        //
        // but workspace, git, and direct-tarball entries have fewer elements and carry their
        // reference in element 0, so every string element is inspected instead of a fixed index. The
        // integrity element never contains "://", so it is filtered out by the remote-reference test.
        var options = new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip };
        using var document = JsonDocument.Parse(contents, options);
        var packages = document.RootElement.GetProperty("packages");

        var scan = new LockfileScanBuilder();

        foreach (var package in packages.EnumerateObject())
        {
            if (package.Value.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var element in package.Value.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.String)
                {
                    scan.Inspect(package.Name, element.GetString()!);
                }
            }
        }

        return scan.Build();
    }

    private static LockfileScan ScanPnpmLockfile(string contents)
    {
        // pnpm records hosts only under `packages.<id>.resolution`:
        //
        //   packages:
        //     ms@2.1.3:
        //       resolution: {integrity: sha512-6Flz..., tarball: https://<feed>/npm/registry/ms/-/ms-2.1.3.tgz}
        //
        // `importers` and `snapshots` restate the same ids without a host, so `resolution` is the
        // complete set of acquisitions. A `resolution` can also be `{type: git, repo: ..., commit:
        // ...}` or `{directory: ..., type: directory}`, so every scalar in the mapping is inspected
        // rather than just `tarball`; the non-URL members never contain "://".
        var root = LoadYamlMapping(contents);

        var scan = new LockfileScanBuilder();

        if (root is not null && root.Children.TryGetValue(new YamlScalarNode("packages"), out var packagesNode) &&
            packagesNode is YamlMappingNode packages)
        {
            foreach (var (idNode, packageNode) in packages.Children)
            {
                if (packageNode is not YamlMappingNode package ||
                    !package.Children.TryGetValue(new YamlScalarNode("resolution"), out var resolutionNode) ||
                    resolutionNode is not YamlMappingNode resolution)
                {
                    continue;
                }

                var id = (idNode as YamlScalarNode)?.Value ?? idNode.ToString();
                foreach (var value in resolution.Children.Values.OfType<YamlScalarNode>())
                {
                    if (value.Value is { } scalar)
                    {
                        scan.Inspect(id, scalar);
                    }
                }
            }
        }

        return scan.Build();
    }

    private static LockfileScan ScanYarnLockfile(string contents)
    {
        // Yarn Berry lockfiles are YAML. Every top-level key is a descriptor and each entry carries a
        // `resolution` locator:
        //
        //   "typescript@npm:^6.0.3":
        //     version: 6.0.3
        //     resolution: "typescript@npm:6.0.3"
        //
        // A registry dependency names no host at all — `npm:` is a protocol Yarn resolves against the
        // registry configured in .yarnrc.yml, not a URL. Only a dependency pinned to a URL in
        // package.json puts a host in the file, and it lands inside the locator after the '@'. Both
        // the descriptor key and the entry's scalars are inspected so either form is caught.
        var root = LoadYamlMapping(contents);

        var scan = new LockfileScanBuilder();

        if (root is not null)
        {
            foreach (var (descriptorNode, entryNode) in root.Children)
            {
                var descriptor = (descriptorNode as YamlScalarNode)?.Value ?? descriptorNode.ToString();
                scan.Inspect(descriptor, descriptor);

                if (entryNode is YamlMappingNode entry)
                {
                    foreach (var value in entry.Children.Values.OfType<YamlScalarNode>())
                    {
                        if (value.Value is { } scalar)
                        {
                            scan.Inspect(descriptor, scalar);
                        }
                    }
                }
            }
        }

        return scan.Build();
    }

    private static YarnLockfileFormat GetYarnLockfileFormat(string contents)
    {
        // Classic announces itself in the banner Yarn 1 writes at the top of every lockfile:
        //
        //   # THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
        //   # yarn lockfile v1
        //
        // This is the same marker test-typescript-playground.sh greps for before refusing to install.
        foreach (var line in contents.Split('\n').Take(5))
        {
            if (line.Trim().Equals("# yarn lockfile v1", StringComparison.OrdinalIgnoreCase))
            {
                return YarnLockfileFormat.Classic;
            }
        }

        return YarnLockfileFormat.Berry;
    }

    private static YamlMappingNode? LoadYamlMapping(string contents)
    {
        var stream = new YamlStream();
        stream.Load(new StringReader(contents));

        return stream.Documents.Count == 0 ? null : stream.Documents[0].RootNode as YamlMappingNode;
    }

    private static string ReadLockfile(string relativePath)
    {
        var lockfilePath = Path.Combine(RepoRoot.Path, relativePath);
        Assert.True(File.Exists(lockfilePath), $"{relativePath} does not exist. Update the lockfile theory data if it moved or was removed.");

        return File.ReadAllText(lockfilePath);
    }

    /// <summary>
    /// The polyglot validation fixtures install their declared toolchain before type-checking the
    /// generated API surface, so they acquire packages in CI just like the shipped templates do.
    /// Each fixture declares one package manager, so the four lockfile names partition the set.
    /// </summary>
    private static IEnumerable<string> EnumeratePolyglotLockfiles(string fileName)
    {
        var polyglotRoot = Path.Combine(RepoRoot.Path, "tests", "PolyglotAppHosts");

        return Directory.EnumerateFiles(polyglotRoot, fileName, SearchOption.AllDirectories)
            // A local `npm install` in a fixture leaves committed-looking lockfiles under
            // node_modules. Those are never checked in, so failing on them would only break local runs.
            .Where(path => !path.Split(Path.DirectorySeparatorChar).Contains("node_modules", StringComparer.Ordinal))
            .Select(path => Path.GetRelativePath(RepoRoot.Path, path))
            .Order(StringComparer.Ordinal);
    }

    private static TheoryData<string> ToTheoryData(IEnumerable<string> values)
    {
        var data = new TheoryData<string>();
        foreach (var value in values)
        {
            data.Add(value);
        }

        return data;
    }

    private sealed record LockfileScan(int RemoteReferenceCount, IReadOnlyList<string> Offenders);

    /// <summary>
    /// Accumulates the remote acquisitions a lockfile declares, de-duplicated because some formats
    /// state the same origin twice (a Yarn entry repeats its locator in the descriptor key).
    /// </summary>
    private sealed class LockfileScanBuilder
    {
        private readonly SortedSet<string> _remoteReferences = new(StringComparer.Ordinal);
        private readonly SortedSet<string> _offenders = new(StringComparer.Ordinal);

        /// <summary>
        /// Records <paramref name="value"/> as an offender when it names a remote origin that is not
        /// the approved feed. Values without an authority are intra-lockfile references and ignored.
        /// </summary>
        public void Inspect(string entryName, string value)
        {
            var marker = value.IndexOf(RemoteReferenceMarker, StringComparison.Ordinal);
            if (marker < 0)
            {
                return;
            }

            // Yarn embeds the URL inside a locator such as "spoofed@https://host/spoofed-2.1.3.tgz",
            // so the URL starts at the scheme rather than at index 0. Walk back from "://" over the
            // scheme characters RFC 3986 allows — ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) — to
            // find where it begins. See https://www.rfc-editor.org/rfc/rfc3986#section-3.1.
            var start = marker;
            while (start > 0 && (char.IsAsciiLetterOrDigit(value[start - 1]) || value[start - 1] is '+' or '-' or '.'))
            {
                start--;
            }

            var url = value[start..];
            var reference = $"{entryName} -> {url}";

            _remoteReferences.Add(reference);
            if (!IsApprovedFeedUrl(url))
            {
                _offenders.Add(reference);
            }
        }

        public LockfileScan Build() => new(_remoteReferences.Count, [.. _offenders]);
    }

    private enum YarnLockfileFormat
    {
        Berry,
        Classic,
    }
}
