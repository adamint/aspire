import * as vscode from 'vscode';
import { startAndGetDebugSession } from './common';
import { extensionLogOutputChannel } from '../utils/logging';
import { attachToAppHost as attachToAppHostString } from '../loc/strings';

let appHostDebugSession: vscode.DebugSession | undefined = undefined;

export async function attachToAppHost(pid: number, sourceRoot?: string): Promise<void> {
    if (appHostDebugSession) {
        extensionLogOutputChannel.info(`Stopping existing AppHost debug session.`);
        vscode.debug.stopDebugging(appHostDebugSession);
        appHostDebugSession = undefined;
        extensionLogOutputChannel.info(`Stopped existing AppHost debug session.`);
    }

    extensionLogOutputChannel.info(`Attaching to AppHost with PID: ${pid}`);

    const config: vscode.DebugConfiguration = {
        type: 'coreclr',
        request: 'attach',
        name: attachToAppHostString,
        processId: pid.toString(),
        justMyCode: false,
        // Provide source mapping if specified
        ...(sourceRoot ? { sourceSearchPaths: [sourceRoot] } : {}),
        appHost: true
    };
    
    appHostDebugSession = await startAndGetDebugSession(config);
}