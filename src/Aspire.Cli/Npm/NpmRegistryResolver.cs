// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Buffers;
using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Aspire.Cli.Npm;

/// <summary>
/// Resolves the npm registry for a package by reading the same configuration npm itself reads.
/// </summary>
// The update check exists to answer "can the command we are about to recommend actually install
// something newer?". That command is `npm install -g @microsoft/aspire-cli@latest`, and npm resolves
// it against the *user's* configured registry. Enterprises routinely block registry.npmjs.org and
// pin "registry=" to an internal proxy, so a hardcoded public-npm lookup would fail for exactly the
// users whose install would have succeeded.
//
// Configuration is read directly rather than by shelling out to `npm config get registry`. Spawning
// npm costs a process launch on the command startup path and would reintroduce a Node-on-PATH
// requirement that the HTTP-based lookup deliberately removed.
//
// Nothing outside `registry`, `<scope>:registry`, `userconfig`, `globalconfig`, and `prefix` is
// ever retained.
// Credential keys such as "//registry.example.com/:_authToken" are rejected by the allow list before
// their value is parsed out of the line, and the environment layer keeps only the `npm_config_*`
// variables that clear the same allow list, so no process environment value and no credential entry
// outlives the parse. A .npmrc line and the value behind a "${VAR}" reference still pass through
// managed strings while they are being read, which no in-process parser can avoid; the guarantee is
// that they are not held afterwards.
//
// The one credential that can outlive the parse is one the user wrote into the registry address
// itself, as a "user:token@" authority or as a signed query string. It survives only in
// NpmRegistryResolution.RegistryUri, which models the registry npm selected rather than anything
// sent anywhere. RequestUri is that address with the userinfo and query removed and is the only form
// the client composes a request from, and DisplayUri is the only form that reaches the debug log and
// the timeout message.
//
// The lookup is therefore anonymous: no Authorization header, no credential in the request address,
// and no payload beyond the package name. It does follow the scheme of the configured registry, so a
// registry configured as "http://" is read over plaintext HTTP; npm supports http registries, and
// refusing them here would silently disable the update check for an internal mirror rather than
// protect it.
//
// See https://docs.npmjs.com/cli/using-npm/config for the precedence rules implemented here.
internal sealed class NpmRegistryResolver : INpmRegistryResolver
{
    /// <summary>
    /// npm's built-in <c>registry</c> default, used when no configuration layer supplies one.
    /// </summary>
    internal static Uri DefaultRegistryUri { get; } = new("https://registry.npmjs.org/");

    internal const string RegistryKey = "registry";

    /// <summary>The value ini stores for a key written without an <c>=</c>.</summary>
    private const string IniBooleanTrue = "true";
    internal const string EnvironmentVariablePrefix = "npm_config_";

    private const string ScopedRegistryKeySuffix = ":registry";
    private const string UserConfigKey = "userconfig";
    private const string GlobalConfigKey = "globalconfig";
    private const string PrefixKey = "prefix";
    private const string NpmrcFileName = ".npmrc";

    // npm's global npmrc has no leading dot: resolve(prefix, 'etc/npmrc').
    private const string GlobalNpmrcFileName = "npmrc";

    // npm expands ${VAR} by indexing Node's process.env, which is case-insensitive only on Windows.
    // Matching that means ${npm_host} must not pick up NPM_HOST on Linux or macOS, where npm would
    // leave the reference unexpanded and install from a different registry than we probed.
    // See https://nodejs.org/api/process.html#processenv.
    internal static StringComparer EnvironmentVariableNameComparer { get; } =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    // npm's env-replace name group is [^${}?]+, so a reference containing any of these is not a
    // reference at all. '}' cannot appear because scanning stops at the first one.
    private static readonly SearchValues<char> s_charactersExcludedFromVariableNames = SearchValues.Create("${?");

    // A .npmrc is a small ini file; anything this large is not one, and the update check should
    // not read an arbitrarily large file off disk on the startup path.
    private const int MaximumNpmrcSizeInBytes = 1024 * 1024;

    private readonly DirectoryInfo _homeDirectory;
    private readonly ILogger<NpmRegistryResolver> _logger;
    private readonly IReadOnlyDictionary<string, string> _npmConfigVariables;
    private readonly Func<string, string?> _lookupEnvironmentVariable;
    private readonly Lock _configurationLock = new();

    private IReadOnlyDictionary<string, ConfigurationValue>? _configuration;

    public NpmRegistryResolver(CliExecutionContext executionContext, ILogger<NpmRegistryResolver> logger)
        : this(
            executionContext.WorkingDirectory,
            executionContext.HomeDirectory,
            ReadNpmConfigVariables(),
            // Reading each ${VAR} on demand keeps unrelated process values - cloud credentials,
            // NPM_TOKEN, CI secrets - out of this singleton, which lives for the whole command.
            Environment.GetEnvironmentVariable,
            logger)
    {
    }

