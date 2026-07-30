// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust;

/// <summary>
/// The binary a publish build produces, and where cargo writes it inside the build stage.
/// </summary>
/// <param name="BinaryName">The file name cargo writes, used verbatim for the entrypoint.</param>
/// <param name="ProfileDirectory">The profile directory under <c>target/</c>.</param>
/// <param name="TargetTriple">The <c>--target</c> triple, or <see langword="null"/> when building for the build image's host.</param>
internal sealed record RustPublishTarget(string BinaryName, string ProfileDirectory, string? TargetTriple)
{
    /// <summary>
    /// The path of the produced binary relative to the crate directory.
    /// </summary>
    /// <remarks>
    /// Cargo only inserts a triple directory when <c>--target</c> is passed. A host build writes to
    /// <c>target/&lt;profile&gt;/&lt;bin&gt;</c>, a cross build to
    /// <c>target/&lt;triple&gt;/&lt;profile&gt;/&lt;bin&gt;</c>.
    /// See https://doc.rust-lang.org/cargo/guide/build-cache.html
    /// </remarks>
    public string RelativeBinaryPath => TargetTriple is null
        ? $"target/{ProfileDirectory}/{BinaryName}"
        : $"target/{TargetTriple}/{ProfileDirectory}/{BinaryName}";
}

/// <summary>
/// Resolves which binary a publish build produces, using only manifest information from
/// <c>cargo metadata</c> and the resource's configured cargo options. Nothing here compiles.
/// </summary>
internal static class RustPublishTargetResolver
{
    public static RustPublishTarget Resolve(CargoMetadata metadata, RustCargoOptionsAnnotation options, string resourceName)
    {
        var package = ResolvePackage(metadata, options.Package, resourceName);
        var binaryName = ResolveBinaryName(package, options.BinTarget, resourceName);

        return new RustPublishTarget(binaryName, options.PublishProfileDirectory, options.TargetTriple);
    }

    private static CargoPackage ResolvePackage(CargoMetadata metadata, string? requestedPackage, string resourceName)
    {
        if (requestedPackage is not null)
        {
            return metadata.Packages.FirstOrDefault(p => p.Name == requestedPackage)
                ?? throw new DistributedApplicationException(
                    $"The Rust app '{resourceName}' selects the cargo package '{requestedPackage}', which does not exist in this workspace. " +
                    $"Available packages: {FormatNames(metadata.Packages.Select(p => p.Name))}.");
        }

        // Without --package, cargo builds the workspace's default members. Matching on id (rather than name)
        // keeps this correct for workspaces whose `default-members` is a subset of the members.
        var defaultPackages = metadata.Packages.Where(p => metadata.DefaultMemberIds.Contains(p.Id)).ToList();

        // A plain (non-workspace) crate still reports itself as the sole workspace member, so a single
        // default package covers both the workspace and the non-workspace case.
        return defaultPackages switch
        {
            [var single] => single,
            [] => throw new DistributedApplicationException(
                $"Unable to determine which cargo package to publish for the Rust app '{resourceName}' because 'cargo metadata' reported no default " +
                $"workspace member. Call WithCargoPackage(\"<name>\") to select one."),
            _ => throw new DistributedApplicationException(
                $"The Rust app '{resourceName}' points at a cargo workspace with {defaultPackages.Count} default members " +
                $"({FormatNames(defaultPackages.Select(p => p.Name))}), so the binary to publish is ambiguous. " +
                $"Call WithCargoPackage(\"<name>\") to select one.")
        };
    }

    private static string ResolveBinaryName(CargoPackage package, string? requestedBin, string resourceName)
    {
        if (requestedBin is not null)
        {
            return package.BinTargetNames.Contains(requestedBin)
                ? requestedBin
                : throw new DistributedApplicationException(
                    $"The Rust app '{resourceName}' selects the cargo binary '{requestedBin}', which the package '{package.Name}' does not declare. " +
                    $"Available binaries: {FormatNames(package.BinTargetNames)}.");
        }

        // `cargo run` honours default-run while `cargo build` ignores it. Publishing must produce the same
        // binary the resource runs locally, so default-run wins over the "single bin target" rule below.
        if (package.DefaultRun is { Length: > 0 } defaultRun)
        {
            return package.BinTargetNames.Contains(defaultRun)
                ? defaultRun
                : throw new DistributedApplicationException(
                    $"The package '{package.Name}' used by the Rust app '{resourceName}' sets default-run = \"{defaultRun}\", " +
                    $"but declares no such binary. Available binaries: {FormatNames(package.BinTargetNames)}.");
        }

        return package.BinTargetNames switch
        {
            [var single] => single,
            [] => throw new DistributedApplicationException(
                $"The package '{package.Name}' used by the Rust app '{resourceName}' declares no binary targets, so there is nothing to run in a " +
                $"container. Add a src/main.rs or a [[bin]] section to Cargo.toml."),
            var many => throw new DistributedApplicationException(
                $"The package '{package.Name}' used by the Rust app '{resourceName}' declares {many.Count} binary targets " +
                $"({FormatNames(many)}), so the binary to publish is ambiguous. Call WithCargoBinTarget(\"<name>\") to select one, " +
                $"or set default-run in Cargo.toml.")
        };
    }

    private static string FormatNames(IEnumerable<string> names)
    {
        var formatted = string.Join(", ", names.Select(static name => $"'{name}'"));
        return formatted.Length == 0 ? "(none)" : formatted;
    }
}
