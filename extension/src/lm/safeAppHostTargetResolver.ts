import * as path from 'path';
import * as vscode from 'vscode';

import { extensionLogOutputChannel } from '../utils/logging';
import {
    compareAppHostIdentity,
    getOrCreateIdentityForAbsolutePath,
    isAppHostPathWithinDirectory,
    type AppHostIdentityRelation,
    type OpaqueAppHostIdentity,
} from '../utils/appHostIdentity';
import { isCommandCancellation } from '../utils/telemetry';
import { type AppHostLifecycleDiscoveryService } from './appHostLifecycleToolContracts';

/**
 * Upper bound on the workspace-relative path a confirmation may show.
 *
 * A path longer than this is refused outright rather than elided, because an elided path
 * no longer identifies one file: two AppHosts sharing a long prefix would produce the
 * same prompt. The bound is far above any realistic repository path (Windows' own
 * MAX_PATH is 260 for a full path), so refusing beyond it costs nothing in practice.
 */
const maxConfirmationPathLength = 512;

/** Reject model-supplied selectors large enough to make normalization itself expensive. */
const maxAppHostSelectorLength = 4096;

/** Cap on how many AppHost paths a failed resolution lists back to the model. */
const maxReportedKnownAppHosts = 32;

/**
 * Characters that change what a path *is* without changing, or while changing, how it
 * looks: C0/C1 controls and DEL, plus every Unicode format character (`\p{Cf}`).
 *
 * Bidi controls (U+202A-U+202E, U+2066-U+2069) reorder the run that follows them, so a
 * path can render as a completely different one. Zero-width characters (U+200B-U+200D)
 * are invisible, so two distinct files can produce identical-looking prompts. A registry
 * entry carrying one of these is dropped rather than shown with the characters deleted,
 * because deleting them would break the one-to-one relationship between the identity the
 * user confirms and the file that runs.
 * See https://unicode.org/reports/tr9/ and https://unicode.org/reports/tr36/#Bidirectional_Text_Spoofing
 */
const identityChangingCharacters = /[\u0000-\u001F\u007F-\u009F]|\p{Cf}/u;

export type AppHostTargetIdentity = OpaqueAppHostIdentity;

/**
 * One entry of the AppHost registry, projected into the form the editor-assistance
 * surfaces speak.
 *
 * Every field comes from a candidate the discovery service enumerated, so the string the
 * confirmation renders and the path the launcher receives originate from the same object.
 * The model's input only ever selects one of these; it never contributes to one.
 */
export interface ResolvedAppHostTarget {
    /** Absolute path exactly as the registry enumerated it, used for editor-owned actions. */
    readonly absolutePath: string;
    /** Path relative to the containing workspace folder, always with `/` separators. */
    readonly relativePath: string;
    /**
     * The identity shown in confirmations and editor-assistance summaries. Identical to
     * `relativePath` in a single-root workspace, and prefixed with the workspace folder
     * name otherwise.
     */
    readonly displayPath: string;
    /**
     * Opaque identity scoped to this extension window. It is stable for the same logical
     * AppHost but never exposes the absolute path in model-facing contracts.
     */
    readonly identity: AppHostTargetIdentity;
}

export type SafeAppHostTargetResolverOutcome =
    | 'invalidInput'
    | 'appHostNotFound'
    | 'ambiguousAppHost'
    | 'canceled'
    | 'error';

export type SafeAppHostTargetResolution =
    | { resolved: true; target: ResolvedAppHostTarget }
    | { resolved: false; outcome: SafeAppHostTargetResolverOutcome; knownAppHosts?: readonly string[] };

/**
 * Resolves model-supplied AppHost selectors strictly against the editor-maintained
 * registry of known AppHosts.
 *
 * The resolver never joins model input onto a directory, never asks the filesystem to
 * "find the closest match", and never lets absolute paths cross from tool input into the
 * launch pipeline. Whatever resolves is one of Aspire's own enumerated candidates.
 */
export class SafeAppHostTargetResolver {
    constructor(
        private readonly _discoveryService: AppHostLifecycleDiscoveryService,
        private readonly _toSelectorKey: (value: string) => string = toSelectorKey) {
    }

