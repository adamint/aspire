import * as vscode from 'vscode';
import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';
import { isWorkspaceOpen } from '../utils/workspace';
import { deployApp, failedToStartDebugSession } from '../loc/strings';

export async function deployCommand(terminalProvider: AspireTerminalProvider) {
    if (!isWorkspaceOpen()) {
        return;
    }

    // Prompt whether to debug or run without debugging
    const shouldDebug = await vscode.window.showQuickPick(

    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
        type: 'aspire',
        request: 'launch',
        name: `Aspire: ${deployApp}`,
        program: '${workspaceFolder}',
        mode: 'deploy'
    });

    if (!started) {
        vscode.window.showErrorMessage(failedToStartDebugSession);
    }
}
