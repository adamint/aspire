/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { AspireExtensionContext } from '../AspireExtensionContext';
import type { AspireDebugSession } from '../debugger/AspireDebugSession';
import type { AspireDebugConfigurationProvider } from '../debugger/AspireDebugConfigurationProvider';
import type AspireDcpServer from '../dcp/AspireDcpServer';
import type { AspireEditorCommandProvider } from '../editor/AspireEditorCommandProvider';
import type AspireRpcServer from '../server/AspireRpcServer';
import type { AspireTerminalProvider } from '../utils/AspireTerminalProvider';

suite('AspireExtensionContext', () => {
    test('waits for debug sessions before disposing shared infrastructure', async () => {
        const operations: string[] = [];
        let completeStop: (() => void) | undefined;
        const stopCompletion = new Promise<void>(resolve => completeStop = resolve);
        const context = new AspireExtensionContext();
        const stateEmitter = new vscode.EventEmitter<void>();
        const outputEmitter = new vscode.EventEmitter<{ output: string; category?: string }>();
        const debugSession = {
            debugSessionId: 'session',
            onDidChangeState: stateEmitter.event,
            onDidSendDebugConsoleOutput: outputEmitter.event,
            stopDebugging: async () => {
                operations.push('session-stop-started');
                await stopCompletion;
                operations.push('session-stop-completed');
                context.removeAspireDebugSession(debugSession);
            },
        } as unknown as AspireDebugSession;
        const disposable = (name: string) => ({
            dispose: () => {
                operations.push(name);
            },
        });

        context.initialize(
            disposable('rpc-disposed') as unknown as AspireRpcServer,
            {} as vscode.ExtensionContext,
            {} as AspireDebugConfigurationProvider,
            disposable('dcp-disposed') as unknown as AspireDcpServer,
            disposable('terminal-disposed') as unknown as AspireTerminalProvider,
            disposable('editor-disposed') as unknown as AspireEditorCommandProvider);
        context.addAspireDebugSession(debugSession);

        const disposing = context.dispose();
        await Promise.resolve();

        assert.deepStrictEqual(operations, ['session-stop-started']);

        completeStop?.();
        await disposing;

        assert.deepStrictEqual(operations, [
            'session-stop-started',
            'session-stop-completed',
            'rpc-disposed',
            'dcp-disposed',
            'terminal-disposed',
            'editor-disposed',
        ]);
    });
});
