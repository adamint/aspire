// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections;
using System.Text;
using Aspire.Cli.Npm;
using Aspire.Cli.Tests.Acquisition;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Cli.Tests.Npm;

// ReadNpmConfigVariables_RetainsOnlyRegistryConfigurationFromTheProcessEnvironment sets a
// process-wide npm_config_* variable, and the assembly runs suites in parallel by default, so join
// EnvVarMutatingTestCollection to keep another suite from observing it mid-run.
[Collection(EnvVarMutatingTestCollection.Name)]
public class NpmRegistryResolverTests : IDisposable
{
    private const string PackageName = "@microsoft/aspire-cli";
    private const string PublicRegistry = "https://registry.npmjs.org/";

    // Credential-shaped and npm_config-prefixed, so it exercises the allow list rather than just
    // the prefix filter.
    private const string CredentialVariableName = "npm_config__authToken";

    private readonly DirectoryInfo _root = Directory.CreateTempSubdirectory("aspire-npmrc-tests");

    [Fact]
    public void Resolve_FallsBackToPublicNpmWhenNothingIsConfigured()
    {
        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal(PublicRegistry, resolution.RegistryUri.AbsoluteUri);
        Assert.Equal("the npm built-in default", resolution.Source);
    }

    [Fact]
    public void Resolve_UsesUserNpmrcRegistry()
    {
        WriteHomeNpmrc("registry=https://npm.contoso.example/artifactory/api/npm/npm/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/artifactory/api/npm/npm/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_AppendsTrailingSlashSoFeedPathsSurviveComposition()
    {
        // "https://.../npm/registry" without the trailing slash would compose to ".../npm/<package>".
        WriteHomeNpmrc("registry=https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal(
            "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/%40microsoft%2Faspire-cli",
            new Uri(resolution.RegistryUri, Uri.EscapeDataString(PackageName)).AbsoluteUri);
    }

    [Fact]
    public void Resolve_ScopedRegistryOutranksGlobalRegistry()
    {
        WriteHomeNpmrc(
            "registry=https://npm.contoso.example/general/",
            "@microsoft:registry=https://npm.contoso.example/microsoft/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/microsoft/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ScopedRegistryForAnotherScopeIsIgnored()
    {
        WriteHomeNpmrc(
            "registry=https://npm.contoso.example/general/",
            "@contoso:registry=https://npm.contoso.example/contoso/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/general/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_EnvironmentVariableOutranksNpmrcFiles()
    {
        WriteHomeNpmrc("registry=https://npm.contoso.example/from-file/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["NPM_CONFIG_REGISTRY"] = "https://npm.contoso.example/from-env/"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/from-env/", resolution.RegistryUri.AbsoluteUri);
        Assert.Equal("the NPM_CONFIG_REGISTRY environment variable", resolution.Source);
    }

    [Fact]
    public void Resolve_UserNpmrcOutranksProjectNpmrcForGlobalInstall()
    {
        WriteHomeNpmrc("registry=https://npm.contoso.example/user/");

        var project = CreateWorkingDirectory("repo", "src");
        File.WriteAllText(Path.Combine(_root.FullName, "repo", "package.json"), "{}");
        File.WriteAllText(Path.Combine(_root.FullName, "repo", ".npmrc"), "registry=https://npm.contoso.example/project/");

        var resolution = CreateResolver(workingDirectory: project).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/user/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_IgnoresNpmrcBelowTheLocalPrefix()
    {
        // npm reads the .npmrc at the local prefix, not one sitting in an unrelated child directory.
        WriteHomeNpmrc("registry=https://npm.contoso.example/user/");

        var project = CreateWorkingDirectory("repo", "src");
        File.WriteAllText(Path.Combine(_root.FullName, "repo", "package.json"), "{}");
        File.WriteAllText(Path.Combine(project.FullName, ".npmrc"), "registry=https://npm.contoso.example/nested/");

        var resolution = CreateResolver(workingDirectory: project).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/user/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_HonorsUserConfigRedirect()
    {
        var relocated = Path.Combine(_root.FullName, "relocated-npmrc");
        File.WriteAllText(relocated, "registry=https://npm.contoso.example/relocated/");
        WriteHomeNpmrc("registry=https://npm.contoso.example/home/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["npm_config_userconfig"] = relocated
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/relocated/", resolution.RegistryUri.AbsoluteUri);
    }

    [Theory]
    [InlineData("registry = \"https://npm.contoso.example/quoted/\"", "https://npm.contoso.example/quoted/")]
    [InlineData("registry='https://npm.contoso.example/quoted/'", "https://npm.contoso.example/quoted/")]
    [InlineData("  registry\t=\thttps://npm.contoso.example/spaced/  ", "https://npm.contoso.example/spaced/")]
    public void Resolve_ParsesNpmrcValueForms(string line, string expected)
    {
        WriteHomeNpmrc(line);

        Assert.Equal(expected, CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_UsesLastDuplicateKeyWithinSingleNpmrcFile()
    {
        WriteHomeNpmrc(
            "registry=https://npm.contoso.example/first/",
            "registry=https://npm.contoso.example/second/");

        Assert.Equal(
            "https://npm.contoso.example/second/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_StripsInlineCommentFromUnquotedNpmrcValue()
    {
        WriteHomeNpmrc("registry=https://npm.contoso.example/feed/ ; mirror");

        Assert.Equal(
            "https://npm.contoso.example/feed/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_PreservesEscapedSemicolonInUnquotedNpmrcValue()
    {
        WriteHomeNpmrc(@"registry=https://npm.contoso.example/feed/\;mirror/");

        Assert.Equal(
            "https://npm.contoso.example/feed/;mirror/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_PreservesEscapedHashInUnquotedNpmrcValue()
    {
        WriteHomeNpmrc(@"registry=https://npm.contoso.example/feed/\#mirror");

        Assert.Equal(
            "https://npm.contoso.example/feed/#mirror",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Theory]
    [InlineData("REGISTRY=https://npm.contoso.example/upper/")]
    [InlineData("Registry=https://npm.contoso.example/mixed/")]
    [InlineData("@Microsoft:registry=https://npm.contoso.example/scoped/")]
    public void Resolve_IgnoresNpmrcKeysThatOnlyMatchWhenCaseFolded(string line)
    {
        // npm lowercases only the keys it derives from npm_config_* environment variables; keys
        // read out of a .npmrc keep their casing, so these entries are dead for npm and accepting
        // them here would point the update check at a registry the install command never uses.
        WriteHomeNpmrc(line);

        Assert.Equal(PublicRegistry, CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ExpandsEnvironmentReferencesInNpmrcKeys()
    {
        // npm substitutes ${VAR} in config keys as well as values, so which key an entry sets is
        // only known after expansion. The fixed keys carry no free-form text, so unlike a scope
        // name they can be expanded without parking an environment value in a retained key.
        WriteHomeNpmrc("regis${NPM_KEY_TAIL}=https://npm.contoso.example/expanded/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>(NpmRegistryResolver.EnvironmentVariableNameComparer)
            {
                ["NPM_KEY_TAIL"] = "try"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/expanded/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ExpandsEnvironmentReferencesInEnvironmentValues()
    {
        // npm runs every layer through parseField, so an npm_config_* value carries ${VAR} exactly
        // as a .npmrc value does.
        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["npm_config_registry"] = "  https://${NPM_HOST}/feed/  ",
                ["NPM_HOST"] = "npm.contoso.example"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ExpandsAHomeRelativeUserConfigPath()
    {
        // userconfig is path-typed, so parseField expands a leading "~/" against the home
        // directory before npm opens the file.
        WriteHomeNpmrc("registry=https://npm.contoso.example/home/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["npm_config_userconfig"] = "~/.npmrc"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/home/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_DecodesEscapesInADoubleQuotedNpmrcValue()
    {
        // ini hands a value that starts and ends with a quote to JSON.parse, so escape sequences in
        // a double-quoted value are live rather than literal.
        WriteHomeNpmrc("registry=\"https://npm.contoso.example/\\u0066eed/\"");

        Assert.Equal(
            "https://npm.contoso.example/feed/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_KeepsADoubleQuotedNpmrcValueThatIsNotValidJson()
    {
        // JSON.parse rejects "\z", and ini swallows the error while still holding the quoted text.
        // The surviving quotes are what make the value unusable, so the throw is the observation
        // that proves they survived: unquoting it would have produced a perfectly good address.
        WriteHomeNpmrc("registry=\"https://npm.contoso.example/a\\zb/\"");

        Assert.Throws<InvalidOperationException>(() => CreateResolver().Resolve(PackageName));
    }

    [Fact]
    public void Resolve_DoesNotDecodeEscapesInASingleQuotedNpmrcValue()
    {
        // ini strips single quotes before calling JSON.parse, and bare text is not valid JSON, so
        // the escape survives as the six literal characters "\u0066". Uri then rewrites the
        // backslash to a forward slash, which is why the segment reads "/u0066eed" rather than the
        // "/feed/" a decoded value would produce.
        WriteHomeNpmrc("registry='https://npm.contoso.example/\\u0066eed/'");

        Assert.Equal(
            "https://npm.contoso.example//u0066eed/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_UsesTheLastEnvironmentVariableThatNormalizesToTheSameKey()
    {
        // npm's loadEnv assigns every npm_config_* variable into one object, so two names that
        // normalize to the same config key resolve to the later one rather than the earlier.
        // Both spellings coexist wherever environment names are case-sensitive.
        var environment = new Dictionary<string, string>(NpmRegistryResolver.EnvironmentVariableNameComparer)
        {
            ["npm_config_registry"] = "https://npm.contoso.example/first/",
            ["NPM_CONFIG_REGISTRY"] = "https://npm.contoso.example/second/"
        };

        var expected = environment.Count == 1
            ? "https://npm.contoso.example/second/"
            : $"{environment.Values.Last()}";

        Assert.Equal(expected, CreateResolver(environment: environment).Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_IgnoresAScopedKeyThatOnlyBecomesARegistryKeyAfterExpansion()
    {
        // The expanded key is retained for the resolver's lifetime, so honoring this would park the
        // token in memory long after the parse. npm would accept it; keeping an ambient secret out
        // of a retained key name is a deliberate departure.
        WriteHomeNpmrc("@${NPM_TOKEN}:registry=https://npm.contoso.example/scoped/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>(NpmRegistryResolver.EnvironmentVariableNameComparer)
            {
                ["NPM_TOKEN"] = "microsoft"
            }).Resolve(PackageName);

        Assert.Equal(PublicRegistry, resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ReadsAGlobalNpmrcNamedByTheUserNpmrc()
    {
        // npm loads the global npmrc after the user one, and an explicitly configured globalconfig
        // needs no install prefix to locate, so a registry pinned there is the one the recommended
        // global install would use.
        var globalConfigPath = Path.Combine(CreateWorkingDirectory("global").FullName, "npmrc");
        File.WriteAllLines(globalConfigPath, ["registry=https://npm.contoso.example/global/"]);
        WriteHomeNpmrc($"globalconfig={globalConfigPath}");

        Assert.Equal(
            "https://npm.contoso.example/global/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_PrefersTheUserNpmrcRegistryOverTheGlobalOne()
    {
        // The global layer sits below the user layer, so it only supplies keys nothing above set.
        var globalConfigPath = Path.Combine(CreateWorkingDirectory("global").FullName, "npmrc");
        File.WriteAllLines(globalConfigPath, ["registry=https://npm.contoso.example/global/"]);
        WriteHomeNpmrc($"globalconfig={globalConfigPath}", "registry=https://npm.contoso.example/user/");

        Assert.Equal(
            "https://npm.contoso.example/user/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ReadsAGlobalNpmrcNamedByTheEnvironment()
    {
        var globalConfigPath = Path.Combine(CreateWorkingDirectory("global").FullName, "npmrc");
        File.WriteAllLines(globalConfigPath, ["registry=https://npm.contoso.example/envglobal/"]);

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["npm_config_globalconfig"] = globalConfigPath
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/envglobal/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_IgnoresARegistryNestedUnderAnIniSection()
    {
        // npm parses .npmrc with ini, which nests every later assignment under the section, so
        // "[tool]" followed by "registry" leaves npm's own install registry unset.
        WriteHomeNpmrc("[tool]", "registry=https://npm.contoso.example/feed/");

        Assert.Equal(PublicRegistry, CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_KeepsARegistryDeclaredAboveAnIniSection()
    {
        WriteHomeNpmrc("registry=https://npm.contoso.example/feed/", "[tool]", "registry=https://nested.example/feed/");

        Assert.Equal(
            "https://npm.contoso.example/feed/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Theory]
    [InlineData("  [tool]")]
    [InlineData("[tool] ; note")]
    [InlineData("[to]ol]")]
    public void Resolve_KeepsReadingPastABracketedLineIniTreatsAsAKey(string bracketedLine)
    {
        // ini only matches a section with /^\[([^\]]*)\]\s*$/ against the raw line, so leading
        // whitespace, a trailing comment, or an early bracket all leave the line a bare key and
        // the assignments below it stay at the top level where npm reads them.
        WriteHomeNpmrc(bracketedLine, "registry=https://npm.contoso.example/feed/");

        Assert.Equal(
            "https://npm.contoso.example/feed/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_LeavesAReferenceLiteralWhenAnOddBackslashRunEscapesIt()
    {
        // Two stages run in order: ini unescapes the value, then env-replace halves the backslash
        // run that is left in front of "${" and treats an odd run as an escape. One backslash on
        // disk survives ini as one backslash, which is odd, so the reference stays literal.
        WriteHomeNpmrc(@"registry=https://npm.contoso.example/\${SEGMENT}/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["SEGMENT"] = "v1"
            }).Resolve(PackageName);

        Assert.Equal(
            new Uri("https://npm.contoso.example/${SEGMENT}/").AbsoluteUri,
            resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_HalvesAnEvenBackslashRunAndExpandsTheReference()
    {
        // Three backslashes on disk survive ini as two, which is even, so env-replace emits half of
        // them and expands the reference.
        WriteHomeNpmrc(@"registry=https://npm.contoso.example/\\\${SEGMENT}/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["SEGMENT"] = "v1"
            }).Resolve(PackageName);

        Assert.Equal(
            new Uri(@"https://npm.contoso.example/\v1/").AbsoluteUri,
            resolution.RegistryUri.AbsoluteUri);
    }

    [Theory]
    [InlineData("; registry=https://npm.contoso.example/comment/")]
    [InlineData("# registry=https://npm.contoso.example/comment/")]
    [InlineData("[section]")]
    [InlineData("=https://npm.contoso.example/")]
    public void Resolve_IgnoresNpmrcLinesThatDoNotDefineAKey(string line)
    {
        WriteHomeNpmrc(line);

        Assert.Equal(PublicRegistry, CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Theory]
    [InlineData("registry=not-a-url")]
    [InlineData("registry=file:///tmp/local")]
    // ini stores a bare key as the boolean true and an empty assignment as the empty string. npm
    // rejects both when it validates the url, so neither can be treated as an absent key.
    [InlineData("registry")]
    [InlineData("registry=")]
    public void Resolve_FailsWhenTheConfiguredRegistryIsNotAnHttpAddress(string line)
    {
        // These lines do define the key, and npm keeps a defined value selected however unusable
        // it is - "npm config" throws ERR_INVALID_URL rather than reverting to the public default.
        // Falling back here would advertise an update whose recommended "npm install -g" runs
        // against the same unusable registry and fails.
        WriteHomeNpmrc(line);

        var exception = Assert.Throws<InvalidOperationException>(() => CreateResolver().Resolve(PackageName));

        Assert.Contains("'registry'", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_ExpandsEnvironmentReferences()
    {
        WriteHomeNpmrc("registry=https://${NPM_HOST}/feed/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["NPM_HOST"] = "npm.contoso.example"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_MatchesPlatformCaseSensitivityForEnvironmentReferences()
    {
        // npm expands ${VAR} through Node's process.env, which is case-insensitive only on Windows.
        WriteHomeNpmrc("registry=https://${npm_host}/feed/");

        var resolver = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["NPM_HOST"] = "npm.contoso.example"
            });

        if (OperatingSystem.IsWindows())
        {
            Assert.Equal("https://npm.contoso.example/feed/", resolver.Resolve(PackageName).RegistryUri.AbsoluteUri);
            return;
        }

        // Elsewhere the reference stays undefined, so npm keeps the literal "${npm_host}" in the
        // selected value and its own request fails.
        Assert.Throws<InvalidOperationException>(() => resolver.Resolve(PackageName));
    }

    [Fact]
    public void Resolve_ExpandsOptionalEnvironmentReferenceWhenDefined()
    {
        WriteHomeNpmrc("registry=https://${NPM_HOST?}/feed/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["NPM_HOST"] = "npm.contoso.example"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ExpandsUndefinedOptionalEnvironmentReferenceToEmptyString()
    {
        // "${VAR?}" is npm's optional form: undefined expands to empty rather than being left in
        // place, so the surrounding value still resolves.
        WriteHomeNpmrc("registry=https://npm.contoso.example/${NPM_PATH_NOT_SET?}feed/");

        Assert.Equal(
            "https://npm.contoso.example/feed/",
            CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_FailsWhenAnNpmrcEntryHasAnUndefinedEnvironmentReference()
    {
        // npm leaves the undefined reference literal, keeps the entry selected, and fails its own
        // request. Falling back to public npm here would advertise an update that the recommended
        // "npm install -g" cannot install.
        WriteHomeNpmrc("registry=https://${NPM_HOST_NOT_SET}/feed/");

        var exception = Assert.Throws<InvalidOperationException>(() => CreateResolver().Resolve(PackageName));

        Assert.Contains("'registry'", exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("NPM_HOST_NOT_SET", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_FailsRatherThanFallingBackToALowerPrecedenceRegistry()
    {
        // The user layer defines an unusable registry, so npm never reaches the global one.
        var globalNpmrc = Path.Combine(_root.FullName, "global-npmrc");
        File.WriteAllText(globalNpmrc, "registry=https://npm.contoso.example/global/\n");
        WriteHomeNpmrc($"globalconfig={globalNpmrc}", "registry=not-a-url");

        Assert.Throws<InvalidOperationException>(() => CreateResolver().Resolve(PackageName));
    }

    [Fact]
    public void Resolve_IgnoresAnEmptyEnvironmentRegistryVariable()
    {
        // npm's loadEnv skips an npm_config_* variable set to the empty string, so it never reaches
        // the layer at all - unlike "registry=" in a .npmrc, which does configure the key.
        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["npm_config_registry"] = string.Empty
        });

        Assert.Equal(PublicRegistry, resolver.Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_FailsWhenAnEnvironmentRegistryHasAnUndefinedEnvironmentReference()
    {
        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["npm_config_registry"] = "https://${NPM_HOST_NOT_SET}/feed/"
        });

        Assert.Throws<InvalidOperationException>(() => resolver.Resolve(PackageName));
    }

    [Fact]
    public void Resolve_ExpandsTheDefinedReferencesBesideAnUndefinedOne()
    {
        // npm's env-replace runs String.replace per reference, so a missing mandatory variable
        // leaves only its own "${NAME}" behind while every other substitution survives. Discarding
        // the whole expansion would resolve a different address than npm does - here it would drop
        // the "feed" path segment - and the partially expanded value is still a legal URL, so npm
        // really does request it rather than erroring out.
        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["NPM_SEGMENT"] = "feed",
            ["npm_config_registry"] = "https://npm.contoso.example/${NPM_SEGMENT}/${NPM_HOST_NOT_SET}/"
        });

        var resolution = resolver.Resolve(PackageName);

        Assert.Equal(
            "https://npm.contoso.example/feed/$%7BNPM_HOST_NOT_SET%7D/",
            resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ExpandsTheDefinedReferencesBesideAnUndefinedOneInAnNpmrcValue()
    {
        WriteHomeNpmrc("registry=https://npm.contoso.example/${NPM_SEGMENT}/${NPM_HOST_NOT_SET}/");

        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["NPM_SEGMENT"] = "feed"
        });

        var resolution = resolver.Resolve(PackageName);

        Assert.Equal(
            "https://npm.contoso.example/feed/$%7BNPM_HOST_NOT_SET%7D/",
            resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ReadsTheGlobalNpmrcUnderneathAConfiguredPrefix()
    {
        // npm derives globalconfig as resolve(prefix, "etc/npmrc") when nothing sets it explicitly,
        // so an enterprise that sets prefix and pins the registry there would otherwise be resolved
        // against public npm - an update the recommended global install cannot fetch.
        var prefix = Directory.CreateDirectory(Path.Combine(_root.FullName, "corp"));
        var globalNpmrcDirectory = Directory.CreateDirectory(Path.Combine(prefix.FullName, "etc"));
        File.WriteAllText(
            Path.Combine(globalNpmrcDirectory.FullName, "npmrc"),
            "registry=https://npm.contoso.example/from-prefix/");

        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["npm_config_prefix"] = prefix.FullName
        });

        var resolution = resolver.Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/from-prefix/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_PrefersAnExplicitGlobalConfigOverThePrefixDerivedOne()
    {
        // globalconfig is an explicit npm setting; the prefix only supplies the default.
        var prefix = Directory.CreateDirectory(Path.Combine(_root.FullName, "corp"));
        var globalNpmrcDirectory = Directory.CreateDirectory(Path.Combine(prefix.FullName, "etc"));
        File.WriteAllText(
            Path.Combine(globalNpmrcDirectory.FullName, "npmrc"),
            "registry=https://npm.contoso.example/from-prefix/");

        var explicitGlobalNpmrc = Path.Combine(_root.FullName, "explicit-npmrc");
        File.WriteAllText(explicitGlobalNpmrc, "registry=https://npm.contoso.example/from-globalconfig/");

        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["npm_config_prefix"] = prefix.FullName,
            ["npm_config_globalconfig"] = explicitGlobalNpmrc
        });

        var resolution = resolver.Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/from-globalconfig/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ReadsARegistryWrittenWithIniArraySyntax()
    {
        // ini strips the "[]" suffix and makes the entry an array, and every npm consumer of the
        // registry turns that array back into a string, so a lone "registry[]" line really does
        // select this mirror. Ignoring the key would check public npm instead and announce an
        // update that the user's own npm cannot install.
        WriteHomeNpmrc("registry[]=https://npm.contoso.example/feed/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_JoinsRepeatedIniArrayRegistryEntriesTheWayNpmStringifiesThem()
    {
        // JS renders an array by joining with ",", so npm asks for a host whose name is the two
        // addresses run together. That is unusable, but it is unusable in npm too - the point is
        // that the key stays selected rather than falling through to the public registry.
        WriteHomeNpmrc(
            "registry[]=https://a.contoso.example/",
            "registry[]=https://b.contoso.example/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal(
            "https://a.contoso.example/,https://b.contoso.example/",
            resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_AppendsAPlainRegistryLineOntoAnIniArrayItFollows()
    {
        // Once ini has made the key an array, a later plain assignment is pushed onto it rather
        // than replacing it, so the usual last-wins rule for duplicate keys does not apply here.
        WriteHomeNpmrc(
            "registry[]=https://a.contoso.example/",
            "registry=https://b.contoso.example/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal(
            "https://a.contoso.example/,https://b.contoso.example/",
            resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ReadsAPrefixKeyAssembledByAnEnvironmentReference()
    {
        // prefix carries no free-form text, so substituting into its name cannot smuggle a secret
        // into a retained key - the reason the substitution guard exists at all. npm expands keys
        // after ini has parsed them, so this names the same prefix a literal spelling would.
        var prefix = Directory.CreateDirectory(Path.Combine(_root.FullName, "corp"));
        var globalNpmrcDirectory = Directory.CreateDirectory(Path.Combine(prefix.FullName, "etc"));
        File.WriteAllText(
            Path.Combine(globalNpmrcDirectory.FullName, "npmrc"),
            "registry=https://npm.contoso.example/from-prefix/");

        WriteHomeNpmrc($"pre${{NPM_KEY_TAIL}}={prefix.FullName}");

        var resolver = CreateResolver(environment: new Dictionary<string, string>
        {
            ["NPM_KEY_TAIL"] = "fix"
        });

        var resolution = resolver.Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/from-prefix/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_ReadsAQuotedNpmrcKey()
    {
        // ini decodes the key half with the same unsafe() pass it applies to values, so npm sees
        // the plain "registry" key here.
        WriteHomeNpmrc("\"registry\"=https://npm.contoso.example/quoted/");

        Assert.Equal("https://npm.contoso.example/quoted/", CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void ReadNpmConfigVariables_RetainsOnlyRegistryConfigurationFromTheProcessEnvironment()
    {
        // The resolver is a singleton for the whole command, so snapshotting the process
        // environment would keep unrelated credentials alive for that long.
        Environment.SetEnvironmentVariable(CredentialVariableName, "super-secret-token");

        try
        {
            var processVariableNames = Environment.GetEnvironmentVariables()
                .Cast<DictionaryEntry>()
                .Select(entry => (string)entry.Key)
                .ToArray();

            var retained = NpmRegistryResolver.ReadNpmConfigVariables();

            // Without the credential variable actually present, the filter below would prove nothing.
            Assert.Contains(CredentialVariableName, processVariableNames);
            Assert.Equal([], retained.Keys.Where(name => !IsRegistryConfigurationVariable(name)).Order().ToArray());
        }
        finally
        {
            Environment.SetEnvironmentVariable(CredentialVariableName, null);
        }
    }

    private static bool IsRegistryConfigurationVariable(string name)
    {
        if (!name.StartsWith(NpmRegistryResolver.EnvironmentVariablePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var key = name[NpmRegistryResolver.EnvironmentVariablePrefix.Length..].ToLowerInvariant();

        return key is "registry" or "userconfig" or "globalconfig" || key.EndsWith(":registry", StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_DoesNotReadCredentialEntries()
    {
        // The lookup is anonymous. Auth material in a .npmrc must never be materialized, so the
        // only observable effect of these lines is the registry itself.
        WriteHomeNpmrc(
            "registry=https://npm.contoso.example/feed/",
            "//npm.contoso.example/feed/:_authToken=super-secret-token",
            "_auth=BASE64CREDENTIAL",
            "email=someone@contoso.example");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
        Assert.Equal("https://npm.contoso.example/feed/", resolution.DisplayUri);
    }

    [Fact]
    public void Resolve_ReadsTheFirstKeyOfAFileThatStartsWithAByteOrderMark()
    {
        // The file is decoded by hand so a credential line never becomes a string, which means the
        // UTF-8 BOM an editor may write is no longer stripped for us.
        WriteHomeNpmrcBytes([.. Encoding.UTF8.GetPreamble(), .. "registry=https://npm.contoso.example/feed/\n"u8]);

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
    }

    [Theory]
    [InlineData("\n")]
    [InlineData("\r\n")]
    [InlineData("\r")]
    public void Resolve_ReadsEveryLineTerminatorNpmAccepts(string terminator)
    {
        WriteHomeNpmrcBytes(Encoding.UTF8.GetBytes(
            $"//npm.contoso.example/feed/:_authToken=super-secret-token{terminator}registry=https://npm.contoso.example/feed/{terminator}"));

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RegistryUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_RedactsCredentialsEmbeddedInTheRegistryValue()
    {
        WriteHomeNpmrc("registry=https://user:super-secret-token@npm.contoso.example/feed/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.DisplayUri);
        Assert.Equal("user:super-secret-token", resolution.RegistryUri.UserInfo);
    }

    [Fact]
    public void Resolve_RemovesQueryAndFragmentFromTheRequestUri()
    {
        // RequestUri is documented as credential-free and is what a delegating handler, diagnostic
        // listener, or exception message reads off the wire object. A signed URL carries its token
        // in the query, so stripping only the authority would leave the property lying about itself.
        WriteHomeNpmrc("registry=https://npm.contoso.example/feed/?sv=2021-08-06&sig=SUPERSECRETSIGNATURE#frag");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.RequestUri.AbsoluteUri);
        Assert.Equal("?sv=2021-08-06&sig=SUPERSECRETSIGNATURE", resolution.RegistryUri.Query);
    }

    [Fact]
    public void Resolve_FailsWhenAnNpmrcIsLargerThanTheSizeLimit()
    {
        // npm has no such bound: it would read the file and install from whatever registry it names.
        // Skipping it here would silently hand the answer to a lower-precedence layer and advertise
        // an update from a registry the recommended command will not use.
        WriteHomeNpmrcBytes(Encoding.UTF8.GetBytes(new string('#', (1024 * 1024) + 1)));

        var exception = Assert.Throws<InvalidOperationException>(() => CreateResolver().Resolve(PackageName));

        Assert.Contains(Path.Combine(_root.FullName, "home", ".npmrc"), exception.Message);
    }

    [Fact]
    public void Resolve_RedactsQueryAndFragmentFromTheDisplayUri()
    {
        // A registry address can carry its credential in the query rather than the authority - an
        // Azure Storage-backed or Artifactory feed signs the URL - and DisplayUri reaches the debug
        // log and the timeout message. PackageSourceRedactor already strips the query from NuGet
        // sources for this reason.
        WriteHomeNpmrc("registry=https://npm.contoso.example/feed/?sv=2021-08-06&sig=SUPERSECRETSIGNATURE#frag");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/feed/", resolution.DisplayUri);
    }

    [Fact]
    public void Resolve_StripsEmbeddedCredentialsFromTheRequestUri()
    {
        WriteHomeNpmrc("registry=https://user:super-secret-token@npm.contoso.example/feed/");

        var resolution = CreateResolver().Resolve(PackageName);

        Assert.Equal(string.Empty, resolution.RequestUri.UserInfo);
        Assert.Equal("https://npm.contoso.example/feed/", resolution.RequestUri.AbsoluteUri);
    }

    [Fact]
    public void Resolve_UnscopedPackageUsesGlobalRegistry()
    {
        WriteHomeNpmrc(
            "registry=https://npm.contoso.example/general/",
            "@microsoft:registry=https://npm.contoso.example/microsoft/");

        Assert.Equal(
            "https://npm.contoso.example/general/",
            CreateResolver().Resolve("playwright").RegistryUri.AbsoluteUri);
    }

    private NpmRegistryResolver CreateResolver(
        DirectoryInfo? workingDirectory = null,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        return new NpmRegistryResolver(
            workingDirectory ?? CreateWorkingDirectory("work"),
            new DirectoryInfo(Path.Combine(_root.FullName, "home")),
            new Dictionary<string, string>(
                environment ?? new Dictionary<string, string>(),
                NpmRegistryResolver.EnvironmentVariableNameComparer),
            NullLogger<NpmRegistryResolver>.Instance);
    }

    private DirectoryInfo CreateWorkingDirectory(params string[] segments)
    {
        var path = Path.Combine([_root.FullName, .. segments]);
        return Directory.CreateDirectory(path);
    }

    private void WriteHomeNpmrc(params string[] lines)
    {
        var home = Directory.CreateDirectory(Path.Combine(_root.FullName, "home"));
        File.WriteAllLines(Path.Combine(home.FullName, ".npmrc"), lines);
    }

    private void WriteHomeNpmrcBytes(byte[] contents)
    {
        var home = Directory.CreateDirectory(Path.Combine(_root.FullName, "home"));
        File.WriteAllBytes(Path.Combine(home.FullName, ".npmrc"), contents);
    }

    public void Dispose()
    {
        try
        {
            _root.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
