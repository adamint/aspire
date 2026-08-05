// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.TypeSystem;

/// <summary>
/// Describes the package identity and ownership scope of an <see cref="IApiReferenceExporter"/> export.
/// </summary>
/// <remarks>
/// The ATS context handed to an exporter is already filtered to the exporting assemblies plus their
/// reference closure, because the generated code does not type-check without the referenced
/// declarations. That closure is exactly why <see cref="ExportingAssemblyNames"/> exists: it lets the
/// exporter tell apart symbols the package owns and should document from symbols it merely needs to
/// emit so the output is self-contained. Without it, every package would republish its dependencies'
/// API reference.
/// </remarks>
public sealed class ApiReferenceExportOptions
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ApiReferenceExportOptions"/> class.
    /// </summary>
    /// <param name="packageName">The name of the package being exported.</param>
    /// <param name="packageVersion">The exact version of the package being exported.</param>
    /// <param name="exportingAssemblyNames">
    /// The assemblies whose symbols this package owns and documents. Symbols outside this set are
    /// present only to complete the reference closure.
    /// </param>
    public ApiReferenceExportOptions(
        string packageName,
        string packageVersion,
        IReadOnlyCollection<string> exportingAssemblyNames)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageName);
        ArgumentException.ThrowIfNullOrWhiteSpace(packageVersion);
        ArgumentNullException.ThrowIfNull(exportingAssemblyNames);

        PackageName = packageName;
        PackageVersion = packageVersion;
        ExportingAssemblyNames = exportingAssemblyNames;
    }

    /// <summary>
    /// Gets the name of the package being exported.
    /// </summary>
    public string PackageName { get; }

    /// <summary>
    /// Gets the exact version of the package being exported. Consumers key published documentation on
    /// this value, so it must be a resolved version and never a floating range.
    /// </summary>
    public string PackageVersion { get; }

    /// <summary>
    /// Gets the assemblies whose symbols this package owns and documents.
    /// </summary>
    public IReadOnlyCollection<string> ExportingAssemblyNames { get; }
}
