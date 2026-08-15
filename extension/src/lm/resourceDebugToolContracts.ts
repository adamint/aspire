import type * as vscode from 'vscode';

import type {
    ResourceDebugErrorKind,
    ResourceDebugExtensionRequirement,
    ResourceDebugger,
} from '../debugger/resourceDebugContracts';
import type { SafeAppHostTarget, SafeAppHostTargetResolver } from './appHostLifecycleToolContracts';

export const aspireResourceDebugToolName = 'aspire_resource_debug';

export type AspireResourceDebugStrategy = 'auto' | 'attach';

export interface AspireResourceDebugToolInput {
    readonly appHostPath: string;
    readonly resourceName: string;
    readonly strategy?: AspireResourceDebugStrategy;
}

export type AspireResourceDebugToolOutcome =
    | 'started'
    | 'alreadyDebugging'
    | 'appHostNotFound'
    | 'resourceNotFound'
    | 'unsupportedResource'
    | 'resourceNotRunning'
    | 'debuggerExtensionMissing'
    | 'error'
    | 'invalidInput'
    | 'unknownAppHost'
    | 'ambiguousAppHost'
    | 'discoveryFailed'
    | 'workspaceNotTrusted'
    | 'cancelled'
    | 'failed';

/**
 * The entire language-model result boundary. It contains only caller-approved resource
 * identity, resolver-produced display identity, and bounded debugger state.
 */
export interface AspireResourceDebugToolResult {
    readonly tool: typeof aspireResourceDebugToolName;
    readonly success: boolean;
    readonly outcome: AspireResourceDebugToolOutcome;
    readonly appHost: string;
    readonly resourceName: string;
    readonly requestedStrategy: AspireResourceDebugStrategy;
    readonly effectiveStrategy: 'attach' | 'none';
    readonly controller: 'editor' | 'none';
    readonly provider?: 'dotnet' | 'go';
    readonly debuggerExtensions?: readonly ResourceDebugExtensionRequirement[];
    readonly errorKind?: ResourceDebugErrorKind;
}

export interface AspireResourceDebugToolDependencies {
    readonly targetResolver: SafeAppHostTargetResolver;
    readonly resourceDebugger: ResourceDebugger;
}

export type AspireResourceDebugToolPreparation =
    | {
        readonly canDebug: true;
        readonly target: SafeAppHostTarget;
        readonly resourceName: string;
        readonly requestedStrategy: AspireResourceDebugStrategy;
    }
    | {
        readonly canDebug: false;
        readonly result: AspireResourceDebugToolResult;
    };

export interface AspireResourceDebugToolRegistration extends vscode.Disposable {
    readonly registered: boolean;
}

export type { SafeAppHostTargetResolver, SafeAppHostTargetResolution } from './appHostLifecycleToolContracts';