    /**
     * Returns the window-scoped opaque identity for an AppHost path.
     *
     * Session snapshots use the lexical path recorded at launch so a later symlink
     * retarget cannot move an active session to another list item.
     */
    getIdentityForAppHostPath(appHostPath: string): AppHostTargetIdentity {
        return getOrCreateIdentityForAbsolutePath(appHostPath);
    }

    /**
     * Compares a fresh CLI-reported AppHost path to a resolved registry target using the
     * same filesystem and project/source equivalence rules as editor lifecycle ownership.
     */
    compareTargetToAppHostPath(
        target: ResolvedAppHostTarget,
        appHostPath: string | undefined): AppHostIdentityRelation {
        return compareAppHostIdentity(target.absolutePath, appHostPath);
    }

    /**
     * Resolves a model-supplied selector against the AppHost registry.
     *
     * The selector is only ever *compared* against entries the discovery service
     * enumerated; it is never joined onto a directory, never normalized into a path, and
     * never reaches the filesystem. That is what makes confirmation spoofing
     * unrepresentable rather than merely rejected: whatever the model sends, the target
     * carried forward is one of Aspire's own candidates, so the identity shown in the
     * prompt and the identity handed to the launcher come from the same object.
     */
    async resolveTarget(rawAppHost: unknown, token: vscode.CancellationToken): Promise<SafeAppHostTargetResolution> {
        if (typeof rawAppHost !== 'string') {
            return { resolved: false, outcome: 'invalidInput' };
        }

        const selector = rawAppHost.trim();
        if (selector.length === 0 || selector.length > maxAppHostSelectorLength) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        // The contract says the selector is workspace-relative. Accepting an absolute
        // path that happens to name a registry entry would make the implementation
        // contradict its own documented surface, so it is refused up front.
        if (path.isAbsolute(selector)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        let knownAppHosts: readonly ResolvedAppHostTarget[];
        try {
            knownAppHosts = await this.enumerateKnownAppHosts(token);
        }
        catch (error) {
            if (isCommandCancellation(error)) {
                return { resolved: false, outcome: 'canceled' };
            }

            // "The registry could not be read" is not "there are no AppHosts". Reporting
            // the latter would tell the caller its target does not exist when the truth is
            // that the extension could not find out.
            extensionLogOutputChannel.warn('Aspire editor assistance could not enumerate AppHosts.');
            return { resolved: false, outcome: 'error' };
        }

        const requestedKey = this._toSelectorKey(selector);
        const displayMatches = knownAppHosts.filter(candidate => this._toSelectorKey(candidate.displayPath) === requestedKey);
        if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
            // A bare relative selector is not stable in a multi-root workspace: a later
            // invocation could re-resolve the same text under a different root. Require
            // the folder-qualified identity the confirmation displays so each call is
            // independently bound to one root.
            if (displayMatches.length === 1) {
                return { resolved: true, target: displayMatches[0] };
            }

            if (displayMatches.length > 1) {
                return { resolved: false, outcome: 'ambiguousAppHost', knownAppHosts: describeKnownAppHosts(displayMatches) };
            }

            const relativeMatches = knownAppHosts.filter(candidate => this._toSelectorKey(candidate.relativePath) === requestedKey);
            if (relativeMatches.length > 0) {
                return { resolved: false, outcome: 'ambiguousAppHost', knownAppHosts: describeKnownAppHosts(relativeMatches) };
            }

            return { resolved: false, outcome: 'appHostNotFound', knownAppHosts: describeKnownAppHosts(knownAppHosts) };
        }

        const matches = knownAppHosts.filter(candidate =>
            this._toSelectorKey(candidate.relativePath) === requestedKey ||
            this._toSelectorKey(candidate.displayPath) === requestedKey);
        if (matches.length === 0) {
            return { resolved: false, outcome: 'appHostNotFound', knownAppHosts: describeKnownAppHosts(knownAppHosts) };
        }

        if (matches.length > 1) {
            return { resolved: false, outcome: 'ambiguousAppHost', knownAppHosts: describeKnownAppHosts(matches) };
        }

        return { resolved: true, target: matches[0] };
    }

