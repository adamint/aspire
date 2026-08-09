// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text;
using Aspire.Shared.CodeGeneration;

namespace TypeScriptApiCompat;

internal static class TypeScriptOptionsCollisionGuard
{
    public static void Validate(AtsSurfaceSet surfaceSet)
    {
        var dtoTypeIds = surfaceSet.Surfaces.Values
            .SelectMany(static surface => surface.DtoTypes.Keys)
            .ToHashSet(StringComparer.Ordinal);
        var candidates = new List<OptionsInterfaceCandidate>();

        foreach (var surface in surfaceSet.Surfaces.Values.OrderBy(static surface => surface.PackageName, StringComparer.Ordinal))
        {
            foreach (var capability in surface.Capabilities.Values.OrderBy(static capability => capability.CapabilityId, StringComparer.Ordinal))
            {
                var optionalParameters = capability.Parameters
                    .Where(static parameter => parameter.IsOptional)
                    .ToArray();

                if (optionalParameters.Length == 0 || IsDirectOptionsParameter(optionalParameters, dtoTypeIds))
                {
                    continue;
                }

                var interfaceName = GetUnqualifiedOptionsInterfaceName(capability.CapabilityId);
                if (!TypeScriptOptionsInterfaceNaming.RequiresPackageQualifier(interfaceName))
                {
                    candidates.Add(new OptionsInterfaceCandidate(interfaceName, surface.PackageName, capability.CapabilityId));
                }
            }
        }

        var collisions = candidates
            .GroupBy(static candidate => candidate.InterfaceName, StringComparer.Ordinal)
            .Select(static group => new OptionsInterfaceCollision(
                group.Key,
                group.ToArray(),
                group.Select(static candidate => candidate.PackageName).Distinct(StringComparer.Ordinal).ToArray()))
            .Where(static collision => collision.PackageNames.Count > 1)
            .OrderBy(static collision => collision.InterfaceName, StringComparer.Ordinal)
            .ToArray();

        if (collisions.Length > 0)
        {
            throw new InvalidOperationException(CreateCollisionMessage(collisions));
        }
    }

    private static bool IsDirectOptionsParameter(IReadOnlyList<AtsParameter> optionalParameters, IReadOnlySet<string> dtoTypeIds)
    {
        var candidates = optionalParameters
            .Where(static parameter => !IsCancellationToken(parameter))
            .ToArray();

        return candidates.Length == 1 &&
            string.Equals(candidates[0].Name, "options", StringComparison.Ordinal) &&
            !string.Equals(candidates[0].TypeId, "callback", StringComparison.Ordinal) &&
            dtoTypeIds.Contains(candidates[0].TypeId);
    }

    private static string GetUnqualifiedOptionsInterfaceName(string capabilityId)
    {
        var slashIndex = capabilityId.IndexOf('/');
        var methodName = slashIndex < 0 ? capabilityId : capabilityId[(slashIndex + 1)..];

        return TypeScriptOptionsInterfaceNaming.GetUnqualifiedOptionsInterfaceName(methodName);
    }

    private static string CreateCollisionMessage(IReadOnlyList<OptionsInterfaceCollision> collisions)
    {
        var builder = new StringBuilder();
        builder.AppendLine("Unqualified TypeScript options interface collision detected.");

        foreach (var collision in collisions)
        {
            builder.Append("- ");
            builder.Append(collision.InterfaceName);
            builder.Append(": ");

            var packageSummaries = collision.Candidates
                .GroupBy(static candidate => candidate.PackageName, StringComparer.Ordinal)
                .OrderBy(static group => group.Key, StringComparer.Ordinal)
                .Select(static group => $"'{group.Key}' ({string.Join(", ", group.Select(candidate => candidate.CapabilityId).Order(StringComparer.Ordinal))})")
                .ToArray();

            if (packageSummaries.Length == 2)
            {
                builder.Append(packageSummaries[0]);
                builder.Append(" and ");
                builder.Append(packageSummaries[1]);
                builder.Append(" both produce this unqualified options interface.");
            }
            else
            {
                builder.Append("these packages produce this unqualified options interface: ");
                builder.Append(string.Join("; ", packageSummaries));
                builder.Append('.');
            }

            builder.AppendLine();
        }

        builder.Append("Remedy: add the unqualified interface name to ");
        builder.Append(nameof(TypeScriptOptionsInterfaceNaming));
        builder.Append('.');
        builder.Append(nameof(TypeScriptOptionsInterfaceNaming.PackageQualifiedOptionsInterfaceNames));
        builder.Append(" so non-core packages use package-qualified options names, then update the TypeScript API compatibility baselines.");

        return builder.ToString();
    }

    private static bool IsCancellationToken(AtsParameter parameter)
        => string.Equals(parameter.TypeId, "cancellationToken", StringComparison.Ordinal);

    private sealed record OptionsInterfaceCandidate(string InterfaceName, string PackageName, string CapabilityId);

    private sealed record OptionsInterfaceCollision(
        string InterfaceName,
        IReadOnlyList<OptionsInterfaceCandidate> Candidates,
        IReadOnlyList<string> PackageNames);
}
