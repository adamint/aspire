import * as vscode from 'vscode';

import { extensionLogOutputChannel } from '../utils/logging';
import { isSameAppHostPath, isSamePath } from '../utils/paths/comparison';
import { isCommandCancellation } from '../utils/telemetry';
import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    isValidDebugSessionStatusInput,
    isValidExplainLaunchFailureInput,
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
} from './editorAssistanceToolContracts';
import { type EditorAppHostSummary } from './editorStateSnapshotService';
import { type ResolvedAppHostTarget, type SafeAppHostTargetResolution } from './safeAppHostTargetResolver';

type ResolvedPreflight<T> =
    | { readonly resolved: true; readonly target: ResolvedAppHostTarget; readonly input: T }
    | { readonly resolved: false; readonly outcome: 'appHostNotFound' | 'ambiguousAppHost' | 'workspaceNotTrusted' | 'invalidInput' | 'canceled' | 'error' };

/**
 * Provides read-only, model-safe answers about editor-owned Aspire sessions and
 * the latest sanitized AppHost launch failure.
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

            const resources = await this._dependencies.resourceRepository.fetchAppHostResourcesOnce(
                preflight.target.absolutePath,
                token);
            throwIfCanceled(token);

            const matches = resources.filter(resource => resource.name === preflight.input.resourceName);
            if (matches.length === 0) {
                return createResourceFailure(
                    'resourceNotFound',
                    preflight.target.displayPath,
                    preflight.input.resourceName);
            }
            if (matches.length > 1) {
                return createResourceFailure(
                    'resourceAmbiguous',
                    preflight.target.displayPath,
                    preflight.input.resourceName);
            }

            const resource = matches[0];
            const projectPath = resource.properties?.['project.path'];
            if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
                return createResourceStatusResult(
                    'notDebugging',
                    preflight.target.displayPath,
                    resource.name);
            }

            const sessions = this._dependencies.getEditorResourceSessions().filter(session =>
                isSameAppHostPath(session.appHostPath, preflight.target.absolutePath) &&
                isSamePath(session.projectPath, projectPath));
            if (sessions.length === 0) {
                return createResourceStatusResult(
                    'notDebugging',
                    preflight.target.displayPath,
                    resource.name);
            }
            if (sessions.length > 1) {
                return createResourceStatusResult(
                    'multipleSessions',
                    preflight.target.displayPath,
                    resource.name);
            }

            const session = sessions[0];
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
