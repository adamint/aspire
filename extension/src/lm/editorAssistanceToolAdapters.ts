import * as vscode from 'vscode';

import { extensionLogOutputChannel } from '../utils/logging';
import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    type DebugSessionStatusToolInput,
    type EditorAssistanceToolRegistration,
    type EditorAssistanceToolResult,
    type ExplainLaunchFailureToolInput,
} from './editorAssistanceToolContracts';
import { EditorAssistanceToolService } from './editorAssistanceToolService';

export class AspireDebugSessionStatusLanguageModelTool implements vscode.LanguageModelTool<DebugSessionStatusToolInput> {
    constructor(private readonly _service: EditorAssistanceToolService) {
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DebugSessionStatusToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.getDebugSessionStatus(options.input, token));
    }
}

export class AspireExplainLaunchFailureLanguageModelTool implements vscode.LanguageModelTool<ExplainLaunchFailureToolInput> {
    constructor(private readonly _service: EditorAssistanceToolService) {
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ExplainLaunchFailureToolInput>,
        token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.explainLaunchFailure(options.input, token));
    }
}

/**
 * Registers the read-only editor-assistance tools when the stable language model
 * tool API exists. These adapters intentionally implement only `invoke`: status
 * and explanation calls neither mutate editor state nor require confirmation.
 */
export function registerEditorAssistanceTools(service: EditorAssistanceToolService): EditorAssistanceToolRegistration {
    const registrations: vscode.Disposable[] = [];
    const statusTool = new AspireDebugSessionStatusLanguageModelTool(service);
    const explainTool = new AspireExplainLaunchFailureLanguageModelTool(service);
    const tools = new Map<string, vscode.LanguageModelTool<unknown>>([
        [aspireDebugSessionStatusToolName, statusTool as vscode.LanguageModelTool<unknown>],
        [aspireExplainLaunchFailureToolName, explainTool as vscode.LanguageModelTool<unknown>],
    ]);

    if (typeof vscode.lm?.registerTool !== 'function') {
        extensionLogOutputChannel.info('Skipping Aspire editor assistance language model tools: the language model tool API is unavailable.');
    }
    else {
        registrations.push(
            vscode.lm.registerTool(aspireDebugSessionStatusToolName, statusTool),
            vscode.lm.registerTool(aspireExplainLaunchFailureToolName, explainTool));
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
