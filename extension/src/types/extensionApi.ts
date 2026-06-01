import type * as vscode from 'vscode';
import type { ViewMode } from '../views/AppHostDataRepository';
import type { CommandInvocationEvent } from '../utils/telemetry';
import type { AspireTerminalCommandEvent } from '../utils/AspireTerminalProvider';
import type { AppHostLaunchRequestedEvent } from '../services/AppHostLaunchService';

export interface AspireExtensionStateSnapshot {
    viewMode: ViewMode;
    isRepositoryLoading: boolean;
    isWorkspaceAppHostDiscoveryComplete: boolean;
    hasError: boolean;
    errorMessage: string | undefined;
    workspaceAppHost: AspireAppHostState | undefined;
    workspaceAppHostName: string | undefined;
    workspaceAppHostPath: string | undefined;
    workspaceAppHostCandidatePaths: readonly string[];
    workspaceAppHostDescription: string | undefined;
    workspaceResources: readonly AspireResourceState[];
    appHosts: readonly AspireAppHostState[];
    launchingPaths: readonly string[];
    debugSessions: readonly AspireDebugSessionState[];
}

export interface AspireAppHostState {
    appHostPath: string;
    appHostPid: number;
    dashboardUrl: string | null;
    resources: readonly AspireResourceState[] | null | undefined;
}

export interface AspireResourceState {
    name: string;
    displayName: string | null;
    resourceType: string;
    state: string | null;
    dashboardUrl: string | null;
    urls: readonly AspireResourceUrlState[] | null;
    commands: Record<string, AspireResourceCommandState> | null;
}

export interface AspireResourceUrlState {
    name: string | null;
    displayName: string | null;
    url: string;
    isInternal: boolean;
}

export interface AspireResourceCommandState {
    displayName?: string | null;
    description: string | null;
    visibility?: string | null;
}

export interface AspireDebugSessionState {
    appHostPath: string | undefined;
    dashboardUrl: string | undefined;
    startupCompleted: boolean;
}

export interface AspireServerInfo {
    address: string;
}

export interface WaitForStateOptions {
    timeoutMs?: number;
}

export interface AspireExtensionApi {
    readonly apiVersion: 1;
    readonly rpcServerInfo: AspireServerInfo;
    readonly dcpServerInfo: AspireServerInfo;
    readonly logDirectory: string;
    readonly state: AspireExtensionStateSnapshot;
    readonly onDidChangeState: vscode.Event<AspireExtensionStateSnapshot>;
    waitForState(predicate: (state: AspireExtensionStateSnapshot) => boolean, options?: WaitForStateOptions): Promise<AspireExtensionStateSnapshot>;
    waitForRepositoryIdle(options?: WaitForStateOptions): Promise<AspireExtensionStateSnapshot>;
    getDashboardUrl(appHostPath?: string): string | undefined;
}

export interface AspireExtensionE2EStateFile {
    updatedAt: string;
    state: AspireExtensionStateSnapshot;
    dashboardUrl?: string;
    commandInvocations: readonly CommandInvocationEvent[];
    terminalCommands: readonly AspireTerminalCommandEvent[];
    debugLaunches: readonly AppHostLaunchRequestedEvent[];
    control?: AspireExtensionE2EControlStatus;
}

export interface AspireExtensionE2EControlStatus {
    revision: number;
    status: 'started' | 'applied' | 'error';
    errorMessage?: string;
    result?: unknown;
}

export interface AspireExtensionE2EControlPayload {
    revision: number;
    aspireCliExecutablePath?: string;
    forceCliUnavailable?: boolean;
    suppressTerminalCommandExecution?: boolean;
    suppressDebugLaunch?: boolean;
    command?: AspireExtensionE2EControlCommand;
}

export type AspireExtensionE2EControlCommand =
    | { name: 'refreshAppHosts' }
    | { name: 'globalRefreshAppHosts' }
    | { name: 'switchToGlobalView' }
    | { name: 'switchToWorkspaceView' }
    | { name: 'runAppHost'; appHostPath?: string }
    | { name: 'stopAppHost'; appHostPath?: string }
    | { name: 'openDashboard'; appHostPath?: string }
    | { name: 'debugAppHost'; appHostPath?: string }
    | { name: 'openAppHostSource'; appHostPath?: string }
    | { name: 'viewAppHostSource'; appHostPath?: string }
    | { name: 'copyAppHostPath'; appHostPath?: string }
    | { name: 'viewAppHostLogFile'; appHostPath?: string }
    | { name: 'copyLogFilePath'; appHostPath?: string }
    | { name: 'viewResourceLogs'; appHostPath?: string; resourceName: string }
    | { name: 'copyResourceName'; appHostPath?: string; resourceName: string }
    | { name: 'copyEndpointUrl'; appHostPath?: string; resourceName?: string; url?: string }
    | { name: 'openInIntegratedBrowser'; appHostPath?: string; resourceName?: string; url?: string }
    | { name: 'stopResource'; appHostPath?: string; resourceName: string }
    | { name: 'startResource'; appHostPath?: string; resourceName: string }
    | { name: 'restartResource'; appHostPath?: string; resourceName: string }
    | { name: 'executeResourceCommand'; appHostPath?: string; resourceName: string }
    | { name: 'executeAspireCommand'; commandId: string; args?: readonly unknown[] }
    | { name: 'setSourceBreakpoint'; filePath: string; line: number; clearExisting?: boolean }
    | { name: 'clearBreakpoints' }
    | { name: 'getBreakpoints' }
    | { name: 'stopDebugging' }
    | { name: 'closeAllEditors' }
    | { name: 'getRegisteredAspireCommands' }
    | { name: 'getExtensionPackageJson' }
    | { name: 'getExtensionFileStatus'; relativePaths: readonly string[] }
    | { name: 'getDiagnostics'; filePath: string }
    | { name: 'readClipboard' }
    | { name: 'getActiveEditor' };
