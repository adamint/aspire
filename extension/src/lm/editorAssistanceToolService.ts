import * as vscode from 'vscode';

import { AspireCliParseError, type ResourceJson } from '../data/appHostCliContracts';
import { appHostLifecycleUnresolvedPath } from '../loc/strings';
import { type EditorResourceSessionSnapshot } from '../services/appHostLaunchContracts';
import { extensionLogOutputChannel } from '../utils/logging';
import { isSamePath } from '../utils/paths/comparison';
import { isCommandCancellation } from '../utils/telemetry';
import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    aspireListDebugSessionsToolName,
    aspireOpenDashboardToolName,
    aspireOpenOutputToolName,
    isValidEmptyObjectInput,
    isValidDebugSessionStatusInput,
    isValidExplainLaunchFailureInput,
    isValidOpenDashboardInput,
    type DebugSessionStatusFailureResult,
    type DebugSessionStatusResourceFailureResult,
    type DebugSessionStatusResult,
    type DebugSessionStatusToolResult,
    type EditorAssistanceMode,
    type EditorAssistanceRecommendedAction,
    type EditorAssistanceToolDependencies,
    type ExplainLaunchFailureFailureResult,
    type ExplainLaunchFailureFoundResult,
    type ExplainLaunchFailureToolResult,
    type ListDebugSessionsToolResult,
    type OpenDashboardFailureResult,
    type OpenDashboardToolResult,
    type OpenOutputFailureResult,
    type OpenOutputToolResult,
} from './editorAssistanceToolContracts';
import { type EditorAppHostSummary } from './editorStateSnapshotService';
import { type ResolvedAppHostTarget, type SafeAppHostTargetResolution } from './safeAppHostTargetResolver';

type ResolvedPreflight<T> =
    | { readonly resolved: true; readonly target: ResolvedAppHostTarget; readonly input: T }
    | { readonly resolved: false; readonly outcome: 'appHostNotFound' | 'ambiguousAppHost' | 'workspaceNotTrusted' | 'invalidInput' | 'canceled' | 'error' };

/**
 * Provides model-safe editor assistance for AppHost state, diagnostics, and
 * confirmation-gated editor UI handoffs.
 *
 * The service resolves every selector through {@link SafeAppHostTargetResolver}.
 * Resource data and editor session snapshots are used only for exact internal
 * correlation; results are rebuilt from finite fields so paths, debug
 * configurations, resource properties, process identifiers, and raw errors
 * cannot cross into the model transcript.
 */
export class EditorAssistanceToolService {
    constructor(private readonly _dependencies: EditorAssistanceToolDependencies) {
    }

    async describeDashboardTarget(rawAppHost: unknown, token: vscode.CancellationToken): Promise<string> {
        if (!vscode.workspace.isTrusted) {
            return appHostLifecycleUnresolvedPath;
        }

        const resolution = await this._dependencies.targetResolver.resolveTarget(rawAppHost, token);
        return resolution.resolved
            ? resolution.target.displayPath
            : appHostLifecycleUnresolvedPath;
    }

    async openDashboard(input: unknown, token: vscode.CancellationToken): Promise<OpenDashboardToolResult> {
        const preflight = await this.preflight(
            input,
            token,
            isValidOpenDashboardInput,
            aspireOpenDashboardToolName);
        if (!preflight.resolved) {
            return createOpenDashboardFailure(preflight.outcome);
        }

        try {
            const result = await this._dependencies.uiHandoffService.openDashboard(preflight.target, token);
            if (result.outcome === 'opened') {
                return {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: result.presentation,
                };
            }

            return createOpenDashboardFailure(result.outcome);
        }
        catch (error) {
            if (isCommandCancellation(error) || token.isCancellationRequested) {
                return createOpenDashboardFailure('canceled');
            }

            // The handoff layer deliberately withholds its URL and raw browser error.
            extensionLogOutputChannel.error(`Aspire language model tool ${aspireOpenDashboardToolName} failed.`);
            return createOpenDashboardFailure('error');
        }
    }

    async openOutput(input: unknown, token: vscode.CancellationToken): Promise<OpenOutputToolResult> {
        const rejected = validateEmptyObjectInvocation(input, token);
        if (rejected) {
            return createOpenOutputFailure(rejected);
        }

        try {
            const outcome = await this._dependencies.uiHandoffService.openOutput(token);
            return outcome === 'opened'
                ? {
                    success: true,
                    tool: aspireOpenOutputToolName,
                    outcome: 'opened',
                }
                : createOpenOutputFailure('error');
        }
        catch (error) {
            return createOpenOutputFailure(
                isCommandCancellation(error) || token.isCancellationRequested
                    ? 'canceled'
                    : 'error');
        }
    }

