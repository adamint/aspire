// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using Aspire.TypeSystem;

namespace Aspire.Hosting.CodeGeneration.TypeScript;

/// <summary>
/// Reads <see cref="AtsContext"/> members that were added after the shared contract's frozen
/// strong-name version, in a way that degrades instead of failing when the loaded contract predates
/// them.
/// </summary>
/// <remarks>
/// <para>
/// <c>Aspire.TypeSystem</c> is force-shared from the apphost server's default
/// <see cref="System.Runtime.Loader.AssemblyLoadContext"/> and freezes its <c>AssemblyVersion</c> at
/// <c>13.4.5.0</c> (see <c>src/Aspire.TypeSystem/Aspire.TypeSystem.csproj</c> and
/// <c>src/Aspire.Hosting.RemoteHost/IntegrationLoadContext.cs</c>), so an already-shipped CLI binds
/// a newer SDK's code generation assembly against its own older copy of the contract. Binding
/// succeeds; the newer members simply are not there.
/// </para>
/// <para>
/// Splitting export onto <see cref="AtsTypeScriptApiReferenceExporter"/> only protects <em>type</em>
/// loading — a type whose interface list or signatures name a missing type is dropped, and the code
/// generator survives. It does nothing for a <em>method body</em> that names a missing member: the
/// JIT resolves a method's tokens when that method first runs, so a direct read of a newer property
/// from the generator path throws <see cref="MissingMethodException"/> at generation time and takes
/// ordinary TypeScript generation down with it. Probing once and keeping every direct read behind
/// that probe, in a method the JIT is not allowed to inline into its caller, is what keeps the
/// generator path free of that hard bind.
/// </para>
/// </remarks>
internal static class AtsContextCompatibility
{
    // nameof is a compile-time constant, so the probe itself carries no reference to the member and
    // is safe to evaluate against a contract that predates it.
    private static readonly bool s_exposesCapabilityExportingAssemblyNames =
        typeof(AtsContext).GetProperty(nameof(AtsContext.CapabilityExportingAssemblyNames)) is not null;

    /// <summary>
    /// Gets the assembly that exported <paramref name="capabilityId"/>, when the loaded contract
    /// records exporting assemblies at all.
    /// </summary>
    /// <param name="context">The ATS context to read.</param>
    /// <param name="capabilityId">The capability whose exporting assembly is wanted.</param>
    /// <param name="exportingAssemblyName">The exporting assembly name, when one was recorded.</param>
    /// <returns>
    /// <see langword="true"/> when the loaded contract exposes the mapping and it names
    /// <paramref name="capabilityId"/>; otherwise <see langword="false"/>, which callers are
    /// expected to answer with their own ownership fallback.
    /// </returns>
    public static bool TryGetCapabilityExportingAssemblyName(
        AtsContext context,
        string capabilityId,
        [NotNullWhen(true)] out string? exportingAssemblyName)
    {
        if (s_exposesCapabilityExportingAssemblyNames)
        {
            return ReadCapabilityExportingAssemblyName(context, capabilityId, out exportingAssemblyName);
        }

        exportingAssemblyName = null;
        return false;
    }

    // NoInlining is load-bearing, not a hint: inlining this body into its caller would move the
    // member reference back onto a method the generator path always runs, which is exactly the hard
    // bind the probe exists to avoid.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool ReadCapabilityExportingAssemblyName(
        AtsContext context,
        string capabilityId,
        [NotNullWhen(true)] out string? exportingAssemblyName)
        => context.CapabilityExportingAssemblyNames.TryGetValue(capabilityId, out exportingAssemblyName);
}
