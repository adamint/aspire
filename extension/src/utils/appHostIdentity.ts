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
const currentTargetIdentityRegistry = new Map<string, OpaqueAppHostIdentity>();
let nextOpaqueIdentity = 0;

interface CurrentTargetIdentityKeyInfo extends AppHostIdentityKeyInfo {
    readonly exactPathKey: string;
}

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
 * Returns an identity bound to the canonical filesystem target currently selected by the path.
 *
 * Callers that capture launch, failure, or confirmation ownership retain the returned
 * opaque value; a later resolution of the same lexical path receives a different value
 * when its canonical target changed. Replacing the same target file in place or through
 * an atomic rename preserves identity because the selected AppHost did not change.
 */
export function getOrCreateIdentityForCurrentAppHostTarget(appHostPath: string): OpaqueAppHostIdentity {
    for (let attempt = 0; attempt < 3; attempt++) {
        const keyInfo = getCurrentTargetIdentityKeyInfo(appHostPath);
        if (!sameCurrentTargetIdentityKeyInfo(keyInfo, getCurrentTargetIdentityKeyInfo(appHostPath))) {
            continue;
        }

        const exactIdentity = currentTargetIdentityRegistry.get(keyInfo.exactPathKey);
        if (exactIdentity) {
            assignUnmappedCurrentTargetAliases(keyInfo, exactIdentity);
            return exactIdentity;
        }

        const issuedIdentities = new Set<OpaqueAppHostIdentity>();
        const aliasIdentity = currentTargetIdentityRegistry.get(keyInfo.key);
        if (aliasIdentity) {
            issuedIdentities.add(aliasIdentity);
        }
        for (const pathKey of keyInfo.pathKeys) {
            const identity = currentTargetIdentityRegistry.get(pathKey);
            if (identity) {
                issuedIdentities.add(identity);
            }
        }

        const identity = issuedIdentities.size === 1
            ? [...issuedIdentities][0]
            : createOpaqueAppHostIdentity();
        currentTargetIdentityRegistry.set(keyInfo.exactPathKey, identity);
        if (issuedIdentities.size <= 1) {
            assignUnmappedCurrentTargetAliases(keyInfo, identity);
        }

        return identity;
    }

    // A target that changes during every bounded sample cannot be safely correlated.
    // Return an unregistered identity so the next resolution necessarily differs.
    return createOpaqueAppHostIdentity();
}

function createOpaqueAppHostIdentity(): OpaqueAppHostIdentity {
    return `apphost-${++nextOpaqueIdentity}` as OpaqueAppHostIdentity;
}

function getCurrentTargetIdentityKeyInfo(appHostPath: string): CurrentTargetIdentityKeyInfo {
    const keyInfo = getAppHostIdentityKeyInfo(appHostPath);
    return {
        ...keyInfo,
        exactPathKey: getAppHostPathComparisonKey(appHostPath),
    };
}

function sameCurrentTargetIdentityKeyInfo(left: CurrentTargetIdentityKeyInfo, right: CurrentTargetIdentityKeyInfo): boolean {
    return left.exactPathKey === right.exactPathKey &&
        left.key === right.key &&
        left.pathKeys.length === right.pathKeys.length &&
        left.pathKeys.every((pathKey, index) => pathKey === right.pathKeys[index]);
}

function assignUnmappedCurrentTargetAliases(keyInfo: CurrentTargetIdentityKeyInfo, identity: OpaqueAppHostIdentity): void {
    const keys = new Set([keyInfo.exactPathKey, keyInfo.key, ...keyInfo.pathKeys]);
    if ([...keys].some(key => {
        const existing = currentTargetIdentityRegistry.get(key);
        return existing !== undefined && existing !== identity;
    })) {
        return;
    }

    for (const key of keys) {
        if (!currentTargetIdentityRegistry.has(key)) {
            currentTargetIdentityRegistry.set(key, identity);
        }
    }
}

export function resetAppHostIdentityRegistry(): void {
    currentTargetIdentityRegistry.clear();
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