    async listDebugSessions(input: unknown, token: vscode.CancellationToken): Promise<ListDebugSessionsToolResult> {
        const rejected = validateEmptyObjectInvocation(input, token);
        if (rejected) {
            return createListDebugSessionsFailure(rejected);
        }

        try {
            const snapshot = await this._dependencies.snapshotService.createActiveSessionSnapshot(token);
            throwIfCanceled(token);
            return {
                success: true,
                tool: aspireListDebugSessionsToolName,
                outcome: snapshot.appHosts.length > 0 ? 'sessionsFound' : 'noSessions',
                sessions: snapshot.appHosts,
                ...(snapshot.truncated ? { truncated: true } : {}),
            };
        }
        catch (error) {
            if (!isCommandCancellation(error) && !token.isCancellationRequested) {
                extensionLogOutputChannel.error(`Aspire language model tool ${aspireListDebugSessionsToolName} failed.`);
            }

            return createListDebugSessionsFailure(
                isCommandCancellation(error) || token.isCancellationRequested
                    ? 'canceled'
                    : 'error');
        }
    }

    async getDebugSessionStatus(input: unknown, token: vscode.CancellationToken): Promise<DebugSessionStatusToolResult> {
        const preflight = await this.preflight(
            input,
            token,
            isValidDebugSessionStatusInput,
            aspireDebugSessionStatusToolName);
        if (!preflight.resolved) {
            return createStatusFailure(preflight.outcome);
        }

        try {
            if (preflight.input.resourceName === undefined) {
                const summary = await this._dependencies.snapshotService.getAppHostSummary(preflight.target, token);
                return createAppHostStatusResult(summary);
            }

            const resourceName = preflight.input.resourceName;
            const appHostSummary = await this._dependencies.snapshotService.getAppHostSummary(preflight.target, token);
            let resources: readonly ResourceJson[];
            try {
                resources = await this._dependencies.resourceRepository.fetchAppHostResourcesOnce(
                    preflight.target.absolutePath,
                    token);
            }
            catch (error) {
                throwIfCanceled(token);
                if (appHostSummary.state === 'notDebugging' && isMissingStoppedAppHostSnapshot(error)) {
                    return createResourceStatusResult(
                        'notDebugging',
                        preflight.target.displayPath,
                        resourceName);
                }

                throw error;
            }
            throwIfCanceled(token);

            const matches = resources.filter(resource => resource.name === resourceName);
            if (matches.length === 0) {
                return createResourceFailure(
                    'resourceNotFound',
                    preflight.target.displayPath,
                    resourceName);
            }
            if (matches.length > 1) {
                return createResourceFailure(
                    'resourceAmbiguous',
                    preflight.target.displayPath,
                    resourceName);
            }

            const resource = matches[0];
            const resourceTarget = getResourceTarget(resource);
            if (resourceTarget === undefined) {
                return createResourceStatusResult(
                    'notDebugging',
                    preflight.target.displayPath,
                    resource.name);
            }

            // A Python module/executable launch can carry both the interpreter and
            // console-script paths because the current typed launch shape does not
            // distinguish those entrypoint kinds. Resolve every safe candidate against
            // the exact AppHost resource set, then fail closed if one session could
            // claim more than one resource.
            const matchingSessions = this._dependencies.getEditorResourceSessions()
                .filter(session =>
                    this._dependencies.targetResolver.getIdentityForAppHostPath(session.appHostPath) === preflight.target.identity)
                .map(session => ({
                    session,
                    matchingResources: resources.filter(candidate => {
                        const candidateTarget = getResourceTarget(candidate);
                        return candidateTarget !== undefined &&
                            isSessionTargetMatch(session, candidateTarget);
                    }),
                }))
                .filter(match => match.matchingResources.includes(resource));
            if (matchingSessions.length === 0) {
                return createResourceStatusResult(
                    'notDebugging',
                    preflight.target.displayPath,
                    resource.name);
            }

            if (matchingSessions.some(match => match.matchingResources.length > 1)) {
                return createResourceFailure(
                    'resourceAmbiguous',
                    preflight.target.displayPath,
                    resource.name);
            }
            if (matchingSessions.length > 1) {
                return createResourceStatusResult(
                    'multipleSessions',
                    preflight.target.displayPath,
                    resource.name);
            }

            const session = matchingSessions[0].session;
            return createResourceStatusResult(
                session.state,
                preflight.target.displayPath,
                resource.name,
                session.mode);
        }
        catch (error) {
            return this.createStatusError(error);
        }
    }

