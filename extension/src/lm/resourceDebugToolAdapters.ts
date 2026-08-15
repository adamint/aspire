import * as vscode from 'vscode';

import {
    resourceDebugToolConfirmationMessage,
    resourceDebugToolConfirmationTitle,
    resourceDebugToolInvocationMessage,
    resourceDebugToolUnavailableInvocationMessage,
} from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';
import {
    aspireResourceDebugToolName,
    type AspireResourceDebugToolInput,
    type AspireResourceDebugToolRegistration,
    type AspireResourceDebugToolResult,
} from './resourceDebugToolContracts';
import { AspireResourceDebugToolService } from './resourceDebugToolService';

export class AspireResourceDebugLanguageModelTool implements vscode.LanguageModelTool<AspireResourceDebugToolInput> {
    constructor(private readonly _service: AspireResourceDebugToolService) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AspireResourceDebugToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const preparation = await this._service.prepare(options.input, token);
        if (!preparation.canDebug) {
            // There is no safe target to confirm, so never fabricate a path for the
            // progress message. Invocation independently resolves and bounds its result.
            return { invocationMessage: resourceDebugToolUnavailableInvocationMessage };
        }

        const resourceName = escapeMarkdown(preparation.resourceName);
        const appHost = escapeMarkdown(preparation.target.displayPath);
        return {
            invocationMessage: resourceDebugToolInvocationMessage(resourceName),
            confirmationMessages: {
                title: resourceDebugToolConfirmationTitle,
                message: resourceDebugToolConfirmationMessage(resourceName, appHost),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AspireResourceDebugToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.debug(options.input, token));
    }
}

export function registerAspireResourceDebugTool(service: AspireResourceDebugToolService): AspireResourceDebugToolRegistration {
    const registrations: vscode.Disposable[] = [];

    if (typeof vscode.lm?.registerTool !== 'function') {
        extensionLogOutputChannel.info('Skipping Aspire resource debug language model tool: the language model tool API is unavailable.');
    }
    else {
        registrations.push(vscode.lm.registerTool(aspireResourceDebugToolName, new AspireResourceDebugLanguageModelTool(service)));
        extensionLogOutputChannel.info('Registered Aspire resource debug language model tool.');
    }

    return {
        get registered() {
            return registrations.length > 0;
        },
        dispose() {
            registrations.forEach(registration => registration.dispose());
            registrations.length = 0;
        },
    };
}

function createToolResult(result: AspireResourceDebugToolResult): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_[\]()<>#+~|!&]/g, character => `\\${character}`);
}
