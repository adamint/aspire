import type { AspireExtensionE2EControlCommand } from '../../types/extensionApi';
import { executeE2eControlCommand } from './fixtures';
import { acceptModalDialog, type AcceptedModalDialog } from './vscode';

export interface PreparedLanguageModelToolInvocation {
    invocationMessage?: string;
    confirmationTitle?: string;
    confirmationMessage?: string;
}

export interface LanguageModelToolInvocationOptions {
    expectedConfirmations?: number;
    confirmationButtonTitle?: string;
    screenshotName?: string;
    timeoutMs?: number;
    times?: number;
    cancelAfterMs?: number;
}

export interface LanguageModelToolInvocation<T> {
    results: T[];
    dialogs: AcceptedModalDialog[];
    cancelled: boolean;
}

export async function prepareLanguageModelToolInvocation(
    toolName: string,
    input: Record<string, unknown>,
    timeoutMs = 120000,
): Promise<PreparedLanguageModelToolInvocation> {
    return await invokeControlCommand<PreparedLanguageModelToolInvocation>({
        name: 'prepareLanguageModelToolInvocation',
        toolName,
        input,
    }, timeoutMs);
}

/**
 * Drives any registered language-model tool through VS Code's public invocation API.
 * Invocation begins before confirmation is accepted because `vscode.lm.invokeTool` waits
 * for the modal. The state bridge stores only the tool's bounded text result.
 */
export async function invokeLanguageModelTool<T>(
    toolName: string,
    input: Record<string, unknown>,
    options: LanguageModelToolInvocationOptions = {},
): Promise<LanguageModelToolInvocation<T>> {
    const expectedConfirmations = options.expectedConfirmations ?? 1;
    const invocation = invokeControlCommand<{ results: string[]; cancelled?: boolean }>({
        name: 'invokeLanguageModelTool',
        toolName,
        input,
        times: options.times,
        cancelAfterMs: options.cancelAfterMs,
    }, options.timeoutMs ?? 120000);
    invocation.catch(() => undefined);

    const dialogs: AcceptedModalDialog[] = [];
    for (let index = 0; index < expectedConfirmations; index++) {
        dialogs.push(await acceptModalDialog(
            options.confirmationButtonTitle ?? 'Yes',
            180000,
            index === 0 ? options.screenshotName : undefined));
    }

    const result = await invocation;
    return {
        results: result.results.map(item => JSON.parse(item) as T),
        dialogs,
        cancelled: result.cancelled === true,
    };
}

async function invokeControlCommand<T>(
    command: AspireExtensionE2EControlCommand,
    timeoutMs: number,
): Promise<T> {
    const status = await executeE2eControlCommand(command, { timeoutMs });
    if (status.errorMessage) {
        throw new Error(`E2E control command '${command.name}' failed: ${status.errorMessage}`);
    }

    return status.result as T;
}