    async explainLaunchFailure(input: unknown, token: vscode.CancellationToken): Promise<ExplainLaunchFailureToolResult> {
        const preflight = await this.preflight(
            input,
            token,
            isValidExplainLaunchFailureInput,
            aspireExplainLaunchFailureToolName);
        if (!preflight.resolved) {
            return createExplainFailure(preflight.outcome);
        }

        try {
            const [failure] = this._dependencies.readLatestLaunchFailures(preflight.target.absolutePath);
            throwIfCanceled(token);
            if (!failure) {
                return {
                    success: true,
                    tool: aspireExplainLaunchFailureToolName,
                    outcome: 'noRecordedFailure',
                    appHost: preflight.target.displayPath,
                };
            }

            const result: ExplainLaunchFailureFoundResult = {
                success: true,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'failureFound',
                appHost: preflight.target.displayPath,
                stage: failure.stage,
                category: failure.category,
                controller: failure.controller,
                mode: failure.mode,
                providerKind: failure.providerKind,
                exitCodeBucket: failure.exitCodeBucket,
                recommendedActions: getRecommendedActions(failure.category),
            };
            return result;
        }
        catch (error) {
            return this.createExplainError(error);
        }
    }

    private async preflight<T>(
        input: unknown,
        token: vscode.CancellationToken,
        validate: (value: unknown) => value is T,
        tool: string): Promise<ResolvedPreflight<T>> {
        if (token.isCancellationRequested) {
            return { resolved: false, outcome: 'canceled' };
        }

        if (!vscode.workspace.isTrusted) {
            return { resolved: false, outcome: 'workspaceNotTrusted' };
        }

        if (!validate(input)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        let resolution: SafeAppHostTargetResolution;
        try {
            resolution = await this._dependencies.targetResolver.resolveTarget(
                (input as { readonly appHostPath: string }).appHostPath,
                token);
        }
        catch (error) {
            if (isCommandCancellation(error)) {
                return { resolved: false, outcome: 'canceled' };
            }

            extensionLogOutputChannel.error(`Aspire language model tool ${tool} failed while resolving an AppHost: ${String(error)}`);
            return { resolved: false, outcome: 'error' };
        }

        if (resolution.resolved) {
            return { ...resolution, input };
        }

        return {
            resolved: false,
            outcome: resolution.outcome,
        };
    }

    private createStatusError(error: unknown): DebugSessionStatusFailureResult {
        if (isCommandCancellation(error)) {
            return createStatusFailure('canceled');
        }

        extensionLogOutputChannel.error(`Aspire language model tool ${aspireDebugSessionStatusToolName} failed: ${String(error)}`);
        return createStatusFailure('error');
    }

    private createExplainError(error: unknown): ExplainLaunchFailureFailureResult {
        if (isCommandCancellation(error)) {
            return createExplainFailure('canceled');
        }

        extensionLogOutputChannel.error(`Aspire language model tool ${aspireExplainLaunchFailureToolName} failed: ${String(error)}`);
        return createExplainFailure('error');
    }
}

function createAppHostStatusResult(summary: EditorAppHostSummary): DebugSessionStatusResult {
    const result: DebugSessionStatusResult = {
        success: true,
        tool: aspireDebugSessionStatusToolName,
        outcome: summary.state,
        scope: 'appHost',
        controller: 'editor',
        appHost: summary.appHost,
    };
    if (isModeMeaningful(summary.state)) {
        return { ...result, mode: summary.mode };
    }

    return result;
}

function createResourceStatusResult(
    outcome: DebugSessionStatusResult['outcome'],
    appHost: string,
    resourceName: string,
    mode?: EditorAssistanceMode): DebugSessionStatusResult {
    const result: DebugSessionStatusResult = {
        success: true,
        tool: aspireDebugSessionStatusToolName,
        outcome,
        scope: 'resource',
        controller: 'editor',
        appHost,
        resourceName,
    };
    if (mode !== undefined && isModeMeaningful(outcome)) {
        return { ...result, mode };
    }

    return result;
}

function createResourceFailure(
    outcome: DebugSessionStatusResourceFailureResult['outcome'],
    appHost: string,
    resourceName: string): DebugSessionStatusResourceFailureResult {
    return {
        success: false,
        tool: aspireDebugSessionStatusToolName,
        outcome,
        scope: 'resource',
        controller: 'editor',
        appHost,
        resourceName,
    };
}

function createStatusFailure(outcome: DebugSessionStatusFailureResult['outcome']): DebugSessionStatusFailureResult {
    return {
        success: false,
        tool: aspireDebugSessionStatusToolName,
        outcome,
    };
}

function createExplainFailure(outcome: ExplainLaunchFailureFailureResult['outcome']): ExplainLaunchFailureFailureResult {
    return {
        success: false,
        tool: aspireExplainLaunchFailureToolName,
        outcome,
    };
}

function createOpenDashboardFailure(outcome: OpenDashboardFailureResult['outcome']): OpenDashboardFailureResult {
    return {
        success: false,
        tool: aspireOpenDashboardToolName,
        outcome,
    };
}

function createOpenOutputFailure(outcome: OpenOutputFailureResult['outcome']): OpenOutputFailureResult {
    return {
        success: false,
        tool: aspireOpenOutputToolName,
        outcome,
    };
}

function createListDebugSessionsFailure(
    outcome: Extract<ListDebugSessionsToolResult['outcome'], 'workspaceNotTrusted' | 'invalidInput' | 'canceled' | 'error'>): ListDebugSessionsToolResult {
    return {
        success: false,
        tool: aspireListDebugSessionsToolName,
        outcome,
        sessions: [],
    };
}

function validateEmptyObjectInvocation(
    input: unknown,
    token: vscode.CancellationToken): 'workspaceNotTrusted' | 'invalidInput' | 'canceled' | undefined {
    if (token.isCancellationRequested) {
        return 'canceled';
    }
    if (!vscode.workspace.isTrusted) {
        return 'workspaceNotTrusted';
    }
    if (!isValidEmptyObjectInput(input)) {
        return 'invalidInput';
    }

    return undefined;
}

function isModeMeaningful(outcome: DebugSessionStatusResult['outcome']): boolean {
    return outcome === 'running' || outcome === 'starting' || outcome === 'stopping';
}

function getRecommendedActions(category: ExplainLaunchFailureFoundResult['category']): readonly EditorAssistanceRecommendedAction[] {
    switch (category) {
        case 'invalidConfiguration':
        case 'processExited':
        case 'unknown':
            return ['checkAspireOutput'];
        case 'missingDependency':
        case 'unsupported':
            return ['checkDependencies'];
        case 'cliUnavailable':
            return ['installAspireCli'];
        case 'buildFailed':
            return ['fixBuildErrors'];
        case 'timeout':
        case 'canceled':
            return ['retryLaunch'];
        case 'portConflict':
            return ['freeRequiredPort'];
        case 'permissionDenied':
            return ['checkPermissions'];
        default:
            return ['checkAspireOutput'];
    }
}

function throwIfCanceled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

type ResourceTarget = {
    readonly kind: 'project' | 'executable';
    readonly path: string;
};

function getResourceTarget(resource: ResourceJson): ResourceTarget | undefined {
    const projectPath = resource.properties?.['project.path'];
    if (typeof projectPath === 'string' && projectPath.trim().length > 0) {
        return { kind: 'project', path: projectPath };
    }

    const executablePath = resource.properties?.['executable.path'];
    return typeof executablePath === 'string' && executablePath.trim().length > 0
        ? { kind: 'executable', path: executablePath }
        : undefined;
}

function isSessionTargetMatch(
    session: EditorResourceSessionSnapshot,
    resourceTarget: ResourceTarget): boolean {
    if (resourceTarget.kind === 'project') {
        return isSamePath(session.targetPath, resourceTarget.path);
    }

    const executablePaths = session.resourceExecutablePaths ?? [session.targetPath];
    return executablePaths.some(executablePath => isSamePath(executablePath, resourceTarget.path));
}

function isMissingStoppedAppHostSnapshot(error: unknown): boolean {
    return error instanceof AspireCliParseError &&
        error.command === 'aspire describe' &&
        error.output === '';
}
