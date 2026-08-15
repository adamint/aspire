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
import { type EditorAppHostSummary, type EditorStateSnapshotService } from './editorStateSnapshotService';
import {
    type AppHostTargetIdentity,
    type ResolvedAppHostTarget,
    type SafeAppHostTargetResolver,
} from './safeAppHostTargetResolver';
import {
    type DashboardBrowserType,
    type DashboardPresentation,
} from '../debugger/session/dashboardLauncher';
import { type AppHostDisplayInfo } from '../data/appHostCliContracts';

export const aspireDebugSessionStatusToolName = 'aspire_debug_session_status';
export const aspireExplainLaunchFailureToolName = 'aspire_explain_launch_failure';
export const aspireOpenDashboardToolName = 'aspire_open_dashboard';
export const aspireOpenOutputToolName = 'aspire_open_output';
export const aspireListDebugSessionsToolName = 'aspire_list_debug_sessions';

export type EditorAssistanceToolName =
    | typeof aspireDebugSessionStatusToolName
    | typeof aspireExplainLaunchFailureToolName
    | typeof aspireOpenDashboardToolName
    | typeof aspireOpenOutputToolName
    | typeof aspireListDebugSessionsToolName;

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

export type OpenDashboardOutcome =
    | 'opened'
    | 'dashboardUnavailable'
    | 'appHostNotRunning'
    | 'appHostNotFound'
    | 'ambiguousAppHost'
    | 'workspaceNotTrusted'
    | 'invalidInput'
    | 'canceled'
    | 'error';

export type OpenOutputOutcome =
    | 'opened'
    | 'workspaceNotTrusted'
    | 'invalidInput'
    | 'canceled'
    | 'error';

export type ListDebugSessionsOutcome =
    | 'sessionsFound'
    | 'noSessions'
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

interface AppHostPathOnlyInput {
    readonly appHostPath: string;
}

export type ExplainLaunchFailureToolInput = AppHostPathOnlyInput;
export type OpenDashboardToolInput = AppHostPathOnlyInput;

export type OpenOutputToolInput = Record<string, never>;
export type ListDebugSessionsToolInput = Record<string, never>;

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

export interface OpenDashboardSuccessResult {
    readonly success: true;
    readonly tool: typeof aspireOpenDashboardToolName;
    readonly outcome: 'opened';
    readonly presentation: DashboardPresentation;
}

export interface OpenDashboardFailureResult {
    readonly success: false;
    readonly tool: typeof aspireOpenDashboardToolName;
    readonly outcome: Exclude<OpenDashboardOutcome, 'opened'>;
}

export type OpenDashboardToolResult =
    | OpenDashboardSuccessResult
    | OpenDashboardFailureResult;

export interface OpenOutputSuccessResult {
    readonly success: true;
    readonly tool: typeof aspireOpenOutputToolName;
    readonly outcome: 'opened';
}

export interface OpenOutputFailureResult {
    readonly success: false;
    readonly tool: typeof aspireOpenOutputToolName;
    readonly outcome: Exclude<OpenOutputOutcome, 'opened'>;
}

export type OpenOutputToolResult =
    | OpenOutputSuccessResult
    | OpenOutputFailureResult;

export interface ListDebugSessionsToolResult {
    readonly success: boolean;
    readonly tool: typeof aspireListDebugSessionsToolName;
    readonly outcome: ListDebugSessionsOutcome;
    readonly sessions: readonly EditorAppHostSummary[];
    readonly truncated?: true;
}

export type EditorAssistanceToolResult =
    | DebugSessionStatusToolResult
    | ExplainLaunchFailureToolResult
    | OpenDashboardToolResult
    | OpenOutputToolResult
    | ListDebugSessionsToolResult;

export interface EditorAssistanceResourceRepository {
    getAppHostResources(
        appHostPath: string,
        resourceName: string,
        waitForResource: boolean,
        token: vscode.CancellationToken): Promise<readonly ResourceJson[]>;
}

export interface EditorUiHandoffAppHostRepository {
    fetchRunningAppHostsOnce(token: vscode.CancellationToken): Promise<readonly AppHostDisplayInfo[]>;
}

export interface EditorUiHandoffOutput {
    show(preserveFocus?: boolean): void;
}

export interface EditorUiHandoffDebugSession {
    readonly cliProcessId: number | undefined;
    readonly configuration: { readonly dashboardBrowser?: unknown };
    readonly isShuttingDown: boolean;
    openDashboard(url: string, browserType: DashboardBrowserType): Promise<DashboardPresentation | undefined>;
}

export type EditorUiHandoffDashboardResult =
    | { readonly outcome: 'opened'; readonly presentation: DashboardPresentation }
    | { readonly outcome: 'dashboardUnavailable' | 'appHostNotRunning' | 'ambiguousAppHost' | 'error' };

export interface EditorUiHandoffOperations {
    openDashboard(target: ResolvedAppHostTarget, token: vscode.CancellationToken): Promise<EditorUiHandoffDashboardResult>;
    openOutput(token: vscode.CancellationToken): Promise<'opened' | 'error'>;
}

export interface EditorUiHandoffServiceDependencies {
    readonly targetResolver: SafeAppHostTargetResolver;
    readonly appHostRepository: EditorUiHandoffAppHostRepository;
    readonly output: EditorUiHandoffOutput;
    readonly getAspireDebugSessions: (identity: AppHostTargetIdentity) => readonly EditorUiHandoffDebugSession[];
}

export interface EditorAssistanceToolDependencies {
    readonly targetResolver: SafeAppHostTargetResolver;
    readonly snapshotService: EditorStateSnapshotService;
    readonly resourceRepository: EditorAssistanceResourceRepository;
    readonly getEditorResourceSessions: () => readonly EditorResourceSessionSnapshot[];
    readonly readLatestLaunchFailures: (appHostPath: string) => readonly SanitizedLaunchFailure[];
    readonly uiHandoffService: EditorUiHandoffOperations;
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

export function isValidAppHostPathOnlyInput(value: unknown): value is AppHostPathOnlyInput {
    return hasOnlyAllowedProperties(value, ['appHostPath']) &&
        typeof value.appHostPath === 'string';
}

export function isValidEmptyObjectInput(value: unknown): value is OpenOutputToolInput | ListDebugSessionsToolInput {
    return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
        Object.keys(value).length === 0;
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
