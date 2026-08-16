import * as vscode from 'vscode';

import {
    editorAssistanceOpenDashboardConfirmationMessage,
    editorAssistanceOpenDashboardConfirmationTitle,
    editorAssistanceOpenDashboardInvocationMessage,
    editorAssistanceOpenOutputConfirmationMessage,
    editorAssistanceOpenOutputConfirmationTitle,
    editorAssistanceOpenOutputInvocationMessage,
} from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';
import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    aspireListDebugSessionsToolName,
    aspireOpenDashboardToolName,
    aspireOpenOutputToolName,
    type DebugSessionStatusToolInput,
    type EditorAssistanceToolRegistration,
    type EditorAssistanceToolResult,
    type ExplainLaunchFailureToolInput,
    type ListDebugSessionsToolInput,
    type OpenDashboardToolInput,
    type OpenOutputToolInput,
} from './editorAssistanceToolContracts';
import { EditorAssistanceToolService } from './editorAssistanceToolService';
import { EditorAssistanceTelemetry } from './editorAssistanceTelemetry';
import { escapeMarkdown } from './languageModelToolUi';
import { type AppHostTargetIdentity } from './safeAppHostTargetResolver';

export class AspireDebugSessionStatusLanguageModelTool implements vscode.LanguageModelTool<DebugSessionStatusToolInput> {
    constructor(
        private readonly _service: EditorAssistanceToolService,
        private readonly _telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()) {
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DebugSessionStatusToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._telemetry.capture(
            aspireDebugSessionStatusToolName,
            () => this._service.getDebugSessionStatus(options.input, token)));
    }
}

export class AspireExplainLaunchFailureLanguageModelTool implements vscode.LanguageModelTool<ExplainLaunchFailureToolInput> {
    constructor(
        private readonly _service: EditorAssistanceToolService,
        private readonly _telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()) {
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ExplainLaunchFailureToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._telemetry.capture(
            aspireExplainLaunchFailureToolName,
            () => this._service.explainLaunchFailure(options.input, token)));
    }
}

export class AspireOpenDashboardLanguageModelTool implements vscode.LanguageModelTool<OpenDashboardToolInput> {
    private static readonly _maxPreparedSelectors = 32;
    private readonly _preparedIdentities = new Map<string, PreparedDashboardIdentity>();

