import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether two paths name the same AppHost.
 *
 * `ambiguous` is a first-class answer, not a failure. A C# AppHost can legitimately be
 * addressed either by its project file or by the single-file source next to it, but that
 * alias is only an identity when the directory holds exactly one of each. In every other
 * shape the association is a guess, and guessing here would let a lifecycle caller stop
 * or skip the wrong AppHost. Callers are expected to refuse rather than pick a side.
 */
export type AppHostIdentityRelation = 'same' | 'different' | 'ambiguous';

/**
 * Project files that can own an AppHost source file. Only C# projects are listed because
 * the source names below (`apphost.cs`, `Program.cs`) are C#: an `.fsproj` sitting in the
 * same directory cannot be their project, so counting it would make a genuinely
 * unambiguous pairing look ambiguous.
 */
const appHostProjectFileExtensions = ['.csproj'];

/**
 * Source file names that can be the entry point of the AppHost project in the same
 * directory. `apphost.cs` is the single-file AppHost convention; `Program.cs` is the
 * entry point of a project-based AppHost.
 */
const appHostSourceFileNames = ['apphost.cs', 'program.cs'];

/**
 * Suffix appended to the directory when a project file and its sibling source file are
 * proven to be the same AppHost. The NUL byte cannot appear in a real path, so the
 * synthesized key can never collide with the key of an actual file.
 */
const appHostAliasKeySuffix = '\u0000apphost';

/**
 * Case-folds on Windows only. macOS volumes are usually case-insensitive too, but the
 * extension consistently compares paths case-sensitively there, and diverging here would
 * make identity disagree with the rest of the extension.
 */
export function getAppHostPathComparisonKey(value: string): string {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Decides whether `left` and `right` name the same AppHost.
 *
 * Exact paths always match. Beyond that the only accepted alias is a project file and an
 * AppHost source file in the same directory, and only when the directory contains exactly
 * one candidate of each shape so the pairing is forced rather than chosen. A directory
 * holding two AppHost projects next to one `Program.cs` reports `ambiguous`, because the
 * source file genuinely belongs to only one of them and nothing on disk says which.
 */
export function compareAppHostIdentity(left: string | undefined, right: string | undefined): AppHostIdentityRelation {
    if (!left || !right) {
        return 'different';
    }

    const leftPath = path.normalize(path.resolve(left));
    const rightPath = path.normalize(path.resolve(right));
    if (getAppHostPathComparisonKey(leftPath) === getAppHostPathComparisonKey(rightPath)) {
        return 'same';
    }

    const directory = path.dirname(leftPath);
    if (getAppHostPathComparisonKey(directory) !== getAppHostPathComparisonKey(path.dirname(rightPath))) {
        return 'different';
    }

    // Two project files, or two source files, are never aliases of each other: only the
    // project/source pairing describes one AppHost addressed two ways.
    const projectFile = isAppHostProjectFile(leftPath)
        ? leftPath
        : isAppHostProjectFile(rightPath) ? rightPath : undefined;
    const sourceFile = isAppHostSourceFile(leftPath)
        ? leftPath
        : isAppHostSourceFile(rightPath) ? rightPath : undefined;
    if (!projectFile || !sourceFile) {
        return 'different';
    }

    const shapes = readDirectoryAppHostShapes(directory);
    if (!shapes.enumerated) {
        // Without a directory listing the pairing cannot be proven either way, and the
        // consequence of a wrong `different` is a duplicate launch or a wrong stop.
        return 'ambiguous';
    }

    // A path that is not actually on disk cannot be the counterpart of anything, so it is
    // provably a different AppHost rather than an unresolved association.
    if (!containsPath(shapes.projectFiles, projectFile) || !containsPath(shapes.sourceFiles, sourceFile)) {
        return 'different';
    }

    return shapes.projectFiles.length === 1 && shapes.sourceFiles.length === 1 ? 'same' : 'ambiguous';
}

/**
 * Maps every path that {@link compareAppHostIdentity} reports as `same` onto one key, so
 * the key can serialize lifecycle work per AppHost.
 *
 * The key is a pure function of the path and the directory listing, which keeps the
 * relation transitive: an alias only exists when the directory contains exactly one
 * project file and exactly one AppHost source file, so the equivalence classes are that
 * one pair plus singletons. Paths whose association is `ambiguous` deliberately get
 * their own keys — sharing one would serialize AppHosts that are not related, which is
 * the failure mode this replaced.
 */
export function getAppHostIdentityKey(appHostPath: string): string {
    const resolvedPath = path.normalize(path.resolve(appHostPath));
    if (!isAppHostProjectFile(resolvedPath) && !isAppHostSourceFile(resolvedPath)) {
        return getAppHostPathComparisonKey(resolvedPath);
    }

    const directory = path.dirname(resolvedPath);
    const shapes = readDirectoryAppHostShapes(directory);
    const isAliasedPair = shapes.enumerated &&
        shapes.projectFiles.length === 1 &&
        shapes.sourceFiles.length === 1 &&
        (containsPath(shapes.projectFiles, resolvedPath) || containsPath(shapes.sourceFiles, resolvedPath));

    return isAliasedPair
        ? `${getAppHostPathComparisonKey(directory)}${appHostAliasKeySuffix}`
        : getAppHostPathComparisonKey(resolvedPath);
}

export function isAppHostProjectFile(value: string): boolean {
    return appHostProjectFileExtensions.includes(path.extname(value).toLowerCase());
}

export function isAppHostSourceFile(value: string): boolean {
    return appHostSourceFileNames.includes(path.basename(value).toLowerCase());
}

interface DirectoryAppHostShapes {
    /** Absolute paths of the project files directly inside the directory. */
    readonly projectFiles: readonly string[];
    /** Absolute paths of the AppHost source files directly inside the directory. */
    readonly sourceFiles: readonly string[];
    /** False when the directory could not be listed, so neither list can be trusted. */
    readonly enumerated: boolean;
}

function readDirectoryAppHostShapes(directoryPath: string): DirectoryAppHostShapes {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    }
    catch {
        return { projectFiles: [], sourceFiles: [], enumerated: false };
    }

    const projectFiles: string[] = [];
    const sourceFiles: string[] = [];
    for (const entry of entries) {
        // Symlinks report `isFile() === false` even when they point at a file, and an
        // AppHost addressed through a symlinked project is still an AppHost.
        if (!entry.isFile() && !entry.isSymbolicLink()) {
            continue;
        }

        const entryPath = path.join(directoryPath, entry.name);
        if (isAppHostProjectFile(entry.name)) {
            projectFiles.push(entryPath);
        }
        else if (isAppHostSourceFile(entry.name)) {
            sourceFiles.push(entryPath);
        }
    }

    return { projectFiles, sourceFiles, enumerated: true };
}

function containsPath(paths: readonly string[], candidate: string): boolean {
    const candidateKey = getAppHostPathComparisonKey(candidate);
    return paths.some(value => getAppHostPathComparisonKey(value) === candidateKey);
}
