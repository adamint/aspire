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

    test('waits for debug sessions added after context disposal begins before disposing shared infrastructure', async () => {
        const operations: string[] = [];
        const context = new AspireExtensionContext();
        const stateEmitter = new vscode.EventEmitter<void>();
        const outputEmitter = new vscode.EventEmitter<{ output: string; category?: string }>();
        let completeInitialStop: (() => void) | undefined;
        const initialStopCompletion = new Promise<void>(resolve => completeInitialStop = resolve);
        let observeInitialStopCompleted: (() => void) | undefined;
        const initialStopCompleted = new Promise<void>(resolve => observeInitialStopCompleted = resolve);
        let completeLateStop: (() => void) | undefined;
        const lateStopCompletion = new Promise<void>(resolve => completeLateStop = resolve);
        let observeLateStopCompleted: (() => void) | undefined;
        const lateStopCompleted = new Promise<void>(resolve => observeLateStopCompleted = resolve);
        let lateStopPromise: Promise<void> | undefined;
        let lateStopCalls = 0;
        const stopLateSession = () => {
            lateStopCalls++;
            lateStopPromise ??= (async () => {
                operations.push('late-session-stop-started');
                await lateStopCompletion;
                operations.push('late-session-stop-completed');
                context.removeAspireDebugSession(lateDebugSession);
                observeLateStopCompleted?.();
            })();
            return lateStopPromise;
        };
        const lateDebugSession = {
            debugSessionId: 'late-session',
            onDidChangeState: stateEmitter.event,
            onDidSendDebugConsoleOutput: outputEmitter.event,
            stopDebugging: stopLateSession,
            dispose: () => {
                void stopLateSession();
            },
        } as unknown as AspireDebugSession;
        const debugSession = {
            debugSessionId: 'session',
            onDidChangeState: stateEmitter.event,
            onDidSendDebugConsoleOutput: outputEmitter.event,
            stopDebugging: async () => {
                operations.push('session-stop-started');
                // Add synchronously from the first stop so this reaches addAspireDebugSession()
                // before dispose() has received the Promise returned by disposeCore().
                context.addAspireDebugSession(lateDebugSession);
                await initialStopCompletion;
                operations.push('session-stop-completed');
                context.removeAspireDebugSession(debugSession);
                observeInitialStopCompleted?.();
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

        assert.deepStrictEqual(operations, [
            'session-stop-started',
            'late-session-stop-started',
        ]);
        assert.deepStrictEqual(context.aspireDebugSessions, [debugSession]);

        completeInitialStop?.();
        await initialStopCompleted;
        await Promise.resolve();
        await Promise.resolve();
        const infrastructureDisposedBeforeLateStop = operations.includes('rpc-disposed');

        completeLateStop?.();
        await Promise.all([disposing, lateStopCompleted]);

        assert.strictEqual(infrastructureDisposedBeforeLateStop, false);
        assert.strictEqual(lateStopCalls, 1);
        assert.deepStrictEqual(context.aspireDebugSessions, []);
        assert.deepStrictEqual(operations, [
            'session-stop-started',
            'late-session-stop-started',
            'session-stop-completed',
            'late-session-stop-completed',
            'rpc-disposed',
            'dcp-disposed',
            'terminal-disposed',
            'editor-disposed',
        ]);
    });
});