    /**
     * Projects the discovery service's candidates into safe tool targets.
     *
     * Candidates outside every workspace folder are dropped: the editor-assistance
     * contracts are expressed in workspace-relative paths, and a candidate with no
     * containing folder has no such path to offer or display.
     */
    async enumerateKnownAppHosts(token: vscode.CancellationToken): Promise<readonly ResolvedAppHostTarget[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const folderQualifiers = createWorkspaceFolderQualifiers(workspaceFolders, this._toSelectorKey);
        const candidatesByFolder = await Promise.all(workspaceFolders.map(async (folder, index) => ({
            folder,
            folderQualifier: folderQualifiers[index],
            candidates: await this._discoveryService.discover(folder, false, token),
        })));

        const targets = new Map<string, ResolvedAppHostTarget>();
        for (const { folder, folderQualifier, candidates } of candidatesByFolder) {
            for (const candidate of candidates) {
                const relativePath = toContainedPosixRelativePath(folder.uri.fsPath, candidate.path);
                if (relativePath === undefined) {
                    continue;
                }

                // The lexical path is what the caller sees in the explorer and passes back
                // to the tool, but containment has to be checked on the real target too so
                // an in-workspace symlink cannot smuggle an external file across the trust
                // boundary under an in-workspace name.
                if (!isAppHostPathWithinDirectory(candidate.path, folder.uri.fsPath)) {
                    continue;
                }

                const displayPath = workspaceFolders.length > 1
                    ? `${folderQualifier}/${relativePath}`
                    : relativePath;
                // Nested workspace folders enumerate the same lexical candidate twice.
                // Collapse only that duplicate; distinct symlink aliases must remain
                // independently selectable even when they currently reach one real file.
                const key = this._toSelectorKey(candidate.path);
                const existing = targets.get(key);
                if (existing && existing.relativePath.length <= relativePath.length) {
                    continue;
                }

                targets.set(key, {
                    absolutePath: candidate.path,
                    relativePath,
                    displayPath,
                    identity: this.getIdentityForAppHostPath(candidate.path),
                });
            }
        }

        // A real file or folder name can itself carry invisible or bidi characters, and
        // the confirmation must never show an identity it cannot render faithfully.
        return [...targets.values()].filter(target =>
            !identityChangingCharacters.test(target.displayPath) &&
            target.displayPath.length <= maxConfirmationPathLength);
    }

}

function createWorkspaceFolderQualifiers(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    toComparisonKey: (value: string) => string): readonly string[] {
    const nameCounts = new Map<string, number>();
    for (const folder of workspaceFolders) {
        nameCounts.set(folder.name, (nameCounts.get(folder.name) ?? 0) + 1);
    }

    const nameOrdinals = new Map<string, number>();
    const qualifiers = workspaceFolders.map(folder => {
        if (nameCounts.get(folder.name) === 1) {
            return folder.name;
        }

        const ordinal = (nameOrdinals.get(folder.name) ?? 0) + 1;
        nameOrdinals.set(folder.name, ordinal);
        return `${folder.name} (${ordinal})`;
    });
    if (new Set(qualifiers.map(toComparisonKey)).size === qualifiers.length) {
        return qualifiers;
    }

    // A literal folder name can equal a qualifier generated for another folder. Adding
    // the workspace position to every name keeps the fallback deterministic and unique
    // without incorporating an absolute path or another machine-specific value.
    return workspaceFolders.map((folder, index) => `${folder.name} (${index + 1})`);
}

/**
 * Normalizes a selector or registry path into the key both sides are compared on.
 *
 * The comparison is deliberately narrow: a leading `./` is dropped because it is noise,
 * and Windows separators and casing are normalized to match that filesystem. On POSIX a
 * backslash is a valid filename character, so treating it as a separator would alias two
 * different registry entries. Nothing else is normalized. `..` segments, for instance,
 * are left alone precisely so they can never match anything the registry enumerated.
 */
function toSelectorKey(value: string): string {
    if (process.platform === 'win32') {
        return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    }

    return value.replace(/^\.\//, '');
}

function describeKnownAppHosts(targets: readonly ResolvedAppHostTarget[]): readonly string[] {
    return targets.slice(0, maxReportedKnownAppHosts).map(target => target.displayPath);
}

function toContainedPosixRelativePath(folderPath: string, candidate: string): string | undefined {
    const relative = path.relative(folderPath, candidate);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        return undefined;
    }

    return relative.split(path.sep).join('/');
}
