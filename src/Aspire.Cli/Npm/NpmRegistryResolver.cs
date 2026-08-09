// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Buffers;
using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Aspire.Cli.Npm;

/// <summary>
/// Resolves the npm registry for a package by reading the same configuration npm itself reads.
/// </summary>
/// <remarks>
/// <para>
/// The update check exists to answer "can the command we are about to recommend actually install
/// something newer?". That command is <c>npm install -g @microsoft/aspire-cli@latest</c>, and npm
/// resolves it against the <em>user's</em> configured registry. Enterprises routinely block
/// registry.npmjs.org and pin <c>registry=</c> to an internal proxy, so a hardcoded public-npm
/// lookup would fail for exactly the users whose install would have succeeded.
/// </para>
/// <para>
/// Configuration is read directly rather than by shelling out to <c>npm config get registry</c>.
/// Spawning npm costs a process launch on the command startup path and would reintroduce a
/// Node-on-PATH requirement that the HTTP-based lookup deliberately removed.
/// </para>
/// <para>
/// Nothing outside <c>registry</c>, <c>&lt;scope&gt;:registry</c>, and <c>userconfig</c> is ever
/// retained. Credential keys such as <c>//registry.example.com/:_authToken</c> are rejected by the
/// allow list before their value is parsed out of the line, and the environment layer keeps only
/// the <c>npm_config_*</c> variables that clear the same allow list, so no process environment
/// value and no credential entry outlives the parse. A <c>.npmrc</c> line and the value behind a
/// <c>${VAR}</c> reference still pass through managed strings while they are being read, which no
/// in-process parser can avoid; the guarantee is that they are not held afterwards. The lookup
/// itself is anonymous.
/// </para>
/// See https://docs.npmjs.com/cli/using-npm/config for the precedence rules implemented here.
/// </remarks>
internal sealed class NpmRegistryResolver : INpmRegistryResolver
{
    /// <summary>
    /// npm's built-in <c>registry</c> default, used when no configuration layer supplies one.
    /// </summary>
    internal static Uri DefaultRegistryUri { get; } = new("https://registry.npmjs.org/");

    internal const string RegistryKey = "registry";
    internal const string EnvironmentVariablePrefix = "npm_config_";

    private const string ScopedRegistryKeySuffix = ":registry";
    private const string UserConfigKey = "userconfig";
    private const string NpmrcFileName = ".npmrc";

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

        if (!TryCreateRegistryUri(value.Value, out var registryUri))
        {
            // A registry that cannot be turned into an absolute http(s) address is unusable, but it
            // is the user's configuration rather than a CLI fault. Fall through to the next layer
            // instead of failing the update check outright.
            _logger.LogDebug(
                "Ignoring unusable npm '{Key}' value from {Source}; it is not an absolute http or https address.",
                key,
                value.Source);
            return false;
        }

        resolution = new NpmRegistryResolution(registryUri, value.Source);
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
        // The npm CLI's own global and builtin npmrc layers are not read because locating them requires npm's install prefix,
        // which is only discoverable by running npm - the process launch this lookup exists to
        // avoid. Registry pinning lives in the env or user layer in practice.
        var configuration = new Dictionary<string, ConfigurationValue>(StringComparer.Ordinal);

        MergeEnvironment(configuration);

        MergeNpmrcFile(configuration, GetUserConfigPath(configuration));

