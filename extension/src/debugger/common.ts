import * as vscode from 'vscode';
import { extensionLogOutputChannel } from '../utils/logging';
import { currentAspireDebugSession } from './debugAdapter';

// Track child debug sessions for Aspire
const aspireChildDebugSessions: Set<vscode.DebugSession> = new Set();

// Listen for new debug sessions and track children of Aspire session
vscode.debug.onDidStartDebugSession((session) => {
    if (currentAspireDebugSession?.session && session.parentSession && session.parentSession.id === currentAspireDebugSession.session.id) {
        aspireChildDebugSessions.add(session);
    }
});

// Listen for Aspire debug session termination and terminate all its children
vscode.debug.onDidTerminateDebugSession(async (session) => {
    // If Aspire parent session ends, terminate all its children
    if (currentAspireDebugSession?.session && session.id === currentAspireDebugSession.session.id) {
        extensionLogOutputChannel.info(`Aspire debug session terminated. Terminating ${aspireChildDebugSessions.size} child session(s).`);
        for (const child of aspireChildDebugSessions) {
            try {
                await vscode.debug.stopDebugging(child);
            } catch (e) {
                extensionLogOutputChannel.error(`Failed to terminate child debug session ${child.name}: ${e}`);
            }
        }
        aspireChildDebugSessions.clear();
    }
    // If an AppHost child session ends, also stop the Aspire parent session
    else if (aspireChildDebugSessions.has(session)) {
        aspireChildDebugSessions.delete(session);
        // Check if this session is an AppHost by config
        if (session.configuration && session.configuration.appHost && currentAspireDebugSession?.session) {
            extensionLogOutputChannel.info(`AppHost child session terminated. Stopping Aspire parent session.`);
            try {
                await vscode.debug.stopDebugging(currentAspireDebugSession.session);
            } catch (e) {
                extensionLogOutputChannel.error(`Failed to terminate Aspire parent session: ${e}`);
            }
        }
    }
});

export async function startAndGetDebugSession(debugConfig: vscode.DebugConfiguration): Promise<vscode.DebugSession | undefined> {
    return new Promise(async (resolve) => {
        const disposable = vscode.debug.onDidStartDebugSession(session => {
            if (session.name === debugConfig.name) {
                extensionLogOutputChannel.info(`Debug session started: ${session.name}`);
                disposable.dispose();
                resolve(session);
            }
        });

        extensionLogOutputChannel.info(`Starting debug session with configuration: ${JSON.stringify(debugConfig)}`);
        const started = await vscode.debug.startDebugging(undefined, debugConfig, currentAspireDebugSession?.session);
        if (!started) {
            disposable.dispose();
            resolve(undefined);
        }

        setTimeout(() => {
            disposable.dispose();
            resolve(undefined);
        }, 10000);
    });
}