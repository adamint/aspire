import * as vscode from 'vscode';

import {
    editorAssistanceOpenDashboardConfirmationMessage,
    editorAssistanceOpenDashboardConfirmationTitle,
    editorAssistanceOpenDashboardInvocationMessage,
    editorAssistanceOpenOutputConfirmationMessage,
    editorAssistanceOpenOutputConfirmationTitle,
    editorAssistanceOpenOutputInvocationMessage,
    yesLabel,
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
    private static readonly _preparedIdentityTtlMs = 10 * 60 * 1000;
    private readonly _preparedIdentities = new Map<string, PreparedDashboardIdentity>();
    private _requiresInvocationConfirmation = false;

    constructor(
        private readonly _service: EditorAssistanceToolService,
        private readonly _telemetry: EditorAssistanceTelemetry = new EditorAssistanceTelemetry()) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<OpenDashboardToolInput>,
        token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
        const preparedTarget = await this._service.prepareDashboardTarget(options.input?.appHostPath, token);
        this.recordPreparedIdentity(options.input?.appHostPath, preparedTarget.identity, token);
        const displayPath = escapeMarkdown(preparedTarget.displayPath);
        const preparedInvocation: vscode.PreparedToolInvocation = {
            invocationMessage: editorAssistanceOpenDashboardInvocationMessage(displayPath),
        };
        if (!this._requiresInvocationConfirmation) {
            preparedInvocation.confirmationMessages = {
                title: editorAssistanceOpenDashboardConfirmationTitle,
                message: editorAssistanceOpenDashboardConfirmationMessage(displayPath),
            };
        }

        return preparedInvocation;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<OpenDashboardToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const confirmedIdentity = this.consumePreparedIdentity(options.input?.appHostPath);
        return createToolResult(await this._telemetry.capture(
            aspireOpenDashboardToolName,
            () => this._requiresInvocationConfirmation
                ? this.confirmAndOpenDashboard(options.input, token)
                : this._service.openDashboard(options.input, token, confirmedIdentity)));
    }

    private recordPreparedIdentity(
        rawAppHostPath: unknown,
        identity: AppHostTargetIdentity | null,
        token: vscode.CancellationToken): void {
        this.pruneExpiredPreparedIdentities();
        if (this._requiresInvocationConfirmation) {
            return;
        }

        const selectorKey = getPreparedSelectorKey(rawAppHostPath);
        const existing = this._preparedIdentities.get(selectorKey);
        if (existing || this._preparedIdentities.size >= AspireOpenDashboardLanguageModelTool._maxPreparedSelectors) {
            // The stable API does not expose the tool-call identifier used internally by VS Code.
            // Once preparations overlap or exceed the bound, confirm inside each invocation so a
            // delayed call cannot consume another call's target identity.
            this.requireInvocationConfirmation();
            return;
        }

        const prepared: PreparedDashboardIdentity = {
            identity,
            createdAt: Date.now(),
            cancellationRegistration: undefined,
        };
        this._preparedIdentities.set(selectorKey, prepared);
        prepared.cancellationRegistration = token.onCancellationRequested(
            () => this.removePreparedIdentity(selectorKey, prepared));
    }

    private consumePreparedIdentity(rawAppHostPath: unknown): AppHostTargetIdentity | null {
        this.pruneExpiredPreparedIdentities();
        const selectorKey = getPreparedSelectorKey(rawAppHostPath);
        const prepared = this._preparedIdentities.get(selectorKey);
        if (!prepared) {
            return null;
        }

        this._preparedIdentities.delete(selectorKey);
        prepared.cancellationRegistration?.dispose();
        return prepared.identity;
    }

    private removePreparedIdentity(selectorKey: string, prepared: PreparedDashboardIdentity): void {
        if (this._preparedIdentities.get(selectorKey) !== prepared) {
            return;
        }

        this._preparedIdentities.delete(selectorKey);
    }

    private pruneExpiredPreparedIdentities(): void {
        const expirationTime = Date.now() - AspireOpenDashboardLanguageModelTool._preparedIdentityTtlMs;
        for (const prepared of this._preparedIdentities.values()) {
            if (prepared.createdAt <= expirationTime) {
                this.requireInvocationConfirmation();
                return;
            }
        }
    }

    private requireInvocationConfirmation(): void {
        for (const prepared of this._preparedIdentities.values()) {
            prepared.cancellationRegistration?.dispose();
        }
        this._preparedIdentities.clear();
        this._requiresInvocationConfirmation = true;
    }

    private async confirmAndOpenDashboard(
        input: OpenDashboardToolInput,
        token: vscode.CancellationToken): Promise<EditorAssistanceToolResult> {
        const preparedTarget = await this._service.prepareDashboardTarget(input?.appHostPath, token);
        if (preparedTarget.identity === null) {
            return this._service.openDashboard(input, token, null);
        }

        const confirmationItem: vscode.MessageItem = {
            title: yesLabel,
        };
        const selected = await vscode.window.showWarningMessage(
            editorAssistanceOpenDashboardConfirmationTitle,
            {
                modal: true,
                detail: editorAssistanceOpenDashboardConfirmationMessage(preparedTarget.displayPath),
            },
            confirmationItem);
        if (selected?.title !== confirmationItem.title) {
            return {
                success: false,
                tool: aspireOpenDashboardToolName,
                outcome: 'canceled',
            };
        }

        return this._service.openDashboard(input, token, preparedTarget.identity);
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
    readonly identity: AppHostTargetIdentity | null;
    readonly createdAt: number;
    cancellationRegistration: vscode.Disposable | undefined;
}