    internal NpmRegistryResolver(
        DirectoryInfo workingDirectory,
        DirectoryInfo homeDirectory,
        IReadOnlyDictionary<string, string> environment,
        ILogger<NpmRegistryResolver> logger)
        : this(
            workingDirectory,
            homeDirectory,
            FilterNpmConfigVariables(environment),
            CreateEnvironmentVariableLookup(environment),
            logger)
    {
    }

    private NpmRegistryResolver(
        DirectoryInfo workingDirectory,
        DirectoryInfo homeDirectory,
        IReadOnlyDictionary<string, string> npmConfigVariables,
        Func<string, string?> lookupEnvironmentVariable,
        ILogger<NpmRegistryResolver> logger)
    {
        ArgumentNullException.ThrowIfNull(workingDirectory);
        ArgumentNullException.ThrowIfNull(homeDirectory);
        ArgumentNullException.ThrowIfNull(npmConfigVariables);
        ArgumentNullException.ThrowIfNull(lookupEnvironmentVariable);
        ArgumentNullException.ThrowIfNull(logger);

        _homeDirectory = homeDirectory;
        _npmConfigVariables = npmConfigVariables;
        _lookupEnvironmentVariable = lookupEnvironmentVariable;
        _logger = logger;
    }

    public NpmRegistryResolution Resolve(string packageName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageName);

        var configuration = GetConfiguration();

        // npm consults "<scope>:registry" before the global "registry" for a scoped package, so a
        // user who routes only @microsoft through an internal proxy is honored.
        // See https://docs.npmjs.com/cli/using-npm/scope#associating-a-scope-with-a-registry.
        if (TryGetScope(packageName, out var scope) &&
            TryResolveKey(configuration, scope + ScopedRegistryKeySuffix, out var scopedResolution))
        {
            return scopedResolution;
        }

        if (TryResolveKey(configuration, RegistryKey, out var resolution))
        {
            return resolution;
        }

