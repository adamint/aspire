// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust;

/// <summary>
/// The binary a publish build produces, and where cargo writes it inside the build stage.
/// </summary>
/// <param name="BinaryName">The file name cargo writes, used verbatim for the entrypoint.</param>
/// <param name="ProfileDirectory">The profile directory under <c>target/</c>.</param>
/// <param name="Target">The <c>--target</c> triple, or <see langword="null"/> when building for the build image's host.</param>
internal sealed record RustPublishTarget(string BinaryName, string ProfileDirectory, string? Target)
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
    public string RelativeBinaryPath => Target is null
        ? $"target/{ProfileDirectory}/{BinaryName}"
        : $"target/{Target}/{ProfileDirectory}/{BinaryName}";
}

/// <summary>
/// Resolves which binary a publish build produces, using only manifest information from
/// <c>cargo metadata</c> and the resource's configured cargo options. Nothing here compiles.
/// </summary>
/// <remarks>
/// Publishing assumes the app already runs, so anything cargo would itself have rejected at
/// <c>cargo run</c> time is passed straight through rather than re-validated here. The only reported
/// failures are the cases where run mode succeeds but the produced file name is still unknowable.
/// </remarks>
internal static class RustPublishTargetResolver
{
    public static RustPublishTarget Resolve(CargoMetadata metadata, RustCargoOptionsAnnotation options, string resourceName)
    {
        var binaryName = options.BinTarget ?? ResolveBinaryName(metadata, options.Package, resourceName);

        return new RustPublishTarget(binaryName, options.PublishProfileDirectory, options.Target);
    }

    private static string ResolveBinaryName(CargoMetadata metadata, string? requestedPackage, string resourceName)
    {
        var package = ResolvePackage(metadata, requestedPackage, resourceName);

        // `cargo run` honours default-run while `cargo build` ignores it. Publishing must produce the same
        // binary the resource runs locally, so default-run wins over the "single bin target" rule below.
        if (package.DefaultRun is { Length: > 0 } defaultRun)
        {
            return defaultRun;
        }

        return package.BinTargetNames switch
        {
            [var single] => single,
            // `cargo run` gets this far with several bins only when the binary was chosen by an argument
            // publish does not interpret, such as a raw --bin passed through WithCargoArgs.
            var many => throw new DistributedApplicationException(
                $"Unable to work out which binary the Rust app '{resourceName}' publishes: the package '{package.Name}' declares " +
                $"{many.Count} binary targets. Call WithCargoBinTarget(\"<name>\") so the generated Dockerfile copies the right one.")
        };
    }

    private static CargoPackage ResolvePackage(CargoMetadata metadata, string? requestedPackage, string resourceName)
    {
        if (requestedPackage is not null)
        {
            return metadata.Packages.First(p => p.Name == requestedPackage);
        }

        // Without --package, cargo builds the workspace's default members. Matching on id (rather than name)
        // keeps this correct for workspaces whose `default-members` is a subset of the members. A plain
        // (non-workspace) crate reports itself as the sole member, so this covers both shapes.
        var defaultPackages = metadata.Packages.Where(p => metadata.DefaultMemberIds.Contains(p.Id)).ToList();

        return defaultPackages switch
        {
            [var single] => single,
            _ => throw new DistributedApplicationException(
                $"Unable to work out which binary the Rust app '{resourceName}' publishes: 'cargo metadata' reported " +
                $"{defaultPackages.Count} default workspace members. Call WithCargoPackage(\"<name>\") to select one.")
        };
    }
}
