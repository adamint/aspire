// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust;

/// <summary>
/// The executable a cargo build produces, and where cargo writes it.
/// </summary>
/// <param name="Name">The file name cargo writes, without any platform executable extension.</param>
/// <param name="ProfileDirectory">The profile directory under <c>target/</c>.</param>
/// <param name="Target">The <c>--target</c> triple, or <see langword="null"/> when building for the host.</param>
/// <param name="IsExample">Whether the target is an example rather than a binary.</param>
internal sealed record RustCargoTarget(string Name, string ProfileDirectory, string? Target, bool IsExample)
{
    /// <summary>
    /// The path segments below the cargo target directory, in order.
    /// </summary>
    /// <remarks>
    /// Cargo only inserts a triple directory when <c>--target</c> is passed, and examples get their own
    /// <c>examples/</c> directory, so a host build of a binary lands in <c>&lt;target-dir&gt;/&lt;profile&gt;/</c>
    /// while a cross build of an example lands in <c>&lt;target-dir&gt;/&lt;triple&gt;/&lt;profile&gt;/examples/</c>.
    /// See https://doc.rust-lang.org/cargo/guide/build-cache.html
    /// </remarks>
    private IEnumerable<string> Segments
    {
        get
        {
            if (Target is not null)
            {
                yield return Target;
            }

            yield return ProfileDirectory;

            if (IsExample)
            {
                yield return "examples";
            }

            yield return Name;
        }
    }

    /// <summary>
    /// The path of the produced executable relative to the crate's <c>target</c> directory, using forward
    /// slashes so it can be written straight into a Dockerfile.
    /// </summary>
    public string RelativePath => string.Join('/', Segments);

    /// <summary>
    /// The absolute path of the produced executable, given the target directory cargo reported.
    /// </summary>
    /// <remarks>
    /// The executable extension is applied for the host platform because the app host, the debugger, and the
    /// build all run on the same machine. It is deliberately not applied to <see cref="RelativePath"/>, which
    /// describes output produced inside a Linux container.
    /// </remarks>
    public string GetExecutablePath(string targetDirectory)
    {
        var path = Path.Combine([targetDirectory, .. Segments]);

        return OperatingSystem.IsWindows() ? $"{path}.exe" : path;
    }
}

/// <summary>
/// Resolves which executable a cargo build produces, using only manifest information from
/// <c>cargo metadata</c> and the resource's configured cargo options. Nothing here compiles.
/// </summary>
/// <remarks>
/// <para>
/// This is the single answer to "which file does this resource's cargo command produce", shared by
/// publishing (which needs it to emit <c>COPY</c>/<c>ENTRYPOINT</c> without building on the host) and
/// debugging (which needs it to point the native debugger at a program). Resolving it once here keeps the
/// container image and the debugged process the same binary.
/// </para>
/// <para>
/// Anything cargo would itself have rejected at <c>cargo run</c> time is passed straight through rather
/// than re-validated. The only reported failures are the cases where run mode succeeds but the produced
/// file name is still unknowable.
/// </para>
/// </remarks>
internal static class RustCargoTargetResolver
{
    public static RustCargoTarget Resolve(CargoMetadata metadata, RustCargoOptionsAnnotation options, string profileDirectory, string resourceName)
    {
        if (options.Example is { } example)
        {
            return new RustCargoTarget(example, profileDirectory, options.Target, IsExample: true);
        }

        var name = options.BinTarget ?? ResolveBinaryName(metadata, options.Package, resourceName);

        return new RustCargoTarget(name, profileDirectory, options.Target, IsExample: false);
    }

    private static string ResolveBinaryName(CargoMetadata metadata, string? requestedPackage, string resourceName)
    {
        var package = ResolvePackage(metadata, requestedPackage, resourceName);

        // `cargo run` honours default-run while `cargo build` ignores it, so a crate relying on it builds
        // several binaries but runs exactly one. Resolving it here is what lets publishing and debugging
        // agree with `cargo run` instead of with `cargo build`.
        if (package.DefaultRun is { Length: > 0 } defaultRun)
        {
            return defaultRun;
        }

        return package.BinTargetNames switch
        {
            [var single] => single,
            // `cargo run` gets this far with several bins only when the binary was chosen by an argument
            // Aspire does not interpret, such as a raw --bin passed through WithCargoArgs.
            var many => throw new DistributedApplicationException(
                $"Unable to work out which binary the Rust app '{resourceName}' produces: the package '{package.Name}' declares " +
                $"{many.Count} binary targets. Call WithCargoBinTarget(\"<name>\") to select one.")
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
                $"Unable to work out which binary the Rust app '{resourceName}' produces: 'cargo metadata' reported " +
                $"{defaultPackages.Count} default workspace members. Call WithCargoPackage(\"<name>\") to select one.")
        };
    }
}