        return new NpmRegistryResolution(DefaultRegistryUri, "the npm built-in default");
    }

    private bool TryResolveKey(
        IReadOnlyDictionary<string, ConfigurationValue> configuration,
        string key,
        [NotNullWhen(true)] out NpmRegistryResolution? resolution)
    {
        resolution = null;

        if (!configuration.TryGetValue(key, out var value))
        {
            return false;
        }

        if (value.Value is null)
        {
            // npm does not fall back when the selected registry is unusable: the value stays
            // selected at its layer and the request npm builds from it fails. Falling back to the
            // next key or to public npm would report an update that the recommended
            // "npm install -g" cannot install, so the whole check fails instead and the caller
            // reports no update. The message names the key and its source but never the value,
            // which may embed a credential.
            throw new InvalidOperationException(
                $"The npm registry configured by '{key}' in {value.Source} is not an absolute http or https address.");
        }

        // The value was normalized into an absolute http(s) address when it was retained, so it
        // cannot fail to parse here.
        resolution = new NpmRegistryResolution(new Uri(value.Value, UriKind.Absolute), value.Source);
        _logger.LogDebug("Resolved npm '{Key}' to {Registry} from {Source}.", key, resolution.DisplayUri, value.Source);

        return true;
    }

    private IReadOnlyDictionary<string, ConfigurationValue> GetConfiguration()
    {
        // npm configuration cannot change under a running command, so the layers are read once and
        // reused. The lock keeps concurrent update checks (background prefetch racing an explicit
        // doctor run) from each doing the file I/O.
        lock (_configurationLock)
        {
            return _configuration ??= BuildConfiguration();
        }
    }

    private Dictionary<string, ConfigurationValue> BuildConfiguration()
    {
        // Highest precedence first; the first layer to supply a key wins, matching the subset of
        // npm's cli > env > user > global > builtin ordering that applies to the global install
        // command doctor recommends. Project .npmrc files are deliberately skipped: npm documents
        // that they are not read in global mode, and the suggested remedy is
        // "npm install -g @microsoft/aspire-cli@latest".
        // See https://docs.npmjs.com/cli/v10/configuring-npm/npmrc#per-project-config-file.
        //
        // npm's builtin npmrc (the one beside its own installation) is not read because locating it
        // requires npm's install prefix, which is only discoverable by running npm - the process
        // launch this lookup exists to avoid. The global layer is read only when something
        // explicitly points at it, because npm's default for it is also prefix-derived.
        var configuration = new Dictionary<string, ConfigurationValue>(StringComparer.Ordinal);

        MergeEnvironment(configuration);

        MergeNpmrcFile(configuration, GetUserConfigPath(configuration));

        // npm loads the global npmrc after the user one, so it only supplies keys nothing above it
        // set. It is resolved after the user file is merged because the user file is allowed to
        // declare globalconfig, exactly as npm's load order allows.
        MergeNpmrcFile(configuration, GetGlobalConfigPath(configuration));

        return configuration;
    }

    private void MergeEnvironment(Dictionary<string, ConfigurationValue> configuration)
    {
        // npm maps any "npm_config_<key>" variable onto config key "<key>", case-insensitively on
        // the prefix, so both npm_config_registry and NPM_CONFIG_REGISTRY are honored. npm also
        // injects these into the environment of scripts it runs, which makes them the right
        // highest-precedence layer when the CLI is launched through npm exec or npx.
        // npm's loadEnv assigns every npm_config_* variable into one object, so when two variable
        // names normalize to the same config key the later one wins. Both npm_config_registry and
        // NPM_CONFIG_REGISTRY can be set at once wherever environment names are case-sensitive, so
        // the environment layer is collapsed last-wins here before it is merged first-wins against
        // the files below it.
        var layer = new Dictionary<string, ConfigurationValue>(StringComparer.Ordinal);

        foreach (var (name, value) in _npmConfigVariables)
        {
            if (!TryGetNpmConfigKey(name, out var key))
            {
                continue;
            }

            // npm hands every layer's values to parseField, which trims them and substitutes
            // ${VAR}, so an environment layer is no more literal than a file layer. Path-typed
            // options such as userconfig are expanded where they are consumed.
            // npm's loadEnv skips an npm_config_* variable whose value is the empty string, so an
            // empty variable is absent rather than configured-and-unusable the way "registry=" in
            // a .npmrc is.
            if (value is null || value.Length == 0)
            {
                continue;
            }

            var rawValue = value.Trim();

            // npm's envReplace leaves each undefined "${VAR}" in place instead of dropping the
            // entry, so the value stays selected at this precedence and npm's own request fails.
            // Keeping the literal reproduces that rather than silently consulting a
            // lower-precedence layer.
            // See https://github.com/npm/config/blob/main/lib/env-replace.js.
            var configuredValue = ExpandEnvironmentReferences(rawValue);

            if (TryCreateConfigurationValue(key, configuredValue, $"the {name} environment variable", out var configurationValue))
            {
                layer[key] = configurationValue;
            }
        }

        foreach (var (key, value) in layer)
        {
            configuration.TryAdd(key, value);
        }
    }

    private void MergeNpmrcFile(Dictionary<string, ConfigurationValue> configuration, string? path)
    {
        if (path is null || !File.Exists(path))
        {
            return;
        }

        byte[] contents;

        try
        {
            var fileInfo = new FileInfo(path);

            if (fileInfo.Length > MaximumNpmrcSizeInBytes)
            {
                // Skipping the file would silently hand the answer to a lower-precedence layer, and
                // npm has no matching bound: it would read this file and install from whatever
                // registry it names. Reporting an update from a registry the recommended command
                // will not use is worse than reporting no update at all, so the bound stays and the
                // lookup fails instead of quietly changing precedence. The path is named; nothing
                // from inside the file is, because it was never read.
                throw new InvalidOperationException(
                    $"The npm configuration file {path} is larger than the {MaximumNpmrcSizeInBytes} byte limit this resolver will read.");
            }

            contents = File.ReadAllBytes(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            // An unreadable .npmrc must not fail the update check; the next layer (or the npm
            // default) still produces a usable answer.
            _logger.LogDebug(exception, "Could not read npm configuration from {Path}.", path);
            return;
        }

        // The file is decoded into a pooled buffer and scanned as spans rather than read into
        // strings. Reading lines would put every "//registry.example.com/:_authToken=..." entry on
        // the managed heap as a string that lives until a collection runs; here only allow-listed
        // keys and their values are ever materialized, and both buffers are cleared on the way out.
        // The size cap above is what makes a single-shot read safe.
        var buffer = ArrayPool<char>.Shared.Rent(Encoding.UTF8.GetMaxCharCount(contents.Length));

        try
        {
            var characterCount = Encoding.UTF8.GetChars(RemoveByteOrderMark(contents), buffer);

            MergeNpmrcLines(configuration, buffer.AsSpan(0, characterCount), path);
        }
        finally
        {
            Array.Clear(buffer);
            ArrayPool<char>.Shared.Return(buffer);
            Array.Clear(contents);
        }
    }

    private void MergeNpmrcLines(Dictionary<string, ConfigurationValue> configuration, ReadOnlySpan<char> contents, string path)
    {
        var fileConfiguration = new Dictionary<string, ConfigurationValue>(StringComparer.Ordinal);

        // Values are collected raw and only turned into configuration once the file is read,
        // because ini can still convert a key into an array after it has been assigned: once
        // "registry[]" has appeared, a later plain "registry=" is pushed onto the array instead of
        // replacing it. Joining normalized values would not reproduce what npm sees either, since
        // npm reads the array through String(value).
        var collectedValues = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var arrayKeys = new HashSet<string>(StringComparer.Ordinal);

        while (!contents.IsEmpty)
        {
            // Split exactly like File.ReadAllLines: "\r\n" is one terminator, and a lone "\r" or
            // "\n" also ends a line. Unicode separators such as U+2028 stay inside the value,
            // which is what npm's ini parser does.
            var terminatorIndex = contents.IndexOfAny('\r', '\n');
            ReadOnlySpan<char> line;

            if (terminatorIndex < 0)
            {
                line = contents;
                contents = default;
            }
            else
            {
                line = contents[..terminatorIndex];
                var skip = contents[terminatorIndex] == '\r' && terminatorIndex + 1 < contents.Length && contents[terminatorIndex + 1] == '\n'
                    ? 2
                    : 1;
                contents = contents[(terminatorIndex + skip)..];
            }

            if (IsIniSectionHeader(line))
            {
                // npm parses .npmrc with the ini package, which nests every following assignment
                // under the section, so npm never sees it as top-level config: "[tool]" followed by
                // "registry=..." leaves the install registry unset. ini offers no way back to the
                // top level, so nothing after the first header can affect the registry npm uses.
                _logger.LogDebug("Ignoring the remainder of {Path} because npm nests it under the {Section} section.", path, line.ToString());
                break;
            }

            // The key is allow-listed before the value is parsed out of the line, so a
            // "//registry.example.com/:_authToken=..." entry never becomes a token-bearing string.
            // npm substitutes ${VAR} in keys as well as values, so "@${NPM_SCOPE}:registry" has to
            // be expanded before the allow-list decides whether the entry is interesting at all.
            if (!TryParseNpmrcKey(line, out var rawKey, out var rawValue, out var hasAssignment))
            {
                continue;
            }

            // ini strips a "[]" suffix from the decoded key and turns the entry into an array, so
            // "registry[]=https://mirror.example/" names the plain `registry` key in npm. The
            // suffix is removed before the allow list and before the substitution check, because
            // it is ini syntax rather than anything the environment put there. ini requires more
            // than the suffix itself, so a key that is exactly "[]" is not an array.
            // See https://github.com/npm/ini/blob/main/lib/ini.js (isArray is computed from the
            // unsafe()-decoded key, which is why the suffix is stripped after ParseNpmrcValue).
            var isArrayEntry = rawKey.Length > 2 && rawKey.EndsWith("[]", StringComparison.Ordinal);
            var scalarRawKey = isArrayEntry ? rawKey[..^2] : rawKey;

            var key = ExpandEnvironmentReferences(scalarRawKey);

            if (!IsInterestingKey(key) || !CanRetainExpandedKey(scalarRawKey, key))
            {
                continue;
            }

            if (isArrayEntry)
            {
                arrayKeys.Add(key);
            }

            // ini yields the boolean true for a bare key line. npm rejects that as a url exactly
            // as it rejects the empty string from a "registry=" line, so both have to reach the
            // unusable marker rather than look like an absent key.
            var parsedValue = hasAssignment ? ParseNpmrcValue(rawValue) : IniBooleanTrue;

            if (!collectedValues.TryGetValue(key, out var collected))
            {
                collected = [];
                collectedValues[key] = collected;
            }
            else if (!arrayKeys.Contains(key))
            {
                // A duplicate scalar key inside one ini file is last-wins.
                collected.Clear();
            }

            // See the matching comment in MergeEnvironment: npm leaves an undefined "${VAR}"
            // literal rather than dropping the entry, so the layer stays selected and unusable.
            collected.Add(ExpandEnvironmentReferences(parsedValue));
        }

        foreach (var (key, collected) in collectedValues)
        {
            // npm never sees the array itself; every consumer of `registry` turns it into a string,
            // and JS renders an array by joining its elements with ",". A single "registry[]" entry
            // therefore resolves to exactly that address, which is why the key cannot be dropped.
            SetIfPresent(fileConfiguration, key, string.Join(',', collected), path);
        }

        foreach (var (key, value) in fileConfiguration)
        {
            // Cross-layer precedence is still first-wins because layers are merged highest to
            // lowest. Only duplicate scalar keys inside one ini file are last-wins.
            configuration.TryAdd(key, value);
        }
    }

    /// <summary>
    /// Parses the key out of a single <c>.npmrc</c> line and hands back the value text unparsed.
    /// </summary>
    /// <remarks>
    /// <c>.npmrc</c> is ini-formatted. Representative content:
    /// <code>
    /// ; a comment
    /// # also a comment
    /// registry=https://npm.contoso.example/artifactory/api/npm/npm/
    /// @microsoft:registry = "https://npm.contoso.example/microsoft/"
    /// //npm.contoso.example/:_authToken=${NPM_TOKEN}
    /// </code>
    /// Values may be quoted and may contain '=' (a URL query), so only the first '=' separates the
    /// key from the value. The value is returned as a span rather than a string so the caller can
    /// reject a credential key through <see cref="IsInterestingKey"/> before
    /// <see cref="ParseNpmrcValue"/> ever materializes it.
    /// See https://github.com/npm/ini/blob/main/lib/ini.js.
    /// </remarks>
    private static bool IsIniSectionHeader(ReadOnlySpan<char> line)
    {
        // ini matches sections with /^\[([^\]]*)\]\s*$/ against the raw line, so the bracket must be
        // the very first character and only whitespace may follow the closing bracket:
        //   "[tool]"        -> section
        //   "[tool]   "     -> section
        //   "  [tool]"      -> bare key, because of the leading whitespace
        //   "[tool] ; note" -> bare key, because ini allows no trailing comment here
        //   "[to]ol]"       -> bare key, because [^\]]* cannot cross the first bracket
        // https://github.com/npm/ini/blob/latest/lib/ini.js
        if (line.IsEmpty || line[0] is not '[')
        {
            return false;
        }

        var closingIndex = line.IndexOf(']');

        return closingIndex >= 0 && line[(closingIndex + 1)..].IsWhiteSpace();
    }

    private static ReadOnlySpan<byte> RemoveByteOrderMark(ReadOnlySpan<byte> contents)
    {
        // Decoding by hand means the UTF-8 BOM is no longer stripped for us. An editor that writes
        // one would otherwise turn the first key into "\uFEFFregistry", which silently drops the
        // most important entry in the file.
        return contents.StartsWith("\uFEFF"u8) ? contents[3..] : contents;
    }

    private static bool TryParseNpmrcKey(
        ReadOnlySpan<char> line,
        out string key,
        out ReadOnlySpan<char> rawValue,
        out bool hasAssignment)
    {
        key = string.Empty;
        rawValue = default;
        hasAssignment = false;

        var trimmed = line.Trim();

        // '[' opens an ini section header. npm's own config keys are never sectioned, so a section
        // header carries nothing this resolver needs.
        if (trimmed.IsEmpty || trimmed[0] is ';' or '#' or '[')
        {
            return false;
        }

        var separatorIndex = trimmed.IndexOf('=');

        // A line with nothing before the '=' names the empty key, which is never interesting.
        if (separatorIndex == 0)
        {
            return false;
        }

        // ini stores a line with no '=' as the boolean true rather than skipping it, so a bare
        // "registry" line does configure the key. npm then rejects true as a url.
        hasAssignment = separatorIndex > 0;

        var parsedKey = hasAssignment ? trimmed[..separatorIndex].Trim() : trimmed;

        if (parsedKey.IsEmpty)
        {
            return false;
        }

        // ini runs its unsafe() decoder over the key half as well as the value half, so
        //   "registry"=https://mirror.example/
        // names the plain "registry" key in npm. Only a fully quoted key is unquoted, which is why
        //   "scope":registry=https://s.example/
        // keeps its quotes in npm too and is rejected by the allow list here.
        // See https://github.com/npm/ini/blob/main/lib/ini.js (decode calls unsafe on match[2]).
        key = ParseNpmrcValue(parsedKey);

        if (key.Length == 0)
        {
            return false;
        }

        rawValue = hasAssignment ? trimmed[(separatorIndex + 1)..].Trim() : default;

        return true;
    }

    /// <summary>
    /// Parses the value half of a <c>.npmrc</c> line.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Unquoted values follow npm/ini comment rules: the first unescaped <c>;</c> or <c>#</c>
    /// starts an inline comment, while <c>\;</c>, <c>\#</c>, and <c>\\</c> unescape to literal
    /// characters.
    /// </para>
    /// <para>
    /// A value that both starts and ends with a quote is handed to <c>JSON.parse</c> by ini, after
    /// stripping the quotes first when they are single ones. That makes escape sequences in a
    /// double-quoted value live, so <c>registry="https://npm.example/\u0066eed/"</c> names
    /// <c>/feed/</c>. Anything <c>JSON.parse</c> rejects keeps whatever ini was holding at that
    /// point, which still carries the double quotes but not the single ones. A quote followed by an
    /// inline comment is not "quoted" at all under that rule, because ini tests the last character
    /// of the untrimmed value, so it takes the unquoted path and keeps its quotes.
    /// See https://github.com/npm/ini/blob/main/lib/ini.js.
    /// </para>
    /// </remarks>
    private static string ParseNpmrcValue(ReadOnlySpan<char> value)
    {
        if (value.Length >= 2 &&
            (value[0] is '"' && value[^1] is '"' || value[0] is '\'' && value[^1] is '\''))
        {
            // ini drops single quotes before parsing, so an unparseable single-quoted value keeps
            // the stripped text while an unparseable double-quoted one keeps its quotes.
            var candidate = value[0] is '\'' ? value[1..^1].ToString() : value.ToString();

            return TryParseJsonString(candidate, out var decoded) ? decoded : candidate;
        }

        var builder = new System.Text.StringBuilder(value.Length);
        var escaping = false;

        foreach (var c in value)
        {
            if (escaping)
            {
                if (c is ';' or '#' or '\\')
                {
                    builder.Append(c);
                }
                else
                {
                    builder.Append('\\');
                    builder.Append(c);
                }

                escaping = false;
                continue;
            }

            if (c is '\\')
            {
                escaping = true;
                continue;
            }

            if (c is ';' or '#')
            {
                break;
            }

            builder.Append(c);
        }

        if (escaping)
        {
            builder.Append('\\');
        }

        return builder.ToString().Trim();
    }

    /// <summary>
    /// Expands the <c>${VAR}</c> references npm substitutes from the environment when it loads a
    /// <c>.npmrc</c>.
    /// </summary>
    /// <remarks>
    /// npm matches <c>/(?&lt;!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g</c>: the name may not contain
    /// <c>$</c>, <c>{</c>, <c>}</c>, or <c>?</c>, and a trailing <c>?</c> marks the reference
    /// optional, meaning an undefined variable expands to the empty string instead of being left
    /// in place. A backslash run in front of <c>${</c> is halved, and an odd run escapes the
    /// reference so it stays literal. Text that does not match that shape is copied through
    /// untouched, matching npm's behavior of leaving a non-reference literal.
    /// See https://github.com/npm/cli/blob/latest/workspaces/config/lib/env-replace.js.
    /// </remarks>
    private string ExpandEnvironmentReferences(string value)
    {
        if (!value.Contains("${", StringComparison.Ordinal))
        {
            return value;
        }

        var builder = new System.Text.StringBuilder(value.Length);
        var index = 0;

        while (index < value.Length)
        {
            var start = value.IndexOf("${", index, StringComparison.Ordinal);

            if (start < 0)
            {
                builder.Append(value, index, value.Length - index);
                break;
            }

            var end = value.IndexOf('}', start + 2);

            if (end < 0)
            {
                builder.Append(value, index, value.Length - index);
                break;
            }

            var reference = value.AsSpan((start + 2)..end);
            var isOptional = reference.EndsWith("?", StringComparison.Ordinal);
            var variableName = isOptional ? reference[..^1] : reference;

            if (variableName.IsEmpty || variableName.ContainsAny(s_charactersExcludedFromVariableNames))
            {
                // Not a reference npm would expand, so copy "${...}" through verbatim. Such a value
                // cannot parse as a registry address, which is exactly what npm ends up using.
                builder.Append(value, index, end + 1 - index);
                index = end + 1;
                continue;
            }

            // npm's pattern captures the backslash run in front of "${" and halves it: an odd run
            // escapes the reference and leaves it literal, an even run expands it. Half the
            // backslashes survive either way, so "\${HOME}" is the literal "${HOME}" and
            // "\\${HOME}" is one backslash followed by the value.
            var escapeStart = start;

            while (escapeStart > index && value[escapeStart - 1] is '\\')
            {
                escapeStart--;
            }

            var escapeLength = start - escapeStart;

            builder.Append(value, index, escapeStart - index);
            builder.Append('\\', escapeLength / 2);

            if (escapeLength % 2 is not 0)
            {
                builder.Append(value, start, end + 1 - start);
                index = end + 1;
                continue;
            }

            var variableValue = _lookupEnvironmentVariable(variableName.ToString());

            if (variableValue is null)
            {
                if (!isOptional)
                {
                    // npm's fallback for a missing mandatory reference is the literal "${NAME}",
                    // applied per reference by String.replace. Substitutions already made for other
                    // variables in the same value survive, so "https://host/${SEGMENT}/${MISSING}/"
                    // with SEGMENT=feed becomes "https://host/feed/${MISSING}/" rather than
                    // reverting to the raw text.
                    builder.Append(value, start, end + 1 - start);
                    index = end + 1;
                    continue;
                }

                variableValue = string.Empty;
            }

            builder.Append(variableValue);
            index = end + 1;
        }

        return builder.ToString();
    }

    private string? GetUserConfigPath(IReadOnlyDictionary<string, ConfigurationValue> configuration)
    {
        // npm_config_userconfig relocates the user layer, and tooling that isolates npm (CI images,
        // sandboxes) sets it. Honor it before falling back to the home directory.
        if (configuration.TryGetValue(UserConfigKey, out var userConfig) &&
            !string.IsNullOrWhiteSpace(userConfig.Value))
        {
            return ResolveConfiguredPath(userConfig.Value);
        }

        return Path.Combine(_homeDirectory.FullName, NpmrcFileName);
    }

    /// <summary>
    /// Decodes <paramref name="candidate"/> the way ini's <c>JSON.parse</c> call does, reporting
    /// failure for anything that is not a JSON string so the caller can keep the raw text.
    /// </summary>
    private static bool TryParseJsonString(string candidate, [NotNullWhen(true)] out string? value)
    {
        value = null;

        // JSON.parse accepts any JSON value, but only a string can name a registry. A number or a
        // literal reaches npm as a non-string that its own URL handling would reject anyway, so
        // treating those as undecodable keeps the raw text and lets the URL check reject it.
        if (candidate.Length < 2 || candidate[0] is not '"')
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(candidate);

            if (document.RootElement.ValueKind is not JsonValueKind.String)
            {
                return false;
            }

            value = document.RootElement.GetString();
            return value is not null;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private string? GetGlobalConfigPath(IReadOnlyDictionary<string, ConfigurationValue> configuration)
    {
        // An explicitly configured globalconfig wins, exactly as it does for npm.
        if (configuration.TryGetValue(GlobalConfigKey, out var globalConfig) &&
            !string.IsNullOrWhiteSpace(globalConfig.Value))
        {
            return ResolveConfiguredPath(globalConfig.Value);
        }

        // Otherwise npm derives it: `resolve(prefix, 'etc/npmrc')`. The default prefix is npm's own
        // install location and is only knowable by launching npm, but a configured prefix needs no
        // such probe - verified against @npmcli/config 11.0.1, where npm_config_prefix=/corp yields
        // globalconfig /corp/etc/npmrc. An enterprise that sets prefix and pins the registry in the
        // npmrc underneath it would otherwise be resolved against public npm, advertising an update
        // the recommended global install cannot fetch.
        // See https://github.com/npm/cli/blob/latest/workspaces/config/lib/index.js (globalPrefix).
        if (configuration.TryGetValue(PrefixKey, out var prefix) &&
            !string.IsNullOrWhiteSpace(prefix.Value))
        {
            return Path.Combine(ResolveConfiguredPath(prefix.Value), "etc", GlobalNpmrcFileName);
        }

        return null;
    }

    /// <summary>
    /// Applies the normalization npm's <c>parseField</c> gives a path-typed option such as
    /// <c>userconfig</c>.
    /// </summary>
    /// <remarks>
    /// npm expands a leading <c>~/</c> (also <c>~\</c> on Windows) against the home directory and
    /// otherwise resolves the value against the working directory, so <c>userconfig=~/.npmrc</c>
    /// and <c>userconfig=.npmrc</c> both name a real file rather than a literal that never exists.
    /// See https://github.com/npm/cli/blob/latest/workspaces/config/lib/parse-field.js.
    /// </remarks>
    private string ResolveConfiguredPath(string value)
    {
        var isHomeReference = value.StartsWith("~/", StringComparison.Ordinal) ||
            (OperatingSystem.IsWindows() && value.StartsWith(@"~\", StringComparison.Ordinal));

        try
        {
            return isHomeReference
                ? Path.GetFullPath(Path.Combine(_homeDirectory.FullName, value[2..]))
                : Path.GetFullPath(value);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            // npm would hand the unusable path to its own file read and get nothing back, so
            // keeping the raw value reaches the same outcome through the File.Exists check.
            _logger.LogDebug("Could not resolve the npm userconfig path {Path}.", value);
            return value;
        }
    }

    private static void SetIfPresent(
        Dictionary<string, ConfigurationValue> configuration,
        string key,
        string? value,
        string source)
    {
        if (TryCreateConfigurationValue(key, value, source, out var configurationValue))
        {
            configuration[key] = configurationValue;
        }
    }

    private static bool TryCreateConfigurationValue(
        string key,
        string? value,
        string source,
        [NotNullWhen(true)] out ConfigurationValue? configurationValue)
    {
        configurationValue = null;

        if (value is null)
        {
            return false;
        }

        var trimmed = value.Trim();

        if (!IsRegistryKey(key))
        {
            // A path-typed redirect with no value names no file, so nothing is configured.
            if (trimmed.Length == 0)
            {
                return false;
            }

            configurationValue = new ConfigurationValue(trimmed, source);
            return true;
        }

        // A registry value only ever becomes a request address, so it is normalized once here
        // instead of at every lookup. A value that cannot become one is retained as null rather
        // than as text: the null still marks the key as configured, which is what keeps resolution
        // from falling through to a lower-precedence registry, without holding a string such as
        // "https://user:${NPM_TOKEN}@host/" whose reference was already substituted above.
        configurationValue = TryCreateRegistryUri(trimmed, out var registryUri)
            ? new ConfigurationValue(registryUri.AbsoluteUri, source)
            : new ConfigurationValue(null, source);

        return true;
    }

    /// <summary>
    /// Limits what is retained to the registry keys and the keys that locate an npmrc, so credential
    /// entries in a <c>.npmrc</c> or in the process environment are never retained.
    /// </summary>
    private static bool IsInterestingKey(string key)
    {
        return IsRegistryKey(key) || key is UserConfigKey or GlobalConfigKey or PrefixKey;
    }

    private static bool IsRegistryKey(string key)
    {
        return key is RegistryKey || key.EndsWith(ScopedRegistryKeySuffix, StringComparison.Ordinal);
    }

    /// <summary>
    /// Rejects a key that only cleared the allow list because an environment value was substituted
    /// into it.
    /// </summary>
    /// <remarks>
    /// Keys are retained for the resolver's lifetime, so <c>@${NPM_TOKEN}:registry</c> would leave
    /// an ambient secret in memory long after the parse - the outcome the allow list exists to
    /// prevent. The fixed keys carry no free-form text and cannot smuggle one out, so they are
    /// still expanded the way npm's own <c>#loadObject</c> expands them.
    /// </remarks>
    private static bool CanRetainExpandedKey(string rawKey, string expandedKey)
    {
        return string.Equals(rawKey, expandedKey, StringComparison.Ordinal) ||
            expandedKey is RegistryKey or UserConfigKey or GlobalConfigKey or PrefixKey;
    }

    private static string NormalizeEnvironmentKey(string key)
    {
        // Only the environment layer is normalized, and only the way npm's loadEnv normalizes it:
        // underscores after the first character become dashes and the result is lowercased, unless
        // the key is nerf-darted ("//registry.example.com/:_authToken"), which is left alone.
        // Keys read from a .npmrc keep their casing, so "REGISTRY=" and "@Microsoft:registry" are
        // dead entries for npm and have to stay dead here too.
        // https://github.com/npm/cli/blob/latest/workspaces/config/lib/index.js
        if (key.StartsWith("//", StringComparison.Ordinal))
        {
            return key;
        }

        return string.Create(key.Length, key, static (destination, source) =>
        {
            for (var i = 0; i < source.Length; i++)
            {
                destination[i] = i > 0 && source[i] is '_' ? '-' : char.ToLowerInvariant(source[i]);
            }
        });
    }

    private static bool TryGetScope(string packageName, [NotNullWhen(true)] out string? scope)
    {
        scope = null;

        if (packageName.Length == 0 || packageName[0] is not '@')
        {
            return false;
        }

        var separatorIndex = packageName.IndexOf('/');

        if (separatorIndex <= 1)
        {
            return false;
        }

        scope = packageName[..separatorIndex].ToLowerInvariant();
        return true;
    }

    internal static bool TryCreateRegistryUri(string? value, [NotNullWhen(true)] out Uri? registryUri)
    {
        registryUri = null;

        if (string.IsNullOrWhiteSpace(value) ||
            !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var parsed) ||
            (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
        {
            return false;
        }

        // Registry values are habitually written without a trailing slash
        // ("https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry"). Uri composition replaces
        // the last segment of a base that does not end in '/', which would silently request
        // ".../npm/<package>" and drop "registry" from the feed path, so normalize before the value
        // is ever used as a base address.
        if (!parsed.AbsolutePath.EndsWith('/'))
        {
            parsed = new UriBuilder(parsed) { Path = parsed.AbsolutePath + "/" }.Uri;
        }

        registryUri = parsed;
        return true;
    }

    /// <summary>
    /// Snapshots the <c>npm_config_*</c> variables this resolver is allowed to use.
    /// </summary>
    /// <remarks>
    /// The process environment routinely carries credentials (<c>NPM_TOKEN</c>, cloud tokens, CI
    /// secrets). This resolver is a singleton that lives for the whole command, so only the
    /// variables that clear <see cref="IsInterestingKey"/> are copied out of it;
    /// <c>${VAR}</c> references are read on demand instead.
    /// </remarks>
    internal static Dictionary<string, string> ReadNpmConfigVariables()
    {
        var variables = new Dictionary<string, string>(EnvironmentVariableNameComparer);

        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string name && entry.Value is string value && TryGetNpmConfigKey(name, out _))
            {
                variables[name] = value;
            }
        }

        return variables;
    }

    private static Dictionary<string, string> FilterNpmConfigVariables(IReadOnlyDictionary<string, string> environment)
    {
        ArgumentNullException.ThrowIfNull(environment);

        var variables = new Dictionary<string, string>(EnvironmentVariableNameComparer);

        foreach (var (name, value) in environment)
        {
            if (TryGetNpmConfigKey(name, out _))
            {
                variables[name] = value;
            }
        }

        return variables;
    }

    private static Func<string, string?> CreateEnvironmentVariableLookup(IReadOnlyDictionary<string, string> environment)
    {
        ArgumentNullException.ThrowIfNull(environment);

        // Re-keyed rather than queried through the supplied dictionary so the caller's comparer
        // cannot decide whether ${npm_host} may pick up NPM_HOST; that answer belongs to the
        // platform. Assignment rather than Add because a Windows-comparer copy of a case-sensitive
        // source could otherwise throw, and the real Windows environment cannot hold both spellings.
        var lookup = new Dictionary<string, string>(EnvironmentVariableNameComparer);

        foreach (var (name, value) in environment)
        {
            lookup[name] = value;
        }

        return name => lookup.TryGetValue(name, out var value) ? value : null;
    }

    private static bool TryGetNpmConfigKey(string name, [NotNullWhen(true)] out string? key)
    {
        key = null;

        if (!name.StartsWith(EnvironmentVariablePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var candidate = NormalizeEnvironmentKey(name[EnvironmentVariablePrefix.Length..].Trim());

        if (!IsInterestingKey(candidate))
        {
            return false;
        }

        key = candidate;
        return true;
    }

    /// <summary>
    /// A configuration entry that survived the allow list, where <paramref name="Value"/> is null
    /// for a registry key whose configured value cannot be used as a request address.
    /// </summary>
    private sealed record ConfigurationValue(string? Value, string Source);
}