    constructor(
        private readonly _service: EditorAssistanceToolService,
        private readonly _telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<OpenDashboardToolInput>,
        token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
        const preparedTarget = await this._service.prepareDashboardTarget(options.input?.appHostPath, token);
        if (preparedTarget.identity !== null) {
            this.recordPreparedIdentity(options.input?.appHostPath, preparedTarget.identity);
        }
        else {
            this.invalidatePreparedIdentity(options.input?.appHostPath);
        }
        const displayPath = escapeMarkdown(preparedTarget.displayPath);
        return {
            invocationMessage: editorAssistanceOpenDashboardInvocationMessage(displayPath),
            confirmationMessages: {
                title: editorAssistanceOpenDashboardConfirmationTitle,
                message: editorAssistanceOpenDashboardConfirmationMessage(displayPath),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<OpenDashboardToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const confirmedIdentity = this.consumePreparedIdentity(options.input?.appHostPath);
        return createToolResult(await this._telemetry.capture(
            aspireOpenDashboardToolName,
            () => this._service.openDashboard(options.input, token, confirmedIdentity)));
    }

    private recordPreparedIdentity(rawAppHostPath: unknown, identity: AppHostTargetIdentity): void {
        const selectorKey = getPreparedSelectorKey(rawAppHostPath);
        const existing = this._preparedIdentities.get(selectorKey);
        if (!existing) {
            if (this._preparedIdentities.size >= AspireOpenDashboardLanguageModelTool._maxPreparedSelectors) {
                // The API does not provide a token that correlates prepareInvocation with invoke.
                // Evicting confirmation history could therefore let a delayed invocation consume a
                // newer target's preparation. Missing state fails closed instead.
                return;
            }

            this._preparedIdentities.set(selectorKey, {
                identity,
                conflicted: false,
                available: true,
            });
            return;
        }

        if (existing.identity !== identity) {
            existing.conflicted = true;
            existing.available = false;
        }
        else if (!existing.conflicted) {
            existing.available = true;
        }
    }

    private invalidatePreparedIdentity(rawAppHostPath: unknown): void {
        const prepared = this._preparedIdentities.get(getPreparedSelectorKey(rawAppHostPath));
        if (prepared) {
            prepared.available = false;
        }
    }

    private consumePreparedIdentity(rawAppHostPath: unknown): AppHostTargetIdentity | null {
        const selectorKey = getPreparedSelectorKey(rawAppHostPath);
        const prepared = this._preparedIdentities.get(selectorKey);
        if (!prepared || prepared.conflicted || !prepared.available) {
            return null;
        }

        prepared.available = false;
        return prepared.identity;
    }
}

export class AspireOpenOutputLanguageModelTool implements vscode.LanguageModelTool<OpenOutputToolInput> {
    constructor(
        private readonly _service: EditorAssistanceToolService,
        private readonly _telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()) {
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<OpenOutputToolInput>,
        _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: editorAssistanceOpenOutputInvocationMessage,
            confirmationMessages: {
                title: editorAssistanceOpenOutputConfirmationTitle,
                message: editorAssistanceOpenOutputConfirmationMessage,
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<OpenOutputToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._telemetry.capture(
            aspireOpenOutputToolName,
            () => this._service.openOutput(options.input, token)));
    }
}

export class AspireListDebugSessionsLanguageModelTool implements vscode.LanguageModelTool<ListDebugSessionsToolInput> {
    constructor(
        private readonly _service: EditorAssistanceToolService,
        private readonly _telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()) {
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListDebugSessionsToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._telemetry.capture(
            aspireListDebugSessionsToolName,
            () => this._service.listDebugSessions(options.input, token)));
    }
}

/**
 * Registers editor-assistance tools when the stable language model tool API exists.
 *
 * Status, explanation, and session listing are read-only and intentionally expose only
 * `invoke`. Dashboard and Output handoff change editor UI, so those two adapters alone
 * implement confirmation preparation.
 */
export function registerEditorAssistanceTools(
    service: EditorAssistanceToolService,
    telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()): EditorAssistanceToolRegistration {
    const registrations: vscode.Disposable[] = [];
    const statusTool = new AspireDebugSessionStatusLanguageModelTool(service, telemetry);
    const explainTool = new AspireExplainLaunchFailureLanguageModelTool(service, telemetry);
    const dashboardTool = new AspireOpenDashboardLanguageModelTool(service, telemetry);
    const outputTool = new AspireOpenOutputLanguageModelTool(service, telemetry);
    const listTool = new AspireListDebugSessionsLanguageModelTool(service, telemetry);
    const tools = new Map<string, vscode.LanguageModelTool<unknown>>([
        [aspireDebugSessionStatusToolName, statusTool as vscode.LanguageModelTool<unknown>],
        [aspireExplainLaunchFailureToolName, explainTool as vscode.LanguageModelTool<unknown>],
        [aspireOpenDashboardToolName, dashboardTool as vscode.LanguageModelTool<unknown>],
        [aspireOpenOutputToolName, outputTool as vscode.LanguageModelTool<unknown>],
        [aspireListDebugSessionsToolName, listTool as vscode.LanguageModelTool<unknown>],
    ]);

    if (typeof vscode.lm?.registerTool !== 'function') {
        extensionLogOutputChannel.info('Skipping Aspire editor assistance language model tools: the language model tool API is unavailable.');
    }
    else {
        registrations.push(
            vscode.lm.registerTool(aspireDebugSessionStatusToolName, statusTool),
            vscode.lm.registerTool(aspireExplainLaunchFailureToolName, explainTool),
            vscode.lm.registerTool(aspireOpenDashboardToolName, dashboardTool),
            vscode.lm.registerTool(aspireOpenOutputToolName, outputTool),
            vscode.lm.registerTool(aspireListDebugSessionsToolName, listTool));
        extensionLogOutputChannel.info('Registered Aspire editor assistance language model tools.');
    }

    return {
        get registered() {
            return registrations.length > 0;
        },
        tools,
        dispose() {
            registrations.forEach(registration => registration.dispose());
            registrations.length = 0;
        },
    };
}

function createToolResult(result: EditorAssistanceToolResult): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(result)),
    ]);
}

function getPreparedSelectorKey(rawAppHostPath: unknown): string {
    return typeof rawAppHostPath === 'string'
        ? `path:${rawAppHostPath}`
        : `invalid:${typeof rawAppHostPath}`;
}

interface PreparedDashboardIdentity {
    readonly identity: AppHostTargetIdentity;
    conflicted: boolean;
    available: boolean;
}
