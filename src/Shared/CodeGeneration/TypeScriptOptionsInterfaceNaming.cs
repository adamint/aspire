// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Shared.CodeGeneration;

internal static class TypeScriptOptionsInterfaceNaming
{
    private const string AspireHostingAssembly = "Aspire.Hosting";
    private const string AspireHostingAssemblyPrefix = "Aspire.Hosting.";

    // These are the duplicate unqualified names in the checked-in shipped ATS surface. First-party
    // packages keep unique names unqualified for compatibility; when the TypeScript API
    // compatibility guard finds a new duplicate, add that name here so non-core Aspire packages
    // move to package-qualified names together. Third-party packages are always qualified because
    // the repository guard cannot see their collisions before users concatenate package exports.
    internal static IReadOnlySet<string> PackageQualifiedOptionsInterfaceNames { get; } =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "AddCertManagerOptions",
            "AddDatabaseOptions",
            "AddHubOptions",
            "RunAsContainerOptions",
            "RunAsEmulatorOptions",
            "WithAccessKeyAuthenticationOptions",
            "WithDashboardOptions",
            "WithDataBindMountOptions",
            "WithDataVolumeOptions",
            "WithForwardedHeadersOptions",
            "WithHttpsUpgradeOptions",
            "WithOtlpExporterOptions",
            "WithPersistenceOptions",
            "WithPostgresMcpOptions"
        };

    internal static bool RequiresPackageQualifier(string unqualifiedInterfaceName)
        => PackageQualifiedOptionsInterfaceNames.Contains(unqualifiedInterfaceName);

    internal static bool RequiresPackageQualifier(string unqualifiedInterfaceName, string owningAssemblyName)
    {
        if (string.IsNullOrEmpty(owningAssemblyName) ||
            string.Equals(owningAssemblyName, AspireHostingAssembly, StringComparison.Ordinal))
        {
            return false;
        }

        if (!owningAssemblyName.StartsWith(AspireHostingAssemblyPrefix, StringComparison.Ordinal))
        {
            return true;
        }

        return RequiresPackageQualifier(unqualifiedInterfaceName);
    }

    internal static string GetUnqualifiedOptionsInterfaceName(string methodName)
    {
        var simpleName = methodName.Contains('.')
            ? methodName[(methodName.LastIndexOf('.') + 1)..]
            : methodName;

        return $"{ToPascalCase(simpleName)}Options";
    }

    private static string ToPascalCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        if (char.IsUpper(name[0]))
        {
            return name;
        }

        return char.ToUpperInvariant(name[0]) + name[1..];
    }
}
