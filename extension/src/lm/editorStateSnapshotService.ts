import * as vscode from 'vscode';

import { type AppHostEditorSessionSnapshot } from '../services/AppHostLaunchService';
import { type AppHostEditorStateLaunchService, type AppHostLifecycleEditorSession } from './appHostLifecycleToolContracts';
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

export interface EditorStateSnapshotServiceDependencies {
    readonly launchService: AppHostEditorStateLaunchService;
    readonly targetResolver: SafeAppHostTargetResolver;
}

/**
 * Produces a bounded, model-safe summary of the AppHosts this editor window knows about.
 *
 * The snapshot intentionally stops at AppHost-level state. Resource details, debug
 * session ids, launch configurations, and process identifiers are all omitted so the
 * future `list_debug_sessions` surface can answer "what is the editor doing?" without
 * handing the model ambient handles into unrelated APIs.
 */
export class EditorStateSnapshotService {
    private readonly _dependencies: EditorStateSnapshotServiceDependencies;

    constructor(dependencies: EditorStateSnapshotServiceDependencies) {
        this._dependencies = dependencies;
    }

    async createSnapshot(token: vscode.CancellationToken): Promise<EditorStateSnapshot> {
        const representativeTargets = selectRepresentativeTargets(
            await this._dependencies.targetResolver.enumerateKnownAppHosts(token));
        const knownIdentities = new Set(representativeTargets.map(target => target.identity));
        const sessionsByIdentity = new Map<AppHostTargetIdentity, AppHostEditorSessionSnapshot[]>();

        for (const session of this._dependencies.launchService.getEditorSessions()) {
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

        return {
            appHosts: representativeTargets.map(target =>
                this.createSummary(target, sessionsByIdentity.get(target.identity) ?? [])),
        };
    }

    private createSummary(target: ResolvedAppHostTarget, sessions: readonly AppHostEditorSessionSnapshot[]): EditorAppHostSummary {
        const runSessions = this._dependencies.launchService.getEditorRunSessions(target.absolutePath);
        const hasResolvedRunSession = sessions.some(session => session.operationKind === 'run');
        const inferredRunSessions = runSessions.sessions.length === 1 && !hasResolvedRunSession ? 1 : 0;
        if (runSessions.ambiguous || runSessions.sessions.length > 1 || sessions.length + inferredRunSessions > 1) {
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

        const runSession = runSessions.sessions[0];
        if (runSession) {
            return describeRunSession(target.displayPath, runSession);
        }

        return createSummary(
            target.displayPath,
            this._dependencies.launchService.isLaunching(target.absolutePath) ? 'starting' : 'notDebugging',
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

function describeRunSession(displayPath: string, session: AppHostLifecycleEditorSession): EditorAppHostSummary {
    return createSummary(
        displayPath,
        session.startupCompleted ? 'running' : 'starting',
        session.configuration.noDebug === true ? 'run' : 'debug');
}

function getSessionMode(session: AppHostEditorSessionSnapshot): EditorAppHostMode {
    if (session.operationKind !== 'run') {
        return 'other';
    }

    return session.noDebug ? 'run' : 'debug';
}

function createSummary(appHost: string, state: EditorAppHostState, mode: EditorAppHostMode): EditorAppHostSummary {
    return {
        appHost,
        state,
        mode,
        controller: 'editor',
    };
}

function selectRepresentativeTargets(targets: readonly ResolvedAppHostTarget[]): readonly ResolvedAppHostTarget[] {
    const sorted = [...targets].sort((left, right) => compareDisplayPath(left.displayPath, right.displayPath));
    const representatives: ResolvedAppHostTarget[] = [];
    const seen = new Set<AppHostTargetIdentity>();
    for (const target of sorted) {
        if (seen.has(target.identity)) {
            continue;
        }

        seen.add(target.identity);
        representatives.push(target);
        if (representatives.length === maxSummaries) {
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
