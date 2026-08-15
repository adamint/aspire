import * as fs from 'fs';
import * as path from 'path';
import { isSameFileSystemEntry } from './paths/fileSystemIdentity';
import { isAppHostSourceFile } from './paths/comparison';

/** Whether two paths name the same AppHost. */
export type AppHostIdentityRelation = 'same' | 'different' | 'ambiguous';

declare const opaqueAppHostIdentityBrand: unique symbol;

/** Opaque, extension-window-scoped identity for one lexical AppHost target. */
export type OpaqueAppHostIdentity = string & { readonly [opaqueAppHostIdentityBrand]: true };

export interface AppHostIdentityKeyInfo {
    readonly key: string;
    readonly pathKeys: readonly string[];
}

const appHostProjectFileExtensions = ['.csproj', '.fsproj', '.vbproj'];
const appHostAliasKeySuffix = '\u0000apphost';
const opaqueIdentityRegistry = new Map<string, OpaqueAppHostIdentity>();
let nextOpaqueIdentity = 0;

export function getAppHostPathComparisonKey(value: string): string {
    return canonicalize(path.normalize(path.resolve(value)));
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
    if (isSameFileSystemEntry(leftPath, rightPath)) {
        return 'same';
    }

    const directory = path.dirname(leftPath);
    if (!isSameFileSystemEntry(directory, path.dirname(rightPath))) {
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

/**
 * Returns an AppHost identity that never follows filesystem aliases.
 *
 * Editor state uses the path recorded when a session launched. Following a symlink again
 * while producing a later snapshot would let retargeting that link move the active
 * session to a different AppHost. Project/source pairs still share one identity when the
 * lexical directory proves there is exactly one candidate of each shape.
 */
export function getLexicalAppHostIdentityKey(appHostPath: string): string {
    return getLexicalAppHostIdentityKeyInfo(appHostPath).key;
}

function getLexicalAppHostIdentityKeyInfo(appHostPath: string): AppHostIdentityKeyInfo {
    const resolvedPath = path.normalize(path.resolve(appHostPath));
    const resolvedKey = getLexicalPathComparisonKey(resolvedPath);
    if (!isAppHostProjectFile(resolvedPath) && !isAppHostSourceFile(resolvedPath)) {
        return { key: resolvedKey, pathKeys: [resolvedKey] };
    }

    const directory = path.dirname(resolvedPath);
    const shapes = readDirectoryAppHostShapes(directory);
    const isAliasedPair = shapes.enumerated &&
        shapes.projectFiles.length === 1 &&
        shapes.sourceFiles.length === 1 &&
        [...shapes.projectFiles, ...shapes.sourceFiles]
            .some(candidate => getLexicalPathComparisonKey(candidate) === resolvedKey);

    if (!isAliasedPair) {
        return { key: resolvedKey, pathKeys: [resolvedKey] };
    }

    return {
        key: `${getLexicalPathComparisonKey(directory)}${appHostAliasKeySuffix}`,
        pathKeys: [
            getLexicalPathComparisonKey(shapes.projectFiles[0]),
            getLexicalPathComparisonKey(shapes.sourceFiles[0]),
        ],
    };
}

/**
 * Returns the shared window-scoped identity for an absolute AppHost path.
 *
 * The registry owns the path-to-identity relationship so privacy-sensitive consumers can
 * retain only the opaque value. Lexical keys intentionally keep a launched symlink bound
 * to the target the user selected even if the link is retargeted later.
 */
export function getOrCreateIdentityForAbsolutePath(appHostPath: string): OpaqueAppHostIdentity {
    const keyInfo = getLexicalAppHostIdentityKeyInfo(appHostPath);
    const exactPathKey = getLexicalPathComparisonKey(appHostPath);
    const exactIdentity = opaqueIdentityRegistry.get(exactPathKey);
    if (exactIdentity) {
        assignUnmappedAliases(keyInfo, exactIdentity);
        return exactIdentity;
    }

    const issuedIdentities = new Set<OpaqueAppHostIdentity>();
    const aliasIdentity = opaqueIdentityRegistry.get(keyInfo.key);
    if (aliasIdentity) {
        issuedIdentities.add(aliasIdentity);
    }
    for (const pathKey of keyInfo.pathKeys) {
        const pathIdentity = opaqueIdentityRegistry.get(pathKey);
        if (pathIdentity) {
            issuedIdentities.add(pathIdentity);
        }
    }

    const identity = issuedIdentities.size === 1
        ? [...issuedIdentities][0]
        : `apphost-${++nextOpaqueIdentity}` as OpaqueAppHostIdentity;
    opaqueIdentityRegistry.set(exactPathKey, identity);

    // Project/source uniqueness is filesystem-dependent and can change after an identity
    // is issued. Share newly discovered aliases only when every existing mapping agrees;
    // overwriting a different issued identity would orphan records already stored under it.
    if (issuedIdentities.size <= 1) {
        assignUnmappedAliases(keyInfo, identity);
    }

    return identity;
}

function assignUnmappedAliases(keyInfo: AppHostIdentityKeyInfo, identity: OpaqueAppHostIdentity): void {
    const keys = new Set([keyInfo.key, ...keyInfo.pathKeys]);
    if ([...keys].some(key => {
        const existing = opaqueIdentityRegistry.get(key);
        return existing !== undefined && existing !== identity;
    })) {
        return;
    }

    for (const key of keys) {
        if (!opaqueIdentityRegistry.has(key)) {
            opaqueIdentityRegistry.set(key, identity);
        }
    }
}

export function resetAppHostIdentityRegistry(): void {
    opaqueIdentityRegistry.clear();
    nextOpaqueIdentity = 0;
}

export function __resetAppHostIdentityRegistryForTests(): void {
    resetAppHostIdentityRegistry();
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
    return paths.some(value => isSameFileSystemEntry(value, candidate));
}

function getLexicalPathComparisonKey(value: string): string {
    const resolvedPath = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

export function canonicalizeAppHostPath(resolvedPath: string): string {
    return canonicalize(resolvedPath);
}

export function isAppHostPathWithinDirectory(appHostPath: string, directoryPath: string): boolean {
    const directory = canonicalize(path.normalize(path.resolve(directoryPath)));
    let current = canonicalize(path.normalize(path.resolve(appHostPath)));
    while (true) {
        if (isSameFileSystemEntry(current, directory)) {
            return true;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return false;
        }

        current = parent;
    }
}

function canonicalize(resolvedPath: string): string {
    try {
        // Native realpath returns the filesystem's canonical casing on Windows. That keeps
        // differently-cased references to one file on one key without collapsing distinct
        // files in a case-sensitive Windows directory.
        return fs.realpathSync.native(resolvedPath);
    }
    catch {
        return resolvedPath;
    }
}