        return configuration;
    }

    private void MergeEnvironment(Dictionary<string, ConfigurationValue> configuration)
    {
        // npm maps any "npm_config_<key>" variable onto config key "<key>", case-insensitively on
        // the prefix, so both npm_config_registry and NPM_CONFIG_REGISTRY are honored. npm also
        // injects these into the environment of scripts it runs, which makes them the right
        // highest-precedence layer when the CLI is launched through npm exec or npx.
        foreach (var (name, value) in _npmConfigVariables)
        {
            if (!TryGetNpmConfigKey(name, out var key))
            {
                continue;
            }

            // npm hands every layer's values to parseField, which trims them and substitutes
            // ${VAR}, so an environment layer is no more literal than a file layer. Path-typed
            // options such as userconfig are expanded where they are consumed.
            string? expandedValue = null;

            if (value is not null && !TryExpandEnvironmentReferences(value.Trim(), out expandedValue))
            {
                _logger.LogDebug("Ignoring the {Name} environment variable because it references an undefined environment variable.", name);
                continue;
            }

            AddIfAbsent(configuration, key, expandedValue, $"the {name} environment variable");
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
                _logger.LogDebug("Ignoring {Path} because it exceeds the {Limit} byte limit.", path, MaximumNpmrcSizeInBytes);
                return;
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
            if (!TryParseNpmrcKey(line, out var key, out var rawValue) ||
                !TryExpandEnvironmentReferences(key, out key) ||
                !IsInterestingKey(key))
            {
                continue;
            }

            if (!TryExpandEnvironmentReferences(ParseNpmrcValue(rawValue), out var value))
            {
                // Current npm leaves an unresolved ${VAR} in place, which cannot parse as a
                // registry address; dropping just this entry reaches the same outcome and keeps
                // the remaining layers usable.
                _logger.LogDebug("Ignoring npm '{Key}' in {Path} because it references an undefined environment variable.", key, path);
                continue;
            }

            SetIfPresent(fileConfiguration, key, value, path);
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

    private static bool TryParseNpmrcKey(ReadOnlySpan<char> line, out string key, out ReadOnlySpan<char> rawValue)
    {
        key = string.Empty;
        rawValue = default;

        var trimmed = line.Trim();

        // '[' opens an ini section header. npm's own config keys are never sectioned, so a section
        // header carries nothing this resolver needs.
        if (trimmed.IsEmpty || trimmed[0] is ';' or '#' or '[')
        {
            return false;
        }

        var separatorIndex = trimmed.IndexOf('=');

        if (separatorIndex <= 0)
        {
            return false;
        }

        var parsedKey = trimmed[..separatorIndex].Trim();

        if (parsedKey.IsEmpty)
        {
            return false;
        }

        key = parsedKey.ToString();
        rawValue = trimmed[(separatorIndex + 1)..].Trim();

        return true;
    }

    /// <summary>
    /// Parses the value half of a <c>.npmrc</c> line.
    /// </summary>
    /// <remarks>
    /// Unquoted values follow npm/ini comment rules: the first unescaped <c>;</c> or <c>#</c>
    /// starts an inline comment, while <c>\;</c>, <c>\#</c>, and <c>\\</c> unescape to literal
    /// characters. Quoted values are taken verbatim.
    /// </remarks>
    private static string ParseNpmrcValue(ReadOnlySpan<char> value)
    {
        if (value.Length >= 2 &&
            (value[0] is '"' && value[^1] is '"' || value[0] is '\'' && value[^1] is '\''))
        {
            return value[1..^1].ToString();
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
    private bool TryExpandEnvironmentReferences(string value, [NotNullWhen(true)] out string? expanded)
    {
        expanded = null;

        if (!value.Contains("${", StringComparison.Ordinal))
        {
            expanded = value;
            return true;
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
                    return false;
                }

                variableValue = string.Empty;
            }

            builder.Append(variableValue);
            index = end + 1;
        }

        expanded = builder.ToString();
        return true;
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

    private static void AddIfAbsent(
        Dictionary<string, ConfigurationValue> configuration,
        string key,
        string? value,
        string source)
    {
        if (TryCreateConfigurationValue(value, source, out var configurationValue))
        {
            // Layers are merged highest precedence first, so an existing entry always outranks this one.
            configuration.TryAdd(key, configurationValue);
        }
    }

    private static void SetIfPresent(
        Dictionary<string, ConfigurationValue> configuration,
        string key,
        string? value,
        string source)
    {
        if (TryCreateConfigurationValue(value, source, out var configurationValue))
        {
            configuration[key] = configurationValue;
        }
    }

    private static bool TryCreateConfigurationValue(
        string? value,
        string source,
        [NotNullWhen(true)] out ConfigurationValue? configurationValue)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            configurationValue = null;
            return false;
        }

        configurationValue = new ConfigurationValue(value.Trim(), source);
        return true;
    }

    /// <summary>
    /// Limits what is retained to the registry keys and the user-config redirect, so credential
    /// entries in a <c>.npmrc</c> or in the process environment are never retained.
    /// </summary>
    private static bool IsInterestingKey(string key)
    {
        return key is RegistryKey or UserConfigKey || key.EndsWith(ScopedRegistryKeySuffix, StringComparison.Ordinal);
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

    private sealed record ConfigurationValue(string Value, string Source);
}
