// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.TypeSystem;

/// <summary>
/// Describes the package identity and ownership scope of an <see cref="IApiReferenceExporter"/> export.
/// </summary>
/// <remarks>
/// The ATS context handed to an exporter is already filtered to the exporting assemblies, their
/// reference closure, and the reduced member shapes needed to resolve wrappers for referenced handle
/// types. That closure is exactly why <see cref="ExportingAssemblyNames"/> exists: it lets the exporter
/// tell apart symbols the package owns and should document from symbols it merely needs to emit so the
/// output is self-contained. Without it, every package would republish its dependencies' API reference.
/// </remarks>
public sealed class ApiReferenceExportOptions
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ApiReferenceExportOptions"/> class.
    /// </summary>
    /// <param name="packageName">The name of the package being exported.</param>
    /// <param name="packageVersion">The version label to record for the package being exported.</param>
    /// <param name="exportingAssemblyNames">
    /// The assemblies whose symbols this package owns and documents. Symbols outside this set are
    /// present only to complete the reference closure.
    /// </param>
    /// <param name="manifestContext">
    /// The unfiltered context the export was narrowed from, used to reproduce names that generation
    /// assigns across the whole manifest rather than per package.
    /// </param>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="packageName"/>, <paramref name="packageVersion"/>,
    /// <paramref name="exportingAssemblyNames"/>, or <paramref name="manifestContext"/> is
    /// <see langword="null"/>.
    /// </exception>
    /// <exception cref="ArgumentException">
    /// Thrown when <paramref name="packageName"/> or <paramref name="packageVersion"/> is empty or
    /// consists only of white-space characters.
    /// </exception>
    public ApiReferenceExportOptions(
        string packageName,
        string packageVersion,
        IReadOnlyCollection<string> exportingAssemblyNames,
        AtsContext manifestContext)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageName);
        ArgumentException.ThrowIfNullOrWhiteSpace(packageVersion);
        ArgumentNullException.ThrowIfNull(exportingAssemblyNames);
        ArgumentNullException.ThrowIfNull(manifestContext);

        PackageName = packageName;
        PackageVersion = packageVersion;
        ExportingAssemblyNames = exportingAssemblyNames;
        ManifestContext = manifestContext;
    }

    /// <summary>
    /// Gets the name of the package being exported.
    /// </summary>
    public string PackageName { get; }

    /// <summary>
    /// Gets the version label recorded for this export, as supplied by the caller.
    /// </summary>
    /// <remarks>
    /// Consumers key published documentation on this value, so callers are expected to pass the
    /// exact version that was restored. Nothing on this type can confirm that: an exporter sees
    /// loaded assemblies, not the package resolution that produced them, so any value — including a
    /// floating or range expression — would be recorded verbatim. Exactness therefore belongs where
    /// the restore is decided. <c>aspire sdk export</c> rejects a floating or range version before
    /// the scanner is built, pins the requested version so an unavailable one fails the restore
    /// instead of resolving upward, and refuses a package a repository checkout would build in place
    /// of the requested one.
    /// </remarks>
    public string PackageVersion { get; }

    /// <summary>
    /// Gets the assemblies whose symbols this package owns and documents.
    /// </summary>
    public IReadOnlyCollection<string> ExportingAssemblyNames { get; }

    /// <summary>
    /// Gets the unfiltered context this export was narrowed from.
    /// </summary>
    /// <remarks>
    /// Most generated names derive from the symbol they describe, so a package filtered out of the
    /// context cannot change them. Options interfaces are the exception: they are named after the
    /// method that produced them, and two packages can expose the same method name with parameters
    /// that cannot share one interface. Generation resolves that by suffixing the loser, which it
    /// can only decide while looking at every package at once. An export projected from a filtered
    /// context sees no collision, so both packages would publish the same interface name with
    /// different members. TypeScript merges identical interface declarations, so agreeing fragments
    /// are harmless, but disagreeing ones fail to type-check the moment aspire.dev concatenates
    /// them — and neither would have matched the SDK. Keeping the manifest lets the exporter settle
    /// those names exactly as generation does before narrowing to what the package documents.
    /// </remarks>
    public AtsContext ManifestContext { get; }
}
