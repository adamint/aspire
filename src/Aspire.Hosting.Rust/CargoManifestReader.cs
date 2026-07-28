// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust;

/// <summary>
/// The subset of <c>Cargo.toml</c> that Aspire needs in order to work out which binary a publish
/// build produces.
/// </summary>
/// <param name="PackageName">The <c>[package] name</c> value, or <see langword="null"/> for a virtual manifest.</param>
/// <param name="BinTargetNames">The names of explicitly declared <c>[[bin]]</c> targets, in declaration order.</param>
/// <param name="IsVirtualManifest">Whether the manifest declares a <c>[workspace]</c> but no <c>[package]</c>.</param>
internal sealed record CargoManifest(string? PackageName, IReadOnlyList<string> BinTargetNames, bool IsVirtualManifest);

/// <summary>
/// Minimal reader for the handful of <c>Cargo.toml</c> fields Aspire needs.
/// </summary>
/// <remarks>
/// This is deliberately not a general TOML parser. It performs a single line-oriented pass tracking the
/// current table header, which is enough for the well-known keys below and avoids taking a TOML
/// dependency in the hosting package. Anything it cannot understand yields <see langword="null"/>, and
/// callers surface an actionable error telling the user to configure the value explicitly.
/// </remarks>
internal static class CargoManifestReader
{
    /// <summary>
    /// Reads the <c>Cargo.toml</c> in <paramref name="appDirectory"/>, or returns <see langword="null"/>
    /// when there is no manifest there.
    /// </summary>
    /// <remarks>
    /// Handles manifests shaped like:
    /// <code>
    /// [package]
    /// name = "my-app"          # or literal strings: name = 'my-app'
    ///
    /// [[bin]]
    /// name = "server"
    /// path = "src/server.rs"
    ///
    /// [dependencies]
    /// name = "not-the-package" # must not be picked up
    /// </code>
    /// </remarks>
    public static CargoManifest? Read(string appDirectory)
    {
        var manifestPath = Path.Combine(appDirectory, "Cargo.toml");
        if (!File.Exists(manifestPath))
        {
            return null;
        }

        string? packageName = null;
        var binTargetNames = new List<string>();
        var sawPackage = false;
        var sawWorkspace = false;
        var section = Section.Other;

        foreach (var rawLine in File.ReadLines(manifestPath))
        {
            var line = StripComment(rawLine).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            // Array-of-tables header, e.g. [[bin]]. Each occurrence starts a new target entry.
            if (line.StartsWith("[[", StringComparison.Ordinal) && line.EndsWith("]]", StringComparison.Ordinal))
            {
                section = line[2..^2].Trim() == "bin" ? Section.Bin : Section.Other;
                continue;
            }

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                var header = line[1..^1].Trim();
                switch (header)
                {
                    case "package":
                        section = Section.Package;
                        sawPackage = true;
                        break;
                    case "workspace":
                        section = Section.Workspace;
                        sawWorkspace = true;
                        break;
                    default:
                        section = Section.Other;
                        break;
                }

                continue;
            }

            if (section is not (Section.Package or Section.Bin) || !TryReadNameValue(line, out var name))
            {
                continue;
            }

            if (section == Section.Package)
            {
                // Only the first [package] name wins; a malformed duplicate should not override it.
                packageName ??= name;
            }
            else
            {
                binTargetNames.Add(name);
            }
        }

        return new CargoManifest(packageName, binTargetNames, sawWorkspace && !sawPackage);
    }

    // Parses `name = "value"` or `name = 'value'`. Returns false for anything else, including
    // `name.workspace = true` (which cargo does not permit for package names anyway).
    private static bool TryReadNameValue(string line, out string value)
    {
        value = string.Empty;

        if (!line.StartsWith("name", StringComparison.Ordinal))
        {
            return false;
        }

        var rest = line[4..].TrimStart();
        if (rest.Length == 0 || rest[0] != '=')
        {
            return false;
        }

        rest = rest[1..].Trim();
        if (rest.Length < 2)
        {
            return false;
        }

        var quote = rest[0];
        if (quote is not ('"' or '\''))
        {
            return false;
        }

        var end = rest.IndexOf(quote, 1);
        if (end <= 0)
        {
            return false;
        }

        value = rest[1..end];
        return value.Length > 0;
    }

    // Removes a trailing TOML comment while respecting quoted strings, so that a value such as
    // name = "app#1" keeps its '#' but `# name = "nightly"` is discarded entirely.
    private static string StripComment(string line)
    {
        var inQuote = false;
        var quoteChar = '\0';

        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];

            if (inQuote)
            {
                if (c == quoteChar)
                {
                    inQuote = false;
                }
            }
            else if (c is '"' or '\'')
            {
                inQuote = true;
                quoteChar = c;
            }
            else if (c == '#')
            {
                return line[..i];
            }
        }

        return line;
    }

    private enum Section
    {
        Other,
        Package,
        Bin,
        Workspace
    }
}
