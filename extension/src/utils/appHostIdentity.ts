import * as fs from 'fs';
import * as path from 'path';

/** Whether two paths name the same AppHost. */
export type AppHostIdentityRelation = 'same' | 'different' | 'ambiguous';

export interface AppHostIdentityKeyInfo {
    readonly key: string;
    readonly pathKeys: readonly string[];
}

const appHostProjectFileExtensions = ['.csproj'];
const appHostSourceFileNames = ['apphost.cs', 'program.cs'];
const appHostAliasKeySuffix = '\u0000apphost';

export function getAppHostPathComparisonKey(value: string): string {
    const resolved = canonicalize(path.normalize(path.resolve(value)));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Exact paths match. A project and sibling AppHost source match only when the directory
 * contains exactly one candidate of each shape; otherwise their relationship is ambiguous.
 */
export function compareAppHostIdentity(left: string | undefined, right: string | undefined): AppHostIdentityRelation {
    if (!left || !right) {
        return 'different';
    }

    const leftPath = canonicalize(path.normalize(path.resolve(left)));
    const rightPath = canonicalize(path.normalize(path.resolve(right)));
    if (getAppHostPathComparisonKey(leftPath) === getAppHostPathComparisonKey(rightPath)) {
        return 'same';
    }

    const directory = path.dirname(leftPath);
    if (getAppHostPathComparisonKey(directory) !== getAppHostPathComparisonKey(path.dirname(rightPath))) {
        return 'different';
    }

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
        return 'ambiguous';
    }

    if (!containsPath(shapes.projectFiles, projectFile) || !containsPath(shapes.sourceFiles, sourceFile)) {
        return 'different';
    }

    return shapes.projectFiles.length === 1 && shapes.sourceFiles.length === 1 ? 'same' : 'ambiguous';
}

export function getAppHostIdentityKey(appHostPath: string): string {
    return getAppHostIdentityKeyInfo(appHostPath).key;
}

export function getAppHostIdentityKeyInfo(appHostPath: string): AppHostIdentityKeyInfo {
    const resolvedPath = canonicalize(path.normalize(path.resolve(appHostPath)));
    if (!isAppHostProjectFile(resolvedPath) && !isAppHostSourceFile(resolvedPath)) {
        const key = getAppHostPathComparisonKey(resolvedPath);
        return { key, pathKeys: [key] };
    }

    const directory = path.dirname(resolvedPath);
    const shapes = readDirectoryAppHostShapes(directory);
    const isAliasedPair = shapes.enumerated &&
        shapes.projectFiles.length === 1 &&
        shapes.sourceFiles.length === 1 &&
        (containsPath(shapes.projectFiles, resolvedPath) || containsPath(shapes.sourceFiles, resolvedPath));

    if (isAliasedPair) {
        return {
            key: `${getAppHostPathComparisonKey(directory)}${appHostAliasKeySuffix}`,
            pathKeys: [
                getAppHostPathComparisonKey(shapes.projectFiles[0]),
                getAppHostPathComparisonKey(shapes.sourceFiles[0]),
            ],
        };
    }

    const key = getAppHostPathComparisonKey(resolvedPath);
    return { key, pathKeys: [key] };
}

export function isAppHostProjectFile(value: string): boolean {
    return appHostProjectFileExtensions.includes(path.extname(value).toLowerCase());
}

export function isAppHostSourceFile(value: string): boolean {
    return appHostSourceFileNames.includes(path.basename(value).toLowerCase());
}

interface DirectoryAppHostShapes {
    readonly projectFiles: readonly string[];
    readonly sourceFiles: readonly string[];
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

export function canonicalizeAppHostPath(resolvedPath: string): string {
    return canonicalize(resolvedPath);
}

function canonicalize(resolvedPath: string): string {
    try {
        return process.platform === 'darwin'
            ? fs.realpathSync.native(resolvedPath)
            : fs.realpathSync(resolvedPath);
    }
    catch {
        return resolvedPath;
    }
}
