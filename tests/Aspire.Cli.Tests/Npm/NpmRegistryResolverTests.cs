// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections;
using System.Text;
using Aspire.Cli.Npm;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Cli.Tests.Npm;

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
        // npm substitutes ${VAR} in config keys as well as values, so the scope this entry applies
        // to is only known after expansion.
        WriteHomeNpmrc("@${NPM_SCOPE}:registry=https://npm.contoso.example/scoped/");

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["NPM_SCOPE"] = "microsoft"
            }).Resolve(PackageName);

        Assert.Equal("https://npm.contoso.example/scoped/", resolution.RegistryUri.AbsoluteUri);
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
    [InlineData("registry")]
    [InlineData("registry=")]
    [InlineData("=https://npm.contoso.example/")]
    [InlineData("registry=file:///tmp/local")]
    [InlineData("registry=not-a-url")]
    public void Resolve_IgnoresUnusableNpmrcLines(string line)
    {
        WriteHomeNpmrc(line);

        Assert.Equal(PublicRegistry, CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
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

        var resolution = CreateResolver(
            environment: new Dictionary<string, string>
            {
                ["NPM_HOST"] = "npm.contoso.example"
            }).Resolve(PackageName);

        Assert.Equal(
            OperatingSystem.IsWindows() ? "https://npm.contoso.example/feed/" : PublicRegistry,
            resolution.RegistryUri.AbsoluteUri);
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
    public void Resolve_IgnoresEntryWithUndefinedEnvironmentReference()
    {
        WriteHomeNpmrc("registry=https://${NPM_HOST_NOT_SET}/feed/");

        Assert.Equal(PublicRegistry, CreateResolver().Resolve(PackageName).RegistryUri.AbsoluteUri);
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

        return key is "registry" or "userconfig" || key.EndsWith(":registry", StringComparison.Ordinal);
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
                StringComparer.OrdinalIgnoreCase),
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
