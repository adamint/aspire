// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.IO.Enumeration;
using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;
using Aspire.TestUtilities;
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
    private static readonly Regex s_registryKey = new(
        @"^\s*(?<key>(@[^\s:]+:)?registry|npmRegistryServer|npmPublishRegistry)\s*[=:]\s*(?<value>\S+)\s*$",
        RegexOptions.Multiline);

    // Comments in .npmrc, .yarnrc.yml and bunfig.toml all start with '#'; .npmrc also accepts ';'.
    // A registry URL has no fragment, so cutting at the first '#' cannot truncate a real value.
    private static readonly Regex s_configComment = new(@"(?<=^|\s)[#;].*$", RegexOptions.Multiline);

    // Every URL in the file, whatever syntax holds it. This is what makes the scan independent of
    // each format's grammar: TOML single- vs double-quoted strings, YAML flow style such as
    // `npmScopes: { types: { npmRegistryServer: "..." } }`, and values trailed by inline comments
    // all match, where a key-anchored line regex silently misses them. None of these config files
    // has a setting that legitimately holds some other URL, so flagging every one is fail-closed
    // rather than over-broad.
    private static readonly Regex s_configUrl = new(@"https?://[^\s'"",\]}]+");

    private const string ApprovedNpmRegistry = "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/";

    /// <summary>
    /// A lockfile value is treated as a remote acquisition only when it names a scheme with an
    /// authority. That excludes the intra-lockfile references every format uses for local packages —
    /// npm's <c>"resolved": "node_modules/foo"</c>, Bun's <c>"pkg@workspace:packages/foo"</c>, and
    /// Yarn's <c>"pkg@npm:1.0.0"</c> — while still catching non-HTTP origins such as
    /// <c>git+ssh://git@github.com/...</c>, which a scheme-specific check would let through.
    /// </summary>
    private const string RemoteReferenceMarker = "://";

    /// <summary>
    /// Points every npm-ecosystem package manager at the approved feed. It is asserted on here,
    /// rather than only in the workflow, because it is the sole enforcement point for the acquisition
    /// paths whose lockfiles pin no tarball URLs.
    /// </summary>
    private const string PolyglotValidationDirectory = ".github/workflows/polyglot-validation";
    private const string RegistryEnvScriptName = "npm-registry-env.sh";
    private const string RegistryEnvScriptPath = $"{PolyglotValidationDirectory}/{RegistryEnvScriptName}";

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

    /// <summary>
    /// The lockfile names each package manager writes, and which the theories above parse.
    /// </summary>
    private static readonly string[] s_recognizedLockfileNames =
    [
        "package-lock.json",
        "bun.lock",
        "pnpm-lock.yaml",
        "yarn.lock",
    ];

    /// <summary>
    /// Lockfiles belonging to ecosystems this guard is not about. Named explicitly so that skipping
    /// them is a decision on the record rather than a pattern that happens not to match.
    /// </summary>
    private static readonly string[] s_ignoredLockfilePatterns = ["pylock.*.toml"];

    /// <summary>
    /// Fails when a fixture introduces a lockfile format none of the theories above parse.
    /// </summary>
    /// <remarks>
    /// The four theories each ask for a filename they already know how to read, so adding a package
    /// manager to the polyglot fixtures — Deno, or Bun's binary bun.lockb — would add an acquisition
    /// path that no theory enumerates and nothing would go red. That is the same failure this PR is
    /// about: a guard that silently stops covering what it is supposed to cover. Discovering
    /// lockfile-shaped files and requiring each to be claimed turns "unparsed" into a build break.
    /// </remarks>
    [Fact]
    public void PolyglotFixtures_ContainNoLockfileFormatThisGuardCannotParse()
    {
        var unrecognized = EnumeratePolyglotFiles()
            .Where(path => IsLockfileShaped(Path.GetFileName(path)))
            .Where(path => !s_recognizedLockfileNames.Contains(Path.GetFileName(path), StringComparer.Ordinal))
            .Select(path => Path.GetRelativePath(RepoRoot.Path, path).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal([], unrecognized);
    }

    /// <summary>
    /// Fails when a polyglot fixture ships package-manager config that redirects acquisition.
    /// </summary>
    /// <remarks>
    /// npm-registry-env.sh verifies the environment from a directory owned by no project, because a
    /// package manager refuses to answer config questions inside a project claimed by a different
    /// one. That leaves per-project .npmrc and .yarnrc.yml unchecked at runtime, and project config
    /// outranks the environment for npm and pnpm, so a fixture could opt itself back onto the public
    /// registry. Asserting it here covers the half the preflight structurally cannot.
    /// </remarks>
    [Fact]
    public void PolyglotFixtures_DoNotOverrideTheRegistry()
    {
        var overrides = EnumeratePolyglotFiles()
            .SelectMany(path => FindRegistryOverrides(path)
                .Select(finding => $"{Path.GetRelativePath(RepoRoot.Path, path).Replace(Path.DirectorySeparatorChar, '/')} -> {finding}"))
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal([], overrides);
    }

    /// <summary>
    /// Fails when a polyglot fixture that ships no lockfile declares a dependency as a version range.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A fixture with a lockfile installs the exact versions the lockfile records. A fixture without
    /// one resolves every range afresh and takes the newest matching version the registry advertises,
    /// which is precisely the version an Azure Artifacts mirror is least likely to have ingested. The
    /// approved dotnet-public-npm feed serves only versions it has already ingested and answers 401 —
    /// not 404 — for the rest, and its packument advertises versions whose tarballs it cannot hand
    /// out, so the two disagree.
    /// </para>
    /// <para>
    /// Measured against the approved feed on 2026-08-09, installing
    /// tests/PolyglotAppHosts/Aspire.Hosting.Blazor/TypeScript, whose <c>tsx: "^4.22.3"</c> resolved
    /// to 4.23.5: <c>GET /tsx/-/tsx-4.23.1.tgz</c> returned 200 while
    /// <c>GET /tsx/-/tsx-4.23.5.tgz</c> returned 401, and <c>npm install</c> failed with
    /// <c>npm error code E401</c>. Nothing in the fixture changed — an upstream publish was enough.
    /// An exact version cannot drift onto an un-ingested release, so a lockfile-less fixture has to
    /// carry one.
    /// </para>
    /// <para>
    /// PolyglotFixtures_DeclareOnlyRegistryDependencySpecs covers a different failure for every
    /// fixture: a spec that leaves the registry entirely. This one is about a spec that stays on the
    /// registry but does not say which version it lands on.
    /// </para>
    /// </remarks>
    [Fact]
    public void PolyglotFixtures_WithoutALockfile_PinExactDependencyVersions()
    {
        var floating = EnumeratePolyglotFiles()
            .Where(path => Path.GetFileName(path) == "package.json")
            .Where(path => !s_recognizedLockfileNames.Any(lockfileName =>
                File.Exists(Path.Combine(Path.GetDirectoryName(path)!, lockfileName))))
            .SelectMany(path => ReadDependencySpecs(path)
                .Where(dependency => !IsPinnedDependencySpec(dependency.Value))
                .Select(dependency => $"{Path.GetRelativePath(RepoRoot.Path, path).Replace(Path.DirectorySeparatorChar, '/')} -> \"{dependency.Key}\": \"{dependency.Value}\""))
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal([], floating);
    }

    /// <summary>
    /// The scan above only ever runs against fixtures that are already correct, so drive the
    /// classifier with the spec forms a package.json can carry.
    /// </summary>
    [Theory]
    [InlineData("4.22.3", true)]
    [InlineData("4.22.3-beta.1", true)]
    [InlineData("6.0.3+build.7", true)]
    // Resolved from the checkout, never from the registry, so no upstream publish can move them.
    [InlineData("workspace:*", true)]
    [InlineData("file:../local-package", true)]
    [InlineData("link:../local-package", true)]
    [InlineData("portal:../local-package", true)]
    // Everything below leaves the landed version up to whatever the registry advertises at install
    // time.
    [InlineData("^4.22.3", false)]
    [InlineData("~4.22.3", false)]
    [InlineData(">=4.22.3", false)]
    [InlineData(">=1.0.0 <2.0.0", false)]
    [InlineData("4.x", false)]
    [InlineData("4.22", false)]
    [InlineData("*", false)]
    [InlineData("", false)]
    [InlineData("latest", false)]
    // An alias still resolves through the registry, and the range rides along inside it.
    [InlineData("npm:@types/node@^20.0.0", false)]
    public void PinnedDependencySpecScan_RecognizesEveryVersionForm(string spec, bool expectedPinned)
    {
        Assert.Equal(expectedPinned, IsPinnedDependencySpec(spec));
    }

    /// <summary>
    /// An npm version with no range operator: <c>4.22.3</c> matches, while <c>^4.22.3</c>,
    /// <c>~4.22.3</c>, <c>4.x</c>, <c>&gt;=4.22.3</c> and <c>*</c> do not. Prerelease and build
    /// metadata are allowed because they still name a single exact version.
    /// </summary>
    private static readonly Regex s_exactNpmVersion = new(
        @"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// Protocol-prefixed specs that resolve from the checkout rather than the registry, so an
    /// upstream publish cannot change what they install.
    /// </summary>
    private static readonly string[] s_localDependencyPrefixes = ["workspace:", "file:", "link:", "portal:"];

    /// <summary>
    /// True when a dependency spec names exactly one version, so the same install is reproducible
    /// without a lockfile.
    /// </summary>
    private static bool IsPinnedDependencySpec(string spec)
    {
        var trimmed = spec.Trim();

        return s_exactNpmVersion.IsMatch(trimmed) ||
            s_localDependencyPrefixes.Any(prefix => trimmed.StartsWith(prefix, StringComparison.Ordinal));
    }

    /// <summary>
    /// The scan above only ever runs against fixtures that are already correct, so it would keep
    /// passing if it stopped recognizing a config format. Feed it each format directly.
    /// </summary>
    [Theory]
    [InlineData(".npmrc", "registry=https://registry.npmjs.org/", true)]
    [InlineData(".npmrc", "@types:registry=https://scoped.example.invalid/", true)]
    [InlineData(".npmrc", "registry=APPROVED_FEED", false)]
    [InlineData(".yarnrc.yml", "npmRegistryServer: \"https://registry.yarnpkg.com\"", true)]
    // bunfig.toml names a scope with the bare scope name and no `registry` word at all, so a
    // key-based pattern cannot see it.
    [InlineData("bunfig.toml", "[install.scopes]\n\"types\" = \"https://scoped.example.invalid/\"", true)]
    [InlineData("bunfig.toml", "[install.scopes]\n\"types\" = { url = \"https://scoped.example.invalid/\" }", true)]
    [InlineData("bunfig.toml", "[install]\nregistry = \"APPROVED_FEED\"", false)]
    [InlineData("bunfig.toml", "# registry = \"https://registry.npmjs.org/\"", false)]
    [InlineData("bunfig.toml", "[install.scopes]\ntypes = 'https://scoped.example.invalid/'", true)]
    [InlineData(".yarnrc.yml", "npmScopes: { types: { npmRegistryServer: \"https://registry.yarnpkg.com\" } }", true)]
    [InlineData(".yarnrc.yml", "npmRegistryServer: \"https://registry.yarnpkg.com\" # inline comment", true)]
    [InlineData(".yarnrc.yml", "npmRegistryServer: \"APPROVED_FEED\" # inline comment", false)]
    [InlineData(".yarnrc.yml", "nodeLinker: node-modules", false)]
    [InlineData(".npmrc", "registry=APPROVED_FEED ; trailing comment", false)]
    [InlineData(".yarnrc.yml", "# npmRegistryServer: \"https://registry.npmjs.org\"\nnodeLinker: node-modules", false)]
    [InlineData(".npmrc", "; registry=https://registry.npmjs.org/\nregistry=APPROVED_FEED", false)]
    public void RegistryOverrideScan_RecognizesEveryConfigFormat(string fileName, string content, bool expectedOverride)
    {
        var workspace = Directory.CreateTempSubdirectory("aspire-registry-override-scan");

        try
        {
            var path = Path.Combine(workspace.FullName, fileName);
            File.WriteAllText(path, content.Replace("APPROVED_FEED", ApprovedNpmRegistry, StringComparison.Ordinal) + "\n");

            var findings = FindRegistryOverrides(path).ToArray();

            Assert.True(
                expectedOverride == (findings.Length > 0),
                $"{fileName} containing '{content}' should{(expectedOverride ? "" : " not")} be reported as a registry override, but the scan returned [{string.Join(", ", findings)}].");
        }
        finally
        {
            workspace.Delete(recursive: true);
        }
    }

    /// <summary>
    /// Reports every registry value in a package-manager config file that is not the approved feed.
    /// </summary>
    /// <remarks>
    /// npm and Yarn name the setting, so those are matched by key: an .npmrc `registry=` or
    /// `@scope:registry=`, and a .yarnrc.yml `npmRegistryServer:` /
    /// `npmScopes.&lt;scope&gt;.npmRegistryServer:`. bunfig.toml does not — a scope entry is the bare
    /// scope name assigned either a URL or a table containing one — so every quoted URL outside a
    /// comment is flagged there instead. Bun's config has no setting that legitimately holds some
    /// other URL, so that is fail-closed rather than over-broad.
    /// </remarks>
    private static IEnumerable<string> FindRegistryOverrides(string path)
    {
        var fileName = Path.GetFileName(path);

        if (fileName is not (".npmrc" or ".yarnrc" or ".yarnrc.yml" or "bunfig.toml" or ".bunfig.toml"))
        {
            return [];
        }

        var text = File.ReadAllText(path);

        var uncommented = s_configComment.Replace(text, string.Empty);

        // Two passes, unioned. The URL pass is the general one and catches values a key-anchored
        // regex cannot reach; the key pass additionally catches a registry setting whose value is
        // not a URL at all, such as `registry=localhost:4873`.
        var urlFindings = s_configUrl.Matches(uncommented)
            .Where(match => !IsApprovedFeedUrl(match.Value))
            .Select(match => match.Value);

        var keyFindings = s_registryKey.Matches(uncommented)
            .Where(match => !IsApprovedFeedUrl(match.Groups["value"].Value.Trim('"', '\'')))
            .Select(match => match.Value.Trim());

        return urlFindings.Concat(keyFindings).Distinct(StringComparer.Ordinal).ToArray();
    }

    /// <summary>
    /// A dependency spec can name a remote source directly - a tarball URL, a git remote, a GitHub
    /// shorthand - and every package manager honours it whatever the configured registry is. The
    /// registry guards therefore do not cover it, and neither does the lockfile guard for a fixture
    /// such as Aspire.Hosting.Blazor/TypeScript that ships no lockfile at all.
    /// </summary>
    /// <remarks>
    /// This covers the override sections as well as the dependency sections, because an
    /// <c>overrides</c>, <c>resolutions</c> or <c>pnpm.overrides</c> entry rewrites the spec of a
    /// package anywhere in the resolved tree using the same grammar. That path bypasses a lockfile
    /// too: a package manager re-resolves when package.json and the lockfile disagree, so a remote
    /// spec added to an override takes effect in a fixture that ships a lockfile just as it does in
    /// one that does not.
    /// </remarks>
    [Fact]
    public void PolyglotFixtures_DeclareOnlyRegistryDependencySpecs()
    {
        var remoteSpecs = EnumeratePolyglotFiles()
            .Where(path => Path.GetFileName(path) == "package.json")
            .SelectMany(path => ReadDependencySpecs(path)
                .Where(dependency => !IsRegistryDependencySpec(dependency.Value))
                .Select(dependency => $"{Path.GetRelativePath(RepoRoot.Path, path).Replace(Path.DirectorySeparatorChar, '/')} -> \"{dependency.Key}\": \"{dependency.Value}\""))
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal([], remoteSpecs);
    }

    /// <summary>
    /// The scan above only ever runs against fixtures that are already correct, so drive the
    /// classifier with the spec forms npm, Yarn, pnpm and bun accept.
    /// </summary>
    [Theory]
    [InlineData("^4.22.3", true)]
    [InlineData("6.0.3", true)]
    [InlineData("~1.2.3", true)]
    [InlineData(">=1.0.0 <2.0.0", true)]
    [InlineData("*", true)]
    [InlineData("", true)]
    [InlineData("workspace:*", true)]
    [InlineData("file:../local-package", true)]
    [InlineData("link:../local-package", true)]
    [InlineData("portal:../local-package", true)]
    [InlineData("npm:@types/node@^20.0.0", true)]
    [InlineData("1.2.3 - 2.3.4", true)]
    [InlineData("^1 || ^2", true)]
    [InlineData("4.x", true)]
    [InlineData("v1.2.3", true)]
    [InlineData(">= 1.0.0", true)]
    // Everything below fetches from somewhere other than the configured registry.
    [InlineData("https://evil.example/pkg.tgz", false)]
    [InlineData("http://evil.example/pkg.tgz", false)]
    [InlineData("git+https://github.com/owner/repo.git", false)]
    [InlineData("git+ssh://git@github.com/owner/repo.git", false)]
    [InlineData("git://github.com/owner/repo.git", false)]
    [InlineData("github:owner/repo", false)]
    [InlineData("gitlab:owner/repo", false)]
    [InlineData("bitbucket:owner/repo", false)]
    [InlineData("owner/repo", false)]
    [InlineData("owner/repo#semver:^1.0.0", false)]
    // A GitHub owner may begin with a digit or a "v", so a shorthand can look like the start of a
    // semver range. npm-package-arg resolves every one of these as type=git, registry=false.
    [InlineData("0xproject/repo", false)]
    [InlineData("1owner/repo", false)]
    [InlineData("9front/thing#semver:^1.0.0", false)]
    [InlineData("v8/repo", false)]
    // A relative or home-anchored path is a directory dependency, not a registry one.
    [InlineData("./local-package", false)]
    [InlineData("../local-package", false)]
    [InlineData("~/local-package", false)]
    // An alias that names no version resolves the `latest` dist-tag.
    [InlineData("npm:@types/node", false)]
    // A dist-tag resolves through the registry, but which version it lands on is not pinned by
    // anything in the repository, so it is not a spec a guarded fixture should carry either.
    [InlineData("latest", false)]
    [InlineData("next", false)]
    public void DependencySpecScan_RejectsSpecsThatBypassTheRegistry(string spec, bool expectedAcceptable)
    {
        Assert.Equal(expectedAcceptable, IsRegistryDependencySpec(spec));
    }

    /// <summary>
    /// The scan above judges only the specs it is handed, so prove the reader hands it every section
    /// a package.json can put one in.
    /// </summary>
    /// <remarks>
    /// Before this covered the override sections, the fixtures already carried 57 override entries
    /// that no guard read at all — an <c>overrides</c> entry naming a tarball URL rewrites the spec of
    /// a package anywhere in the resolved tree and is installed from that URL, whether or not the
    /// fixture ships a lockfile.
    /// </remarks>
    [Fact]
    public void DependencySpecReader_ReadsEverySectionThatCanCarryASpec()
    {
        const string content = """
            {
              "name": "fixture",
              "dependencies": { "a": "1.0.0" },
              "devDependencies": { "b": "2.0.0" },
              "optionalDependencies": { "c": "3.0.0" },
              "peerDependencies": { "d": "4.0.0" },
              "overrides": { "e": "5.0.0", "f": { ".": "6.0.0", "g": "7.0.0" } },
              "resolutions": { "**/h": "8.0.0" },
              "pnpm": { "overrides": { "i": "9.0.0" } }
            }
            """;

        Assert.Equal(
            [
                "dependencies.a=1.0.0",
                "devDependencies.b=2.0.0",
                "optionalDependencies.c=3.0.0",
                "peerDependencies.d=4.0.0",
                "overrides.e=5.0.0",
                "overrides.f=6.0.0",
                "overrides.f.g=7.0.0",
                "resolutions.**/h=8.0.0",
                "pnpm.overrides.i=9.0.0",
            ],
            ReadDependencySpecsFromContent(content).Select(spec => $"{spec.Key}={spec.Value}").ToArray());
    }

    /// <summary>
    /// The package.json sections that map a package name straight to a dependency spec.
    /// </summary>
    private static readonly string[] s_dependencySections =
        ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

    /// <summary>
    /// The package.json sections that rewrite the spec of a package somewhere in the tree. npm reads
    /// <c>overrides</c>, Yarn reads <c>resolutions</c>, and pnpm reads <c>pnpm.overrides</c>. Each
    /// takes the same spec grammar as a dependency, so each can name a remote source.
    /// </summary>
    private static readonly string[] s_overrideSections = ["overrides", "resolutions"];

    /// <summary>
    /// Every section of a fixture package.json that this guard reads, plus the metadata keys that
    /// cannot carry a dependency spec at all.
    /// </summary>
    private static readonly string[] s_specFreePackageJsonKeys =
    [
        "name", "version", "description", "private", "type", "license", "author", "keywords",
        "main", "module", "types", "exports", "files", "bin", "browser", "scripts", "engines",
        "workspaces", "packageManager",
    ];

    /// <summary>
    /// The keys this guard reads inside the <c>pnpm</c> section.
    /// </summary>
    private static readonly string[] s_readPnpmKeys = ["overrides"];

    /// <summary>
    /// Fails when a fixture package.json carries a section this guard does not read.
    /// </summary>
    /// <remarks>
    /// PolyglotFixtures_DeclareOnlyRegistryDependencySpecs can only judge specs it is handed, so its
    /// coverage is exactly the set of sections ReadDependencySpecs walks. package.json keeps growing
    /// sections that carry the same spec grammar — <c>overrides</c>, <c>resolutions</c>,
    /// <c>pnpm.overrides</c>, <c>pnpm.packageExtensions</c> — and a spec placed in one this guard has
    /// not learned about is installed exactly the same way while nothing goes red. Naming the keys
    /// that provably cannot carry a spec, and failing on everything else, means a new section has to
    /// be classified deliberately instead of arriving unnoticed.
    ///
    /// When this fails: if the new key cannot name a package, add it to
    /// <see cref="s_specFreePackageJsonKeys"/>; otherwise teach <see cref="ReadDependencySpecs"/> to
    /// walk it.
    /// </remarks>
    [Fact]
    public void PolyglotFixtures_DeclareOnlyPackageJsonSectionsThisGuardReads()
    {
        var unread = EnumeratePolyglotFiles()
            .Where(path => Path.GetFileName(path) == "package.json")
            .SelectMany(path => FindUnreadPackageJsonSections(File.ReadAllText(path))
                .Select(section => $"{Path.GetRelativePath(RepoRoot.Path, path).Replace(Path.DirectorySeparatorChar, '/')} -> {section}"))
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal([], unread);
    }

    /// <summary>
    /// The scan above only ever runs against fixtures that are already correct, so drive it with the
    /// sections a package.json can carry.
    /// </summary>
    [Theory]
    [InlineData("""{"name":"x","version":"1.0.0","scripts":{"build":"tsc"}}""", "")]
    [InlineData("""{"dependencies":{"a":"1.0.0"},"devDependencies":{"b":"1.0.0"}}""", "")]
    [InlineData("""{"overrides":{"a":"1.0.0"},"resolutions":{"b":"1.0.0"}}""", "")]
    [InlineData("""{"pnpm":{"overrides":{"a":"1.0.0"}}}""", "")]
    // A section that carries the same spec grammar but that ReadDependencySpecs does not walk.
    [InlineData("""{"bundleDependencies":["a"]}""", "bundleDependencies")]
    [InlineData("""{"peerDependenciesMeta":{"a":{"optional":true}}}""", "peerDependenciesMeta")]
    [InlineData("""{"pnpm":{"packageExtensions":{"a":{"dependencies":{"b":"1.0.0"}}}}}""", "pnpm.packageExtensions")]
    [InlineData("""{"pnpm":{"patchedDependencies":{"a@1.0.0":"patches/a.patch"}}}""", "pnpm.patchedDependencies")]
    public void PackageJsonSectionScan_FlagsEverySectionItDoesNotRead(string content, string expectedUnread)
    {
        var expected = expectedUnread.Length == 0 ? [] : expectedUnread.Split(',');

        Assert.Equal(expected, FindUnreadPackageJsonSections(content).ToArray());
    }

    private static IEnumerable<string> FindUnreadPackageJsonSections(string content)
    {
        using var document = JsonDocument.Parse(content);

        foreach (var property in document.RootElement.EnumerateObject())
        {
            if (s_specFreePackageJsonKeys.Contains(property.Name, StringComparer.Ordinal) ||
                s_dependencySections.Contains(property.Name, StringComparer.Ordinal) ||
                s_overrideSections.Contains(property.Name, StringComparer.Ordinal))
            {
                continue;
            }

            if (property.Name != "pnpm")
            {
                yield return property.Name;
                continue;
            }

            foreach (var pnpmProperty in property.Value.EnumerateObject())
            {
                if (!s_readPnpmKeys.Contains(pnpmProperty.Name, StringComparer.Ordinal))
                {
                    yield return $"pnpm.{pnpmProperty.Name}";
                }
            }
        }
    }

    /// <summary>
    /// Reads every dependency spec a package.json declares, across the dependency sections and the
    /// override sections that rewrite specs elsewhere in the tree.
    /// </summary>
    private static IEnumerable<KeyValuePair<string, string>> ReadDependencySpecs(string path)
        => ReadDependencySpecsFromContent(File.ReadAllText(path));

    private static IEnumerable<KeyValuePair<string, string>> ReadDependencySpecsFromContent(string content)
    {
        using var document = JsonDocument.Parse(content);

        foreach (var section in s_dependencySections)
        {
            if (!document.RootElement.TryGetProperty(section, out var dependencies) || dependencies.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            foreach (var dependency in dependencies.EnumerateObject())
            {
                yield return new KeyValuePair<string, string>($"{section}.{dependency.Name}", dependency.Value.GetString() ?? string.Empty);
            }
        }

        foreach (var section in s_overrideSections)
        {
            if (document.RootElement.TryGetProperty(section, out var overrides))
            {
                foreach (var entry in ReadOverrideSpecs(section, overrides))
                {
                    yield return entry;
                }
            }
        }

        if (!document.RootElement.TryGetProperty("pnpm", out var pnpm) || pnpm.ValueKind != JsonValueKind.Object)
        {
            yield break;
        }

        foreach (var section in s_overrideSections)
        {
            if (pnpm.TryGetProperty(section, out var pnpmOverrides))
            {
                foreach (var entry in ReadOverrideSpecs($"pnpm.{section}", pnpmOverrides))
                {
                    yield return entry;
                }
            }
        }
    }

    /// <summary>
    /// Walks an override section, which nests: a value is either a spec or an object of nested
    /// overrides whose "." key is the spec for the package named by the enclosing key.
    /// </summary>
    /// <remarks>
    /// <code>
    /// "overrides": {
    ///   "brace-expansion": "5.0.8",
    ///   "foo": { ".": "1.2.3", "bar": "2.0.0" }
    /// }
    /// </code>
    /// See https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides.
    /// </remarks>
    private static IEnumerable<KeyValuePair<string, string>> ReadOverrideSpecs(string prefix, JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            yield break;
        }

        foreach (var property in element.EnumerateObject())
        {
            // "." names the enclosing package rather than a new one, so it does not extend the path.
            var name = property.Name == "." ? prefix : $"{prefix}.{property.Name}";

            if (property.Value.ValueKind == JsonValueKind.Object)
            {
                foreach (var nested in ReadOverrideSpecs(name, property.Value))
                {
                    yield return nested;
                }

                continue;
            }

            yield return new KeyValuePair<string, string>(name, property.Value.GetString() ?? string.Empty);
        }
    }

    /// <summary>
    /// One semver comparator: an optional operator, an optional <c>v</c>, then a partial version
    /// whose parts may be digits or an <c>x</c>/<c>*</c> wildcard, with optional prerelease and build
    /// metadata. See https://github.com/npm/node-semver#ranges.
    /// </summary>
    private const string SemverComparatorPattern =
        @"(?:\^|~>?|>=?|<=?|=)?\s*v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?";

    /// <summary>
    /// A full semver range: comparators joined by whitespace or a hyphen range, and comparator sets
    /// joined by <c>||</c>. Matches <c>^4.22.3</c>, <c>&gt;=1.0.0 &lt;2.0.0</c>, <c>1.2.3 - 2.3.4</c>,
    /// <c>4.x</c> and <c>^1 || ^2</c>, and nothing containing a path, scheme or host.
    /// </summary>
    private static readonly Regex s_semverRange = new(
        $@"^{SemverComparatorPattern}(?:(?:\s*-\s*|\s+){SemverComparatorPattern})*(?:\s*\|\|\s*{SemverComparatorPattern}(?:(?:\s*-\s*|\s+){SemverComparatorPattern})*)*$",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// True when a dependency spec resolves through the configured registry at a version the
    /// repository pins.
    /// </summary>
    /// <remarks>
    /// An allow-list rather than a deny-list, because the set of remote spec forms keeps growing -
    /// `github:`, `gitlab:`, `bitbucket:`, a bare `owner/repo` shorthand, `git+ssh://`, a plain
    /// tarball URL - while the set of forms a pinned fixture legitimately needs does not. A
    /// dist-tag such as `latest` does go through the registry, but nothing in the repository pins
    /// which version it lands on, so it is excluded for the same reason.
    /// See https://docs.npmjs.com/cli/v11/configuring-npm/package-json#dependencies.
    ///
    /// The spec has to parse as a whole semver range, not merely start like one. Testing only the
    /// first character accepted `0xproject/repo`, which npm-package-arg resolves as
    /// `type=git, registry=false, hosted=github` — a GitHub clone that never touches the configured
    /// registry — because a GitHub owner may begin with a digit. Requiring the entire spec to match
    /// the range grammar rejects it, along with any other shorthand whose owner happens to start with
    /// a digit or a `v`.
    /// </remarks>
    private static bool IsRegistryDependencySpec(string spec)
    {
        var trimmed = spec.Trim();

        if (trimmed.Length == 0)
        {
            return true;
        }

        if (s_localDependencyPrefixes.Any(prefix => trimmed.StartsWith(prefix, StringComparison.Ordinal)))
        {
            return true;
        }

        // An alias resolves through the registry, but only when it names a version: `npm:<name>@<range>`.
        // npm-package-arg rejects an alias whose subspec is not a registry spec, so the range is the
        // only part that still needs checking. Bare `npm:<name>` means the `latest` dist-tag.
        if (trimmed.StartsWith("npm:", StringComparison.Ordinal))
        {
            var aliased = trimmed["npm:".Length..];
            var separator = aliased.LastIndexOf('@');

            return separator > 0 && s_semverRange.IsMatch(aliased[(separator + 1)..]);
        }

        return s_semverRange.IsMatch(trimmed);
    }

    /// <summary>
    /// A file is lockfile-shaped when its name ends in .lock/.lockb, or pairs a "lock" or
    /// "shrinkwrap" word with a data extension — package-lock.json, pnpm-lock.yaml,
    /// npm-shrinkwrap.json. Deliberately broader than the recognized set so a new format is caught.
    /// </summary>
    private static bool IsLockfileShaped(string fileName)
    {
        if (s_ignoredLockfilePatterns.Any(pattern => FileSystemName.MatchesSimpleExpression(pattern, fileName)))
        {
            return false;
        }

        if (fileName.EndsWith(".lock", StringComparison.OrdinalIgnoreCase) ||
            fileName.EndsWith(".lockb", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return (fileName.Contains("lock", StringComparison.OrdinalIgnoreCase) ||
                fileName.Contains("shrinkwrap", StringComparison.OrdinalIgnoreCase)) &&
               Path.GetExtension(fileName) is ".json" or ".yaml" or ".yml" or ".toml";
    }

    private static IEnumerable<string> EnumeratePolyglotFiles()
    {
        var polyglotRoot = Path.Combine(RepoRoot.Path, "tests", "PolyglotAppHosts");

        return Directory.EnumerateFiles(polyglotRoot, "*", SearchOption.AllDirectories)
            .Where(path => !path.Split(Path.DirectorySeparatorChar).Contains("node_modules", StringComparer.Ordinal));
    }

    /// <summary>
    /// Records which shipped lockfiles still resolve through an unapproved registry, so the gap is
    /// visible and bounded rather than implicit.
    /// </summary>
    /// <remarks>
    /// The theory above guards a named set, which cannot notice a lockfile that was never added to
    /// it. Every `package-lock.json` under src/ ships to users, so this discovers them from disk and
    /// pins both the exact set that is not yet on the approved feed and the exact origins each one is
    /// still allowed to use.
    ///
    /// Pinning the paths alone is not enough: an allow-list keyed only on file path would stay green
    /// if someone swapped registry.npmjs.org for an arbitrary external host, because the set of
    /// offending files would not change. Recording the origins means the only tolerated drift is the
    /// drift that already exists — a new host in any of these files fails immediately.
    ///
    /// These four are pre-existing and predate the lockfile guard. Normalizing them means regenerating
    /// against the approved feed, which changes what `aspire new` ships and is deliberately not
    /// bundled into this change. Normalizing one makes this fail until its entry is removed; adding a
    /// new unnormalized lockfile fails immediately.
    /// </remarks>
    [Fact]
    public void ShippedLockfiles_NotYetOnTheApprovedFeed_UseExactlyTheKnownOrigins()
    {
        var sourceRoot = Path.Combine(RepoRoot.Path, "src");

        var unnormalized = Directory.EnumerateFiles(sourceRoot, "package-lock.json", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}node_modules{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Select(path => (
                Path: Path.GetRelativePath(RepoRoot.Path, path).Replace(Path.DirectorySeparatorChar, '/'),
                Origins: OriginsOf(ScanNpmLockfile(File.ReadAllText(path)).Offenders)))
            .Where(entry => entry.Origins.Length > 0)
            .OrderBy(entry => entry.Path, StringComparer.Ordinal)
            .ToDictionary(entry => entry.Path, entry => entry.Origins, StringComparer.Ordinal);

        var expected = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["src/Aspire.Cli/Templating/Templates/java-starter/frontend/package-lock.json"] = ["https://registry.npmjs.org"],
            ["src/Aspire.Cli/Templating/Templates/py-starter/frontend/package-lock.json"] = ["https://registry.npmjs.org"],
            ["src/Aspire.Cli/Templating/Templates/ts-starter/frontend/package-lock.json"] = ["https://registry.npmjs.org"],
            ["src/Aspire.ProjectTemplates/templates/aspire-ts-cs-starter/frontend/package-lock.json"] = ["https://ms-feed-2.pkgs.visualstudio.com"],
        };

        Assert.Equal(expected.Keys.Order(StringComparer.Ordinal), unnormalized.Keys.Order(StringComparer.Ordinal));

        foreach (var (path, origins) in expected)
        {
            Assert.Equal(origins, unnormalized[path]);
        }
    }

    /// <summary>
    /// Reduces offending references to their distinct scheme+authority so the expectation records
    /// where a lockfile still resolves from without pinning every individual package URL.
    /// </summary>
    /// <remarks>
    /// Offenders are recorded as "&lt;entry name&gt; -&gt; &lt;url&gt;", for example:
    ///   node_modules/@emnapi/core -&gt; https://registry.npmjs.org/@emnapi/core/-/core-1.5.0.tgz
    /// The entry name can itself contain "-" and "&gt;", so split on the first " -&gt; " only.
    /// </remarks>
    private static string[] OriginsOf(IReadOnlyList<string> offenders)
    {
        const string ReferenceSeparator = " -> ";

        var origins = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var offender in offenders)
        {
            var separatorIndex = offender.IndexOf(ReferenceSeparator, StringComparison.Ordinal);
            var url = separatorIndex < 0 ? offender : offender[(separatorIndex + ReferenceSeparator.Length)..];

            // An offender that is not a well-formed absolute URI is still drift, so surface it
            // verbatim rather than dropping it and shrinking the recorded set.
            origins.Add(Uri.TryCreate(url, UriKind.Absolute, out var uri)
                ? uri.GetLeftPart(UriPartial.Authority)
                : url);
        }

        return [.. origins];
    }

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

    /// <summary>
    /// A lockfile can only pin the feed for packages it already records, and two acquisition paths in
    /// the polyglot job are not covered by the theories above at all.
    /// tests/PolyglotAppHosts/Aspire.Hosting.Blazor/TypeScript has no lockfile, so `npm install`
    /// resolves everything remotely, and the Yarn Berry fixture's lockfile stores locators rather than
    /// tarball URLs, so Berry re-resolves through whatever registry is configured. For those, the
    /// install-time registry configuration is the only thing standing between CI and the public
    /// registry.
    /// </summary>
    /// <remarks>
    /// The repository-root .npmrc does not cover them: npm resolves project config from
    /// `localPrefix`, the nearest ancestor containing package.json or node_modules, which for every
    /// AppHost is the AppHost directory itself. Environment variables outrank project config, so
    /// exporting them is what actually reaches the AppHosts.
    /// </remarks>
    [Fact]
    public void RegistryEnvScript_ExportsTheApprovedRegistryForEveryPackageManager()
    {
        var script = ReadRepoFile(RegistryEnvScriptPath);

        // Each manager reads a different setting and they are not interchangeable — Yarn Berry
        // ignores npm_config_registry, and npm ignores YARN_NPM_REGISTRY_SERVER — so assert on the
        // whole set rather than on any one of them.
        Assert.Equal(
            new[]
            {
                "BUN_CONFIG_REGISTRY",
                "NPM_CONFIG_REGISTRY",
                "YARN_NPM_REGISTRY_SERVER",
                "npm_config_registry",
            },
            ExportedRegistryVariables(script));

        // Corepack is the exception: it cannot be pointed at the approved feed at all. Azure
        // Artifacts answers 404 for the `/<package>/<version>` metadata route corepack calls (see
        // the npm mirror note in extension/CONTRIBUTING.md), and yarn is not fetched over npm in the
        // first place — corepack 0.34.7 resolving `packageManager: yarn@3.6.4` reports
        // `can't reach https://repo.yarnpkg.com/3.6.4/packages/yarnpkg-cli/bin/yarn.js`. Exporting
        // COREPACK_NPM_REGISTRY would therefore claim coverage it does not have while leaving the
        // yarn path pointed at a public host, so the script must forbid hydration instead.
        // The assertion above already fails if COREPACK_NPM_REGISTRY comes back, because it would
        // appear in the exported set; this is the other half, that hydration is actually forbidden.
        Assert.Matches(@"(?m)^export COREPACK_ENABLE_NETWORK=0$", script);
    }

    /// <summary>
    /// Fails if the helper stops isolating npm from ambient user- and global-level config.
    /// </summary>
    /// <remarks>
    /// `registry` sets the default only. A `@scope:registry` key is a separate setting that wins for
    /// that scope, and neither npm_config_registry nor `npm --registry` overrides it. Measured with
    /// npm 11.4.2, a user-level `@types:registry=https://scoped.example.invalid/` sent
    /// `npm install @types/node` to that host while `npm config get registry` still reported the
    /// approved feed. The AppHosts install @types/* and @esbuild/*, so pointing both config paths at
    /// files the helper owns is what keeps an ambient scoped key from redirecting them.
    /// </remarks>
    [Fact]
    public void RegistryEnvScript_IsolatesNpmFromAmbientScopedRegistries()
    {
        var script = ReadRepoFile(RegistryEnvScriptPath);

        var isolatingExports = Regex.Matches(script, @"^export (?<name>NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG))=", RegexOptions.Multiline)
            .Select(match => match.Groups["name"].Value)
            .Order(StringComparer.Ordinal);

        Assert.Equal(new[] { "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_USERCONFIG" }, isolatingExports);

        // Isolation alone would not notice a scoped key from a source it does not control, so the
        // helper also enumerates what npm reports and fails on any scope off the approved feed.
        Assert.Contains("@[^:]+:registry", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// Fails if the helper stops checking Yarn's scoped registries, which are a namespace separate
    /// from the top-level registry the other Yarn assertion covers.
    /// </summary>
    /// <remarks>
    /// Measured with Yarn 4.14.1. Berry reads `npmScopes.&lt;scope&gt;.npmRegistryServer` before the
    /// top-level `npmRegistryServer`, and the AppHosts install scoped packages (@types/*, @esbuild/*).
    /// Two behaviours make an unchecked scope fail open: a scope pointing elsewhere is used verbatim,
    /// and a scope that declares no registry does not inherit the configured top-level -- it falls
    /// back to Yarn's built-in https://registry.yarnpkg.com, which YARN_NPM_REGISTRY_SERVER does not
    /// override. With the top level pointed at a bogus host, `yarn npm info @types/node` still
    /// succeeded while unscoped `typescript` failed DNS. No environment variable resets the map, so
    /// the helper has to enumerate it and fail closed.
    /// </remarks>
    [Fact]
    public void RegistryEnvScript_ChecksYarnScopedRegistries()
    {
        var script = ReadRepoFile(RegistryEnvScriptPath);

        Assert.Contains("yarn config get npmScopes --json", script, StringComparison.Ordinal);

        // Reading the map is only half of it: the values have to be compared against the approved
        // feed, and the check has to actually run from the Yarn branch of the preflight.
        Assert.Contains("npmRegistryServer", script, StringComparison.Ordinal);
        Assert.Contains("check_yarn_scoped_registries || failed=1", script, StringComparison.Ordinal);

        // A scope with no npmRegistryServer must be reported as the public registry Yarn actually
        // substitutes, not skipped as "inherits the approved feed".
        Assert.Contains("https://registry.yarnpkg.com", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// Runs the shipped <c>check_yarn_scoped_registries</c> against a stub <c>yarn</c> to prove it
    /// fails closed on every answer that is not an explicit, parseable scope map.
    /// </summary>
    /// <remarks>
    /// The helper reads Yarn's scope map through a wrapper that discards stderr, so a yarn that
    /// exits nonzero and one that is configured with no scopes both arrive as an empty string. Only
    /// the literal <c>undefined</c> means "no scopes"; anything else has to be rejected, or a
    /// renamed setting silently turns the check into a no-op while an ambient scope redirects the
    /// install. Theory data covers the answers in the order they matter: broken, silent, genuinely
    /// empty, redirected, approved.
    /// </remarks>
    [Theory]
    [InlineData("exit 3", 1, "failed")]
    [InlineData("printf ''", 1, "returned nothing")]
    [InlineData("printf 'undefined'", 0, "declares no scoped registries")]
    [InlineData("printf 'not json'", 1, "could not read yarn's npmScopes configuration")]
    [InlineData("""printf '{"types":{"npmRegistryServer":"https://scoped.example.invalid/"}}'""", 1, "instead of the approved feed")]
    [InlineData("""printf '{"types":{"npmRegistryServer":null}}'""", 1, "registry.yarnpkg.com")]
    // APPROVED_FEED is substituted below rather than interpolated here: an attribute argument has
    // to be a constant, and nesting the feed URL inside a raw string literal in an attribute is
    // more fragile than it is worth.
    [InlineData("""printf '{"types":{"npmRegistryServer":"APPROVED_FEED"}}'""", 0, "yarn @types ->")]
    [RequiresTools(["bash", "node"])]
    public async Task RegistryEnvScript_YarnScopeCheckFailsClosed(string yarnStubBody, int expectedExitCode, string expectedOutput)
    {
        var workspace = Directory.CreateTempSubdirectory("aspire-yarn-scope-check");

        try
        {
            var binDirectory = Path.Combine(workspace.FullName, "bin");
            Directory.CreateDirectory(binDirectory);

            var yarnStubPath = Path.Combine(binDirectory, "yarn");
            var yarnStub = yarnStubBody.Replace("APPROVED_FEED", ApprovedNpmRegistry, StringComparison.Ordinal);
            await File.WriteAllTextAsync(yarnStubPath, $"#!/bin/sh\n{yarnStub}\n");
            MakeExecutable(yarnStubPath);

            // The script runs verify_registry_configuration on source, which needs a real toolchain,
            // so lift out just the three functions under test. awk copies them verbatim out of the
            // shipped file - the test executes the same bytes CI does, not a transcription.
            var driverPath = Path.Combine(workspace.FullName, "driver.sh");
            await File.WriteAllTextAsync(driverPath, """
                set -uo pipefail
                APPROVED_NPM_REGISTRY="$1"
                NPM_REGISTRY_CONFIG_DIR="$2"
                script="$3"
                eval "$(awk '/^config_in_neutral_directory\(\)/,/^}/' "$script")"
                eval "$(awk '/^config_in_neutral_directory_strict\(\)/,/^}/' "$script")"
                eval "$(awk '/^check_yarn_scoped_registries\(\)/,/^}$/' "$script")"
                check_yarn_scoped_registries
                """);

            var result = await RunBashAsync(
                driverPath,
                [ApprovedNpmRegistry, workspace.FullName, Path.Combine(RepoRoot.Path, RegistryEnvScriptPath)],
                new Dictionary<string, string?>
                {
                    ["PATH"] = binDirectory + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH")
                });

            Assert.True(
                expectedExitCode == result.ExitCode,
                $"Expected exit code {expectedExitCode} for yarn stub '{yarnStub}' but got {result.ExitCode}.{Environment.NewLine}{result.Output}");
            Assert.Contains(expectedOutput, result.Output, StringComparison.Ordinal);
        }
        finally
        {
            workspace.Delete(recursive: true);
        }
    }

    /// <summary>
    /// Bun ignores <c>NPM_CONFIG_USERCONFIG</c> and <c>BUN_CONFIG_REGISTRY</c> replaces only the
    /// default registry, so the preflight has to take bun's config home away from <c>$HOME</c> and
    /// then fail closed on whatever remains there.
    /// </summary>
    /// <remarks>
    /// Measured with bun 1.3.14 on a project depending on <c>@types/semver</c>, with
    /// <c>@types:registry=http://scoped.example.invalid/</c> in <c>$HOME/.npmrc</c> and
    /// <c>BUN_CONFIG_REGISTRY</c>, <c>npm_config_registry</c> and <c>NPM_CONFIG_USERCONFIG</c> all
    /// pointing at a registry that works: the install fails with
    /// <c>FailedToOpenSocket downloading package manifest @types/semver</c>. Pointing
    /// <c>XDG_CONFIG_HOME</c> at a directory the preflight owns makes the same install succeed, and
    /// pointing it at the directory holding the bad key makes it fail again — so bun reads its
    /// <c>.npmrc</c> and <c>bunfig.toml</c> from <c>XDG_CONFIG_HOME</c> once that is set.
    /// </remarks>
    [Theory]
    [InlineData(".npmrc", "@types:registry=https://scoped.example.invalid/", 1, "instead of the approved feed")]
    [InlineData(".npmrc", "registry=https://registry.npmjs.org/", 1, "https://registry.npmjs.org/")]
    [InlineData(".npmrc", "//pkgs.dev.azure.com/dnceng/:_authToken=not-a-url", 0, "no ambient registry override")]
    [InlineData(".npmrc", "registry=APPROVED_FEED", 0, "no ambient registry override")]
    [InlineData(".bunfig.toml", "[install.scopes]\n\"types\" = \"https://scoped.example.invalid/\"", 1, "scoped.example.invalid")]
    [InlineData(".bunfig.toml", "[install]\nregistry = \"APPROVED_FEED\"", 0, "no ambient registry override")]
    [RequiresTools(["bash"])]
    public async Task RegistryEnvScript_FailsClosedOnAmbientBunRegistryOverride(string fileName, string fileBody, int expectedExitCode, string expectedOutput)
    {
        var workspace = Directory.CreateTempSubdirectory("aspire-bun-ambient-config");

        try
        {
            var fakeHome = Path.Combine(workspace.FullName, "home");
            Directory.CreateDirectory(fakeHome);
            await File.WriteAllTextAsync(
                Path.Combine(fakeHome, fileName),
                fileBody.Replace("APPROVED_FEED", ApprovedNpmRegistry, StringComparison.Ordinal) + "\n");

            // awk lifts the function verbatim out of the shipped script, so the test exercises the
            // same bytes CI runs rather than a transcription of them.
            var driverPath = Path.Combine(workspace.FullName, "driver.sh");
            await File.WriteAllTextAsync(driverPath, """
                set -uo pipefail
                APPROVED_NPM_REGISTRY="$1"
                XDG_CONFIG_HOME="$2"
                script="$3"
                eval "$(awk '/^check_bun_ambient_config\(\)/,/^}$/' "$script")"
                check_bun_ambient_config
                """);

            var result = await RunBashAsync(
                driverPath,
                [ApprovedNpmRegistry, Path.Combine(workspace.FullName, "owned"), Path.Combine(RepoRoot.Path, RegistryEnvScriptPath)],
                new Dictionary<string, string?>
                {
                    ["HOME"] = fakeHome
                });

            Assert.True(
                expectedExitCode == result.ExitCode,
                $"Expected exit code {expectedExitCode} for {fileName} containing '{fileBody}' but got {result.ExitCode}.{Environment.NewLine}{result.Output}");
            Assert.Contains(expectedOutput, result.Output, StringComparison.Ordinal);
        }
        finally
        {
            workspace.Delete(recursive: true);
        }
    }

    /// <summary>
    /// Running the preflight's isolation block has to leave bun looking at a config home the script
    /// owns, holding the approved feed and nothing else.
    /// </summary>
    /// <remarks>
    /// Asserting on the source text would pass for a block that exports the variable without ever
    /// writing the file bun reads, so execute the shipped lines and inspect what they produced.
    /// </remarks>
    [Fact]
    [RequiresTools(["bash"])]
    public async Task RegistryEnvScript_GivesBunAConfigHomeItOwns()
    {
        var workspace = Directory.CreateTempSubdirectory("aspire-bun-config-home");

        try
        {
            var driverPath = Path.Combine(workspace.FullName, "driver.sh");
            await File.WriteAllTextAsync(driverPath, """
                set -uo pipefail
                NPM_REGISTRY="$1"
                script="$2"
                eval "$(awk '/^NPM_REGISTRY_CONFIG_DIR=/,/^export XDG_CONFIG_HOME=/' "$script")"
                echo "OWNED=$([ "$XDG_CONFIG_HOME" = "$NPM_REGISTRY_CONFIG_DIR" ] && echo yes || echo no)"
                echo "NPMRC<<"
                cat "$XDG_CONFIG_HOME/.npmrc"
                echo ">>"
                """);

            var result = await RunBashAsync(
                driverPath,
                [ApprovedNpmRegistry, Path.Combine(RepoRoot.Path, RegistryEnvScriptPath)],
                new Dictionary<string, string?>());

            Assert.True(result.ExitCode == 0, $"Isolation block failed.{Environment.NewLine}{result.Output}");
            Assert.Contains("OWNED=yes", result.Output, StringComparison.Ordinal);

            var npmrc = result.Output
                .Split("NPMRC<<", StringSplitOptions.None)[1]
                .Split(">>", StringSplitOptions.None)[0]
                .Trim();

            Assert.Equal($"registry={ApprovedNpmRegistry}", npmrc);
        }
        finally
        {
            workspace.Delete(recursive: true);
        }
    }

    /// <summary>
    /// The image re-pins every ambient npm scope in the config file it owns, but npm resolves
    /// <c>cli &gt; env &gt; project .npmrc &gt; user .npmrc &gt; global .npmrc &gt; builtin</c>, so an
    /// ambient scope supplied through the environment outranks that write.
    /// </summary>
    /// <remarks>
    /// Measured with npm 11.4.2: with <c>npm_config_@types:registry</c> exported,
    /// <c>npm config list</c> prints the user value followed by <c>; overridden by env</c> and
    /// <c>npm config get @types:registry</c> answers with the environment's host. Writing the
    /// approved value is therefore not proof it won, so the layer has to read each scope back. The
    /// read-back must not be a <c>while read</c> fed by a pipe: that body runs in a subshell where
    /// <c>exit 1</c> ends only the subshell and the RUN still succeeds.
    /// </remarks>
    [Fact]
    public void PolyglotValidationImage_VerifiesTheScopeRepinActuallyWon()
    {
        var dockerfile = ReadRepoFile($"{PolyglotValidationDirectory}/Dockerfile.typescript");

        var readBack = Regex.Match(
            dockerfile,
            """for scope in \$\(npm config list.*?done""",
            RegexOptions.Singleline);

        Assert.True(
            readBack.Success,
            "Dockerfile.typescript re-pins the ambient npm scopes but never reads them back, so an environment-supplied scope silently outranks the re-pin.");

        var body = readBack.Value;

        Assert.Contains("npm config get", body, StringComparison.Ordinal);
        Assert.Contains("exit 1", body, StringComparison.Ordinal);
    }

    [Fact]
    public void RegistryEnvScript_DefinesTheApprovedFeed()
    {
        var script = ReadRepoFile(RegistryEnvScriptPath);

        var match = Regex.Match(script, @"^APPROVED_NPM_REGISTRY=""(?<url>[^""]+)""$", RegexOptions.Multiline);

        Assert.True(match.Success, $"{RegistryEnvScriptPath} no longer defines the approved npm registry in the expected form.");
        Assert.Equal(ApprovedNpmRegistry, match.Groups["url"].Value);
        Assert.True(IsApprovedFeedUrl(match.Groups["url"].Value), $"NPM_REGISTRY is set from {match.Groups["url"].Value}, which is not the approved feed.");
    }

    [Fact]
    public void RegistryEnvScript_ComparesResolvedRegistriesAgainstTheCanonicalApprovedFeed()
    {
        var script = ReadRepoFile(RegistryEnvScriptPath);

        Assert.Contains($"APPROVED_NPM_REGISTRY=\"{ApprovedNpmRegistry}\"", script, StringComparison.Ordinal);
        Assert.Contains("NPM_REGISTRY=\"$APPROVED_NPM_REGISTRY\"", script, StringComparison.Ordinal);
        Assert.DoesNotContain("NPM_REGISTRY=\"${NPM_REGISTRY:-", script, StringComparison.Ordinal);

        var comparisonTargets = Regex.Matches(script, @"!= ""\$\{(?<target>[A-Za-z_][A-Za-z0-9_]*)%/\}""", RegexOptions.Multiline)
            .Select(match => match.Groups["target"].Value)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(["APPROVED_NPM_REGISTRY"], comparisonTargets);
    }

    /// <summary>
    /// Sourcing after the first acquisition would leave that acquisition on the ambient registry, so
    /// position is part of the guarantee rather than a style preference.
    /// </summary>
    [Theory]
    [MemberData(nameof(PackageAcquiringPolyglotScripts))]
    public void PolyglotScript_SourcesTheRegistryEnvBeforeAcquiringPackages(string scriptName)
    {
        var script = ReadRepoFile($"{PolyglotValidationDirectory}/{scriptName}");

        var sourceIndex = FindRegistryEnvSource(script);
        Assert.True(sourceIndex >= 0, $"{scriptName} does not source {RegistryEnvScriptName}, so its installs use the ambient registry.");

        var firstAcquisitionIndex = FindFirstPackageAcquisition(script);
        Assert.True(
            sourceIndex < firstAcquisitionIndex,
            $"{scriptName} sources {RegistryEnvScriptName} at offset {sourceIndex}, after it first acquires packages at offset {firstAcquisitionIndex}.");
    }

    [Fact]
    public void FindRegistryEnvSource_IgnoresPathAssignmentWithoutSourceCommand()
    {
        const string Script = """
            NPM_REGISTRY_ENV="$(dirname "${BASH_SOURCE[0]}")/npm-registry-env.sh"
            npm install
            """;

        Assert.Equal(-1, FindRegistryEnvSource(Script));
    }

    /// <summary>
    /// The guarantee belongs to the polyglot job rather than to any one script, so a newly added
    /// script that acquires npm packages has to be guarded too. Discovering the set from disk means
    /// that shows up as a failure here instead of as a silent gap.
    /// </summary>
    [Fact]
    public void PolyglotScripts_ThatAcquireNpmPackagesAreAllGuarded()
    {
        var directory = Path.Combine(RepoRoot.Path, PolyglotValidationDirectory);

        var acquiring = Directory.EnumerateFiles(directory, "*.sh")
            .Where(path => Path.GetFileName(path) != RegistryEnvScriptName)
            .Where(path => FindFirstPackageAcquisition(File.ReadAllText(path)) != int.MaxValue)
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal);

        Assert.Equal(PackageAcquiringScriptNames, acquiring);
    }

    /// <summary>
    /// A sourced helper only enforces anything if it is actually present where the script runs. The
    /// TypeScript image previously copied its scripts by name, so extracting a helper out of one of
    /// them left the image without it and the `source` failed at job time.
    /// </summary>
    /// <remarks>
    /// Every polyglot image is checked, not just the TypeScript one, because the images that still
    /// enumerate their scripts would hit the same failure the first time one of their scripts grows
    /// a sibling helper.
    /// </remarks>
    [Theory]
    [MemberData(nameof(PolyglotDockerfiles))]
    public void PolyglotValidationImage_ShipsEveryFileItsScriptsSource(string dockerfileName)
    {
        var copied = FilesCopiedIntoImage(ReadRepoFile($"{PolyglotValidationDirectory}/{dockerfileName}"));

        // Only the scripts the image actually ships can run in it, so they define what has to resolve.
        var missing = copied
            .Where(name => name.EndsWith(".sh", StringComparison.Ordinal))
            .SelectMany(name => SourcedFileNames(ReadRepoFile($"{PolyglotValidationDirectory}/{name}")))
            .Distinct()
            .Where(name => !copied.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(Array.Empty<string>(), missing);
    }

    /// <summary>
    /// Asserted separately from the theory above so that a regex that silently stops matching cannot
    /// make every image trivially pass.
    /// </summary>
    [Fact]
    public void TypeScriptValidationImage_ShipsTheRegistryEnvHelper()
    {
        var copied = FilesCopiedIntoImage(ReadRepoFile($"{PolyglotValidationDirectory}/Dockerfile.typescript"));

        var sourced = s_packageAcquiringScriptNames
            .SelectMany(name => SourcedFileNames(ReadRepoFile($"{PolyglotValidationDirectory}/{name}")))
            .Distinct()
            .ToArray();

        Assert.Equal(new[] { RegistryEnvScriptName }, sourced);
        Assert.Contains(RegistryEnvScriptName, copied);
    }

    /// <summary>
    /// The runtime helper cannot protect what an image downloads while it is being built, because
    /// nothing under /scripts runs until the entrypoint. Any image layer that acquires npm packages
    /// therefore has to own npm's config itself, before the acquisition.
    /// </summary>
    /// <remarks>
    /// Owning the default registry is not enough. A <c>@scope:registry</c> key is a separate setting
    /// that wins for that scope, and neither <c>--registry</c> nor <c>npm_config_registry</c>
    /// overrides it (see <see cref="RegistryEnvScript_IsolatesNpmFromAmbientScopedRegistries"/>).
    /// The TypeScript image installs <c>@yarnpkg/cli-dist</c> directly and pulls typescript's
    /// <c>@typescript/*</c> platform packages transitively, so an ambient scoped key in the base
    /// image would redirect exactly the packages this guard exists to protect.
    /// </remarks>
    [Theory]
    [MemberData(nameof(NpmAcquiringPolyglotDockerfiles))]
    public void PolyglotValidationImage_OwnsNpmConfigBeforeAcquiringPackages(string dockerfileName)
    {
        var dockerfile = ReadRepoFile($"{PolyglotValidationDirectory}/{dockerfileName}");
        var firstAcquisitionIndex = FindFirstPackageAcquisition(dockerfile);

        var userConfigIndex = dockerfile.IndexOf("export NPM_CONFIG_USERCONFIG=", StringComparison.Ordinal);
        Assert.True(
            userConfigIndex >= 0 && userConfigIndex < firstAcquisitionIndex,
            $"{dockerfileName} acquires npm packages at offset {firstAcquisitionIndex} without first pointing NPM_CONFIG_USERCONFIG at a config file the build owns.");

        // Owning the file only removes user-level keys. Scopes inherited from the global or builtin
        // config are neutralized by writing them back at the higher-precedence user level, so the
        // Dockerfile has to enumerate what npm reports rather than trusting the default alone.
        var scopePinIndex = dockerfile.IndexOf(":registry=%s", StringComparison.Ordinal);
        Assert.True(
            scopePinIndex >= 0 && scopePinIndex < firstAcquisitionIndex,
            $"{dockerfileName} does not re-pin the npm scopes it inherits to the approved feed before acquiring packages at offset {firstAcquisitionIndex}.");
    }

    /// <summary>
    /// The build arg cannot be its own authority. If the image trusted whatever NPM_REGISTRY it was
    /// handed, <c>--build-arg NPM_REGISTRY=https://registry.npmjs.org</c> would make every step agree
    /// with itself while the toolchain came from an unapproved host — the same hole
    /// npm-registry-env.sh closes for the job's own NPM_REGISTRY override.
    /// </summary>
    [Theory]
    [MemberData(nameof(NpmAcquiringPolyglotDockerfiles))]
    public void PolyglotValidationImage_RejectsAnUnapprovedNpmRegistryBuildArg(string dockerfileName)
    {
        var dockerfile = ReadRepoFile($"{PolyglotValidationDirectory}/{dockerfileName}");
        var firstAcquisitionIndex = FindFirstPackageAcquisition(dockerfile);

        var argDefault = Regex.Match(dockerfile, @"^ARG NPM_REGISTRY=(?<url>\S+)$", RegexOptions.Multiline);
        Assert.True(argDefault.Success, $"{dockerfileName} no longer declares an NPM_REGISTRY build arg in the expected form.");
        Assert.Equal(ApprovedNpmRegistry, argDefault.Groups["url"].Value);

        var comparisonIndex = dockerfile.IndexOf($"APPROVED_NPM_REGISTRY={ApprovedNpmRegistry}", StringComparison.Ordinal);
        Assert.True(
            comparisonIndex >= 0 && comparisonIndex < firstAcquisitionIndex,
            $"{dockerfileName} acquires npm packages at offset {firstAcquisitionIndex} without first rejecting an NPM_REGISTRY build arg that is not '{ApprovedNpmRegistry}'.");
    }

    /// <summary>
    /// Every logical line must begin with a Docker instruction once line continuations are joined.
    /// </summary>
    /// <remarks>
    /// A shell fragment left behind by an edit - a dropped `\` or a duplicated block tail - reads as
    /// a fresh instruction and fails the image build with `unknown instruction`, which is only
    /// discovered when the polyglot job actually builds. That job does not run on every PR, so the
    /// break can reach main. This turns a build-time parse failure into a unit test failure.
    /// </remarks>
    [Theory]
    [MemberData(nameof(PolyglotDockerfiles))]
    public void PolyglotDockerfile_HasNoOrphanedContinuationLines(string dockerfileName)
    {
        var text = ReadRepoFile($"{PolyglotValidationDirectory}/{dockerfileName}");

        var orphans = new List<string>();
        var buffer = new StringBuilder();

        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');

            // A comment only starts a logical line when one is not already being continued; inside a
            // continuation a '#' is shell syntax, not a Dockerfile comment.
            if (buffer.Length == 0 && line.TrimStart().StartsWith('#'))
            {
                continue;
            }

            buffer.Append(line);

            if (buffer.ToString().TrimEnd().EndsWith('\\'))
            {
                var joined = buffer.ToString().TrimEnd();
                buffer.Clear();
                buffer.Append(joined, 0, joined.Length - 1);
                continue;
            }

            var logicalLine = buffer.ToString();
            buffer.Clear();

            if (string.IsNullOrWhiteSpace(logicalLine))
            {
                continue;
            }

            var instruction = logicalLine.TrimStart().Split(' ', StringSplitOptions.RemoveEmptyEntries)[0];
            if (!s_dockerInstructions.Contains(instruction))
            {
                orphans.Add(instruction);
            }
        }

        Assert.Equal([], orphans);
    }

    // https://docs.docker.com/reference/dockerfile/
    private static readonly HashSet<string> s_dockerInstructions = new(StringComparer.OrdinalIgnoreCase)
    {
        "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM", "HEALTHCHECK", "LABEL",
        "MAINTAINER", "ONBUILD", "RUN", "SHELL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR",
    };

    /// <summary>
    /// Discovered from disk rather than listed, so an image that grows a build-time npm install is
    /// held to the same rule instead of being silently exempt.
    /// </summary>
    public static TheoryData<string> NpmAcquiringPolyglotDockerfiles => ToTheoryData(
        Directory.EnumerateFiles(Path.Combine(RepoRoot.Path, PolyglotValidationDirectory), "Dockerfile.*")
            .Where(path => FindFirstPackageAcquisition(File.ReadAllText(path)) != int.MaxValue)
            .Select(Path.GetFileName)
            .Where(name => name is not null)
            .Select(name => name!)
            .OrderBy(name => name, StringComparer.Ordinal));

    public static TheoryData<string> PolyglotDockerfiles => ToTheoryData(
        Directory.EnumerateFiles(Path.Combine(RepoRoot.Path, PolyglotValidationDirectory), "Dockerfile.*")
            .Select(Path.GetFileName)
            .Where(name => name is not null)
            .Select(name => name!)
            .OrderBy(name => name, StringComparer.Ordinal));

    /// <summary>
    /// Resolves the file names a Dockerfile puts in the image, expanding `COPY *.sh` against the
    /// build context so a glob counts as covering every matching file rather than none.
    /// </summary>
    private static HashSet<string> FilesCopiedIntoImage(string dockerfile)
    {
        // COPY lines here are the simple `COPY <src> <dest>` form, e.g.
        //   COPY *.sh /scripts/
        //   COPY setup-local-cli.sh /scripts/setup-local-cli.sh
        var copied = new HashSet<string>(StringComparer.Ordinal);
        var contextFiles = Directory.EnumerateFiles(Path.Combine(RepoRoot.Path, PolyglotValidationDirectory))
            .Select(Path.GetFileName)
            .ToArray();

        foreach (Match match in Regex.Matches(dockerfile, @"^COPY\s+(?<source>\S+)\s+\S+\s*$", RegexOptions.Multiline))
        {
            var source = match.Groups["source"].Value;

            if (source.Contains('*'))
            {
                var pattern = "^" + Regex.Escape(source).Replace("\\*", ".*") + "$";
                foreach (var file in contextFiles.Where(file => file is not null && Regex.IsMatch(file, pattern)))
                {
                    copied.Add(file!);
                }

                continue;
            }

            copied.Add(source);
        }

        return copied;
    }

    private static IEnumerable<string> SourcedFileNames(string script)
    {
        // Sibling helpers are referenced through the `$(dirname "${BASH_SOURCE[0]}")/name.sh` idiom,
        // either sourced inline or assigned to a variable first so the script can check the file
        // exists before sourcing it:
        //
        //   NPM_REGISTRY_ENV="$(dirname "${BASH_SOURCE[0]}")/npm-registry-env.sh"
        //   source "$NPM_REGISTRY_ENV"
        //
        // Matching the idiom rather than the `source` keyword therefore catches both shapes; keying
        // off `source` alone would miss the indirect one and silently pass.
        var siblingReferences = Regex.Matches(script, @"\$\(dirname [^)]*\)/(?<name>[A-Za-z0-9._-]+\.sh)")
            .Select(match => match.Groups["name"].Value);

        var directSources = Regex.Matches(script, @"^(?:source|\.)\s+""?[^""\s]*/(?<name>[A-Za-z0-9._-]+\.sh)""?\s*$", RegexOptions.Multiline)
            .Select(match => match.Groups["name"].Value);

        return siblingReferences.Concat(directSources);
    }

    /// <summary>
    /// Commands that acquire packages from the npm ecosystem, either directly or through the
    /// TypeScript guest runtime. `aspire init --language typescript` installs the scaffolded AppHost's
    /// dependencies with the guest runtime's package manager and passes no --registry, so it acquires
    /// from the ambient registry just as a bare `npm install` would.
    ///
    /// Deliberately npm-specific: the Python, Go, Java, and Rust scripts also run `aspire init`, but
    /// their guest runtimes use pip, Go modules, Maven, and Cargo, which these variables do not
    /// configure.
    /// </summary>
    private static readonly string[] s_packageAcquisitionMarkers =
    [
        "npm install",
        "npm exec",
        "npx ",
        "pnpm install",
        "yarn install",
        "bun install",
        "bunx ",
        "aspire init --language typescript",
    ];

    private static readonly string[] s_packageAcquiringScriptNames =
    [
        "test-typescript-playground.sh",
        "test-typescript.sh",
    ];

    public static IEnumerable<string> PackageAcquiringScriptNames => s_packageAcquiringScriptNames;

    public static TheoryData<string> PackageAcquiringPolyglotScripts => ToTheoryData(s_packageAcquiringScriptNames);

    private static int FindRegistryEnvSource(string script)
    {
        // The guarded scripts use a two-line shape:
        //   NPM_REGISTRY_ENV="$(dirname "${BASH_SOURCE[0]}")/npm-registry-env.sh"
        //   source "$NPM_REGISTRY_ENV"
        // Matching the helper path alone sees the assignment, so deleting the source command would
        // still pass. The ordering guard needs the command that actually applies the feed settings.
        var offset = 0;
        foreach (var line in script.Split('\n'))
        {
            var trimmed = line.Trim();
            if ((trimmed is "source \"$NPM_REGISTRY_ENV\"" or "source $NPM_REGISTRY_ENV" or ". \"$NPM_REGISTRY_ENV\"" or ". $NPM_REGISTRY_ENV") ||
                ((trimmed.StartsWith("source ", StringComparison.Ordinal) || trimmed.StartsWith(". ", StringComparison.Ordinal)) &&
                 trimmed.Contains(RegistryEnvScriptName, StringComparison.Ordinal)))
            {
                return offset + line.IndexOf(line.TrimStart(), StringComparison.Ordinal);
            }

            offset += line.Length + 1;
        }

        return -1;
    }

    /// <summary>
    /// Returns <see cref="int.MaxValue"/> when the script acquires nothing, so callers can compare
    /// positions without special-casing the empty result.
    /// </summary>
    private static int FindFirstPackageAcquisition(string script)
    {
        // Comment lines describe these commands without running them — the explanation of why a
        // script sources the registry env names the very commands it is guarding — so they would
        // otherwise be found ahead of the real invocation. Blank them to the same width rather than
        // dropping them, so the returned offset still refers to a position in the original script.
        var executable = string.Join(
            '\n',
            script.Split('\n').Select(line => line.TrimStart().StartsWith('#') ? new string(' ', line.Length) : line));

        return s_packageAcquisitionMarkers
            .Select(marker => executable.IndexOf(marker, StringComparison.Ordinal))
            .Where(index => index >= 0)
            .DefaultIfEmpty(int.MaxValue)
            .Min();
    }

    private static SortedSet<string> ExportedRegistryVariables(string script)
    {
        // Matches `export npm_config_registry="$NPM_REGISTRY"`. Only exports assigned from
        // NPM_REGISTRY count: a hard-coded URL elsewhere would drift from the helper's single
        // exported source of truth.
        var matches = Regex.Matches(script, @"^export (?<name>[A-Za-z_][A-Za-z0-9_]*)=""\$NPM_REGISTRY""$", RegexOptions.Multiline);

        return new SortedSet<string>(matches.Select(match => match.Groups["name"].Value), StringComparer.Ordinal);
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
    // Approved-feed text pushed into the query string of an attacker-controlled host.
    [InlineData("https://evil.example.com/ms-2.1.3.tgz?from=https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/", false)]
    // Approved host and approved feed name, but a different Azure DevOps organization. The org is
    // the first path segment, so matching the host alone would accept every org on the service.
    [InlineData("https://pkgs.dev.azure.com/contoso/public/_packaging/dotnet-public-npm/npm/registry/ms/-/ms-2.1.3.tgz", false)]
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
        //   "typescript@npm:6.0.3":
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

    private static void MakeExecutable(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        File.SetUnixFileMode(path,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
            UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
    }

    private static async Task<(int ExitCode, string Output)> RunBashAsync(string scriptPath, string[] arguments, Dictionary<string, string?> environment)
    {
        using var process = new Process();
        process.StartInfo.FileName = "bash";
        process.StartInfo.ArgumentList.Add(scriptPath);

        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        process.StartInfo.RedirectStandardError = true;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.UseShellExecute = false;

        foreach (var (name, value) in environment)
        {
            process.StartInfo.Environment[name] = value;
        }

        process.Start();

        // Read both streams concurrently to avoid deadlock when a pipe buffer fills.
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        using var cancellationTokenSource = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await process.WaitForExitAsync(cancellationTokenSource.Token);

        return (process.ExitCode, await outputTask + await errorTask);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var path = Path.Combine(RepoRoot.Path, relativePath);
        Assert.True(File.Exists(path), $"{relativePath} does not exist. Update this test if the file moved or was renamed.");

        return File.ReadAllText(path);
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
