import * as vscode from 'vscode';

import { type AppHostEditorSessionSnapshot } from '../services/AppHostLaunchService';
import { type AppHostEditorStateLaunchService } from './appHostLifecycleToolContracts';
import { type AppHostTargetIdentity, type ResolvedAppHostTarget, SafeAppHostTargetResolver } from './safeAppHostTargetResolver';

const maxSummaries = 20;

export type EditorAppHostState = 'running' | 'starting' | 'stopping' | 'notDebugging' | 'multipleSessions';
export type EditorAppHostMode = 'run' | 'debug' | 'other';

export interface EditorAppHostSummary {
    readonly appHost: string;
    readonly state: EditorAppHostState;
    readonly mode: EditorAppHostMode;
    readonly controller: 'editor';
}

export interface EditorStateSnapshot {
    readonly appHosts: readonly EditorAppHostSummary[];
}

export interface ActiveEditorStateSnapshot {
    readonly appHosts: readonly EditorAppHostSummary[];
    readonly truncated?: true;
}

export interface EditorStateSnapshotServiceDependencies {
    readonly launchService: AppHostEditorStateLaunchService;
    readonly targetResolver: SafeAppHostTargetResolver;
}

/**
 * Produces a bounded, model-safe summary of the AppHosts this editor window knows about.
 *
 * The snapshot intentionally stops at AppHost-level state. Resource details, debug
 * session ids, launch configurations, and process identifiers are all omitted so the
 * `list_debug_sessions` surface can answer "what is the editor doing?" without
 * handing the model ambient handles into unrelated APIs.
 */
export class EditorStateSnapshotService {
    private readonly _dependencies: EditorStateSnapshotServiceDependencies;

    constructor(dependencies: EditorStateSnapshotServiceDependencies) {
        this._dependencies = dependencies;
    }

    async createSnapshot(token: vscode.CancellationToken): Promise<EditorStateSnapshot> {
        const { representativeTargets, sessionsByIdentity } = await this.collectSnapshotState(token, maxSummaries);

        return {
            appHosts: representativeTargets.map(target =>
                this.createSummary(target, sessionsByIdentity.get(target.identity) ?? [])),
        };
    }

    async createActiveSessionSnapshot(token: vscode.CancellationToken): Promise<ActiveEditorStateSnapshot> {
        const { representativeTargets, sessionsByIdentity } = await this.collectSnapshotState(token);
        const activeSummaries = representativeTargets
            .map(target => this.createSummary(target, sessionsByIdentity.get(target.identity) ?? []))
            .filter(summary => summary.state !== 'notDebugging');
        const appHosts = activeSummaries.slice(0, maxSummaries);

        return activeSummaries.length > maxSummaries
            ? { appHosts, truncated: true }
            : { appHosts };
    }

    private async collectSnapshotState(
        token: vscode.CancellationToken,
        limit?: number): Promise<{
            readonly representativeTargets: readonly ResolvedAppHostTarget[];
            readonly sessionsByIdentity: ReadonlyMap<AppHostTargetIdentity, AppHostEditorSessionSnapshot[]>;
        }> {
        throwIfCanceled(token);
        const representativeTargets = selectRepresentativeTargets(
            await this._dependencies.targetResolver.enumerateKnownAppHosts(token),
            limit);
        throwIfCanceled(token);
        const knownIdentities = new Set(representativeTargets.map(target => target.identity));
        const sessionsByIdentity = new Map<AppHostTargetIdentity, AppHostEditorSessionSnapshot[]>();

        for (const session of this._dependencies.launchService.getEditorSessions()) {
            if (session.operationKind !== 'run') {
                continue;
            }

            const appHostPath = session.resolvedAppHostPath ?? session.appHostPath;
            if (!appHostPath) {
                continue;
            }

            const identity = this._dependencies.targetResolver.getIdentityForAppHostPath(appHostPath);
            if (!knownIdentities.has(identity)) {
                continue;
            }

            const grouped = sessionsByIdentity.get(identity);
            if (grouped) {
                grouped.push(session);
            }
            else {
                sessionsByIdentity.set(identity, [session]);
            }
        }
        throwIfCanceled(token);

        return {
            representativeTargets,
            sessionsByIdentity,
        };
    }

    /**
     * Summarizes one already-resolved AppHost without applying the bounded list cap.
     *
     * The status tool resolves its exact target first, so looking it up through
     * {@link createSnapshot} would make AppHosts beyond the first 20 appear to be
     * unknown. Direct summarization keeps the list bound specific to the future list
     * tool while preserving the same safe session projection and path identity rules.
     */
    async getAppHostSummary(target: ResolvedAppHostTarget, token: vscode.CancellationToken): Promise<EditorAppHostSummary> {
        throwIfCanceled(token);
        const sessions = this._dependencies.launchService.getEditorSessions().filter(session => {
            if (session.operationKind !== 'run') {
                return false;
            }

            const appHostPath = session.resolvedAppHostPath ?? session.appHostPath;
            return appHostPath !== undefined &&
                this._dependencies.targetResolver.getIdentityForAppHostPath(appHostPath) === target.identity;
        });
        throwIfCanceled(token);

        return this.createSummary(target, sessions);
    }

    private createSummary(target: ResolvedAppHostTarget, sessions: readonly AppHostEditorSessionSnapshot[]): EditorAppHostSummary {
        if (sessions.length > 1) {
            // Once more than one editor session could claim the AppHost there is no honest
            // single-session summary to return. Report that multiplicity instead of
            // inventing a run/debug answer from whichever session we happened to inspect
            // first.
            return createSummary(target.displayPath, 'multipleSessions', 'other');
        }

        const resolvedSession = sessions[0];
        if (resolvedSession) {
            return describeTrackedSession(target.displayPath, resolvedSession);
        }

        return createSummary(
            target.displayPath,
            this._dependencies.launchService.hasPendingOrActiveRunLaunch(target.absolutePath) ? 'starting' : 'notDebugging',
            'other');
    }
}

function describeTrackedSession(displayPath: string, session: AppHostEditorSessionSnapshot): EditorAppHostSummary {
    if (session.isStopping) {
        return createSummary(displayPath, 'stopping', getSessionMode(session));
    }

    return createSummary(
        displayPath,
        session.startupCompleted ? 'running' : 'starting',
        getSessionMode(session));
}

function getSessionMode(session: AppHostEditorSessionSnapshot): EditorAppHostMode {
    return getNoDebugMode(session.noDebug);
}

function getNoDebugMode(noDebug: unknown): EditorAppHostMode {
    return noDebug === true
        ? 'run'
        : noDebug === false
            ? 'debug'
            : 'other';
}

function createSummary(appHost: string, state: EditorAppHostState, mode: EditorAppHostMode): EditorAppHostSummary {
    return {
        appHost,
        state,
        mode,
        controller: 'editor',
    };
}

function selectRepresentativeTargets(
    targets: readonly ResolvedAppHostTarget[],
    limit?: number): readonly ResolvedAppHostTarget[] {
    const sorted = [...targets].sort((left, right) => compareDisplayPath(left.displayPath, right.displayPath));
    const representatives: ResolvedAppHostTarget[] = [];
    const seen = new Set<AppHostTargetIdentity>();
    for (const target of sorted) {
        if (seen.has(target.identity)) {
            continue;
        }

        seen.add(target.identity);
        representatives.push(target);
        if (representatives.length === limit) {
            break;
        }
    }

    return representatives;
}

function compareDisplayPath(left: string, right: string): number {
    if (left < right) {
        return -1;
    }

    if (left > right) {
        return 1;
    }

    return 0;
}

function throwIfCanceled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}
