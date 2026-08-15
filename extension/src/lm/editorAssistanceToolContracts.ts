import * as vscode from 'vscode';

import { type ResourceJson } from '../data/appHostCliContracts';
import { type EditorResourceSessionSnapshot } from '../services/appHostLaunchContracts';
import {
    type LaunchFailureCategory,
    type LaunchFailureController,
    type LaunchFailureExitCodeBucket,
    type LaunchFailureMode,
    type LaunchFailureProviderKind,
    type LaunchFailureStage,
    type SanitizedLaunchFailure,
} from '../services/launchFailureJournal';
import { type EditorStateSnapshotService } from './editorStateSnapshotService';
import { type SafeAppHostTargetResolver } from './safeAppHostTargetResolver';

export const aspireDebugSessionStatusToolName = 'aspire_debug_session_status';
export const aspireExplainLaunchFailureToolName = 'aspire_explain_launch_failure';

const maxResourceNameLength = 256;
const identityChangingCharacters = /[\u0000-\u001F\u007F-\u009F]|\p{Cf}/u;

export type DebugSessionStatusOutcome =
    | 'running'
    | 'starting'
    | 'stopping'
    | 'notDebugging'
    | 'multipleSessions'
    | 'appHostNotFound'
    | 'ambiguousAppHost'
    | 'resourceNotFound'
    | 'resourceAmbiguous'
    | 'workspaceNotTrusted'
    | 'invalidInput'
    | 'canceled'
    | 'error';

export type ExplainLaunchFailureOutcome =
    | 'failureFound'
    | 'noRecordedFailure'
    | 'appHostNotFound'
    | 'ambiguousAppHost'
    | 'workspaceNotTrusted'
    | 'invalidInput'
    | 'canceled'
    | 'error';

export type EditorAssistanceScope = 'appHost' | 'resource';
export type EditorAssistanceMode = 'run' | 'debug' | 'other';

export type EditorAssistanceRecommendedAction =
    | 'checkAspireOutput'
    | 'fixBuildErrors'
    | 'installAspireCli'
    | 'checkDependencies'
    | 'freeRequiredPort'
    | 'checkPermissions'
    | 'retryLaunch';

export interface DebugSessionStatusToolInput {
    readonly appHostPath: string;
    readonly resourceName?: string;
}

export interface ExplainLaunchFailureToolInput {
    readonly appHostPath: string;
}

export interface DebugSessionStatusResult {
    readonly success: true;
    readonly tool: typeof aspireDebugSessionStatusToolName;
    readonly outcome: 'running' | 'starting' | 'stopping' | 'notDebugging' | 'multipleSessions';
    readonly scope: EditorAssistanceScope;
    readonly controller: 'editor';
    readonly mode?: EditorAssistanceMode;
    readonly appHost: string;
    readonly resourceName?: string;
}

export interface DebugSessionStatusResourceFailureResult {
    readonly success: false;
    readonly tool: typeof aspireDebugSessionStatusToolName;
    readonly outcome: 'resourceNotFound' | 'resourceAmbiguous';
    readonly scope: 'resource';
    readonly controller: 'editor';
    readonly appHost: string;
    readonly resourceName: string;
}

export interface DebugSessionStatusFailureResult {
    readonly success: false;
    readonly tool: typeof aspireDebugSessionStatusToolName;
    readonly outcome:
        | 'appHostNotFound'
        | 'ambiguousAppHost'
        | 'workspaceNotTrusted'
        | 'invalidInput'
        | 'canceled'
        | 'error';
}

export type DebugSessionStatusToolResult =
    | DebugSessionStatusResult
    | DebugSessionStatusResourceFailureResult
    | DebugSessionStatusFailureResult;

export interface ExplainLaunchFailureFoundResult {
    readonly success: true;
    readonly tool: typeof aspireExplainLaunchFailureToolName;
    readonly outcome: 'failureFound';
    readonly appHost: string;
    readonly stage: LaunchFailureStage;
    readonly category: LaunchFailureCategory;
    readonly controller: LaunchFailureController;
    readonly mode: LaunchFailureMode;
    readonly providerKind: LaunchFailureProviderKind;
    readonly exitCodeBucket: LaunchFailureExitCodeBucket;
    readonly recommendedActions: readonly EditorAssistanceRecommendedAction[];
}

export interface ExplainLaunchFailureNotFoundResult {
    readonly success: true;
    readonly tool: typeof aspireExplainLaunchFailureToolName;
    readonly outcome: 'noRecordedFailure';
    readonly appHost: string;
}

export interface ExplainLaunchFailureFailureResult {
    readonly success: false;
    readonly tool: typeof aspireExplainLaunchFailureToolName;
    readonly outcome:
        | 'appHostNotFound'
        | 'ambiguousAppHost'
        | 'workspaceNotTrusted'
        | 'invalidInput'
        | 'canceled'
        | 'error';
}

export type ExplainLaunchFailureToolResult =
    | ExplainLaunchFailureFoundResult
    | ExplainLaunchFailureNotFoundResult
    | ExplainLaunchFailureFailureResult;

export type EditorAssistanceToolResult =
    | DebugSessionStatusToolResult
    | ExplainLaunchFailureToolResult;

export interface EditorAssistanceResourceRepository {
    fetchAppHostResourcesOnce(appHostPath: string, token: vscode.CancellationToken): Promise<readonly ResourceJson[]>;
}

export interface EditorAssistanceToolDependencies {
    readonly targetResolver: SafeAppHostTargetResolver;
    readonly snapshotService: EditorStateSnapshotService;
    readonly resourceRepository: EditorAssistanceResourceRepository;
    readonly getEditorResourceSessions: () => readonly EditorResourceSessionSnapshot[];
    readonly readLatestLaunchFailures: (appHostPath: string) => readonly SanitizedLaunchFailure[];
}

export interface EditorAssistanceToolRegistration extends vscode.Disposable {
    readonly registered: boolean;
    readonly tools: ReadonlyMap<string, vscode.LanguageModelTool<unknown>>;
}

export function isValidDebugSessionStatusInput(value: unknown): value is DebugSessionStatusToolInput {
    if (!hasOnlyAllowedProperties(value, ['appHostPath', 'resourceName']) ||
        typeof value.appHostPath !== 'string') {
        return false;
    }

    if (!Object.prototype.hasOwnProperty.call(value, 'resourceName')) {
        return true;
    }

    return typeof value.resourceName === 'string' &&
        value.resourceName.trim().length > 0 &&
        value.resourceName.length <= maxResourceNameLength &&
        !identityChangingCharacters.test(value.resourceName);
}

export function isValidExplainLaunchFailureInput(value: unknown): value is ExplainLaunchFailureToolInput {
    return hasOnlyAllowedProperties(value, ['appHostPath']) &&
        typeof value.appHostPath === 'string';
}

function hasOnlyAllowedProperties<T extends string>(
    value: unknown,
    properties: readonly T[]): value is Record<T, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const actualProperties = Object.keys(value);
    return actualProperties.length > 0 &&
        actualProperties.every(property => properties.includes(property as T)) &&
        Object.prototype.hasOwnProperty.call(value, 'appHostPath');
}
