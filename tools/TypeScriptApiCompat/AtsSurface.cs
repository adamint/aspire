// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace TypeScriptApiCompat;

internal sealed record AtsSurface(
    string PackageName,
    IReadOnlyDictionary<string, AtsHandleType> HandleTypes,
    IReadOnlyDictionary<string, AtsDtoType> DtoTypes,
    IReadOnlyDictionary<string, AtsEnumType> EnumTypes,
    IReadOnlyDictionary<string, AtsExportedValue> ExportedValues,
    IReadOnlyDictionary<string, AtsCapability> Capabilities);

internal sealed record AtsHandleType(string TypeId, IReadOnlySet<string> Flags);

internal sealed record AtsDtoType(string TypeId, IReadOnlyDictionary<string, AtsDtoProperty> Properties);

internal sealed record AtsDtoProperty(string Name, string TypeId, bool IsOptional);

internal sealed record AtsEnumType(string TypeId, IReadOnlyList<string> Values);

internal sealed record AtsExportedValue(string Path, string TypeId, string Value);

/// <param name="CapabilityId">The exported capability id, for example <c>Pkg/withRedisCommanderHostPort</c>.</param>
/// <param name="Parameters">The exported parameters, in declaration order.</param>
/// <param name="ReturnTypeId">The exported return type id.</param>
/// <param name="ProjectedMethodName">
/// The TypeScript method name the projector emits, which <c>[AspireExport(..., MethodName = "...")]</c>
/// can make differ from the capability id. This is what the options interface is named after, so the
/// collision guard has to use it rather than the id.
/// </param>
internal sealed record AtsCapability(
    string CapabilityId,
    IReadOnlyList<AtsParameter> Parameters,
    string ReturnTypeId,
    string ProjectedMethodName);

internal sealed record AtsParameter(string Name, string TypeId, bool IsOptional, bool IsNullable);

internal sealed class AtsSurfaceSet
{
    private AtsSurfaceSet(IReadOnlyDictionary<string, AtsSurface> surfaces)
    {
        Surfaces = surfaces;
    }

    public IReadOnlyDictionary<string, AtsSurface> Surfaces { get; }

    public static AtsSurfaceSet Load(string rootPath)
    {
        if (!Directory.Exists(rootPath))
        {
            throw new DirectoryNotFoundException($"Surface directory '{rootPath}' does not exist.");
        }

        var surfaces = new Dictionary<string, AtsSurface>(StringComparer.Ordinal);

        var files = Directory.EnumerateFiles(rootPath, "*.ats.txt", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .ToList();
        var packageNames = files.Select(GetPackageName).ToArray();

        foreach (var file in files)
        {
            var packageName = GetPackageName(file);
            if (surfaces.ContainsKey(packageName))
            {
                throw new InvalidOperationException($"Duplicate ATS surface for package '{packageName}' under '{rootPath}'.");
            }

            surfaces.Add(packageName, AtsSurfaceParser.Parse(packageName, File.ReadAllText(file), packageNames));
        }

        return new AtsSurfaceSet(surfaces);
    }

    private static string GetPackageName(string filePath)
    {
        var fileName = Path.GetFileName(filePath);
        const string suffix = ".ats.txt";

        if (!fileName.EndsWith(suffix, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"ATS surface file '{filePath}' does not end with '{suffix}'.");
        }

        return fileName[..^suffix.Length];
    }
}
