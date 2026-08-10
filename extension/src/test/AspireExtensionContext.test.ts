import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireExtensionContext } from '../AspireExtensionContext';
import { AspireDebugSession } from '../debugger/AspireDebugSession';

suite('AspireExtensionContext', () => {
    teardown(() => {
        sinon.restore();
    });

    test('dispose waits for debug sessions before shared transport teardown', async () => {
        const order: string[] = [];
        const context = new AspireExtensionContext();
        context.initialize(
            { dispose: () => order.push('rpc server') } as any,
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            { dispose: () => { } } as any,
            { dispose: () => order.push('dcp server') } as any,
            { dispose: () => order.push('terminal provider') } as any,
            { dispose: () => order.push('editor command provider') } as any);
        const sessionDisposal = createDeferred<void>();
        context.addAspireDebugSession({
            debugSessionId: 'aspire-session',
            onDidChangeState: () => ({ dispose: () => order.push('state subscription') }),
            onDidSendDebugConsoleOutput: () => ({ dispose: () => order.push('output subscription') }),
            dispose: () => {
                order.push('debug session dispose started');
                return sessionDisposal.promise.then(() => order.push('debug session dispose finished'));
            },
        } as unknown as AspireDebugSession);

        const disposing = context.dispose();
        await Promise.resolve();

        // Resource-first debug-session disposal can be asynchronous. Shared transports must remain
        // alive until that work finishes, otherwise extension deactivation can return before the
        // AppHost/CLI shutdown disposables run.
        assert.deepStrictEqual(order, ['debug session dispose started']);

        sessionDisposal.resolve(undefined);
        await disposing;

        assert.deepStrictEqual(order, [
            'debug session dispose started',
            'debug session dispose finished',
            'rpc server',
            'dcp server',
            'state subscription',
            'output subscription',
            'terminal provider',
            'editor command provider',
        ]);
    });

    test('dispose continues shared transport teardown when debug session disposal does not settle', async () => {
        const timeoutMs = (AspireExtensionContext as any)._debugSessionDisposalTimeoutMs;
        (AspireExtensionContext as any)._debugSessionDisposalTimeoutMs = 0;
        const order: string[] = [];
        const context = new AspireExtensionContext();
        context.initialize(
            { dispose: () => order.push('rpc server') } as any,
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            { dispose: () => { } } as any,
            { dispose: () => order.push('dcp server') } as any,
            { dispose: () => order.push('terminal provider') } as any,
            { dispose: () => order.push('editor command provider') } as any);
        context.addAspireDebugSession({
            debugSessionId: 'aspire-session',
            onDidChangeState: () => ({ dispose: () => order.push('state subscription') }),
            onDidSendDebugConsoleOutput: () => ({ dispose: () => order.push('output subscription') }),
            dispose: () => {
                order.push('debug session dispose started');
                return new Promise<void>(() => { });
            },
        } as unknown as AspireDebugSession);

        try {
            await context.dispose();

            // Deactivation should prefer bounded cleanup over waiting forever on VS Code's
            // external stopDebugging Thenable. Shared services are torn down after the bounded
            // session-disposal grace period so VS Code can finish unloading the extension.
            assert.deepStrictEqual(order, [
                'debug session dispose started',
                'rpc server',
                'dcp server',
                'state subscription',
                'output subscription',
                'terminal provider',
                'editor command provider',
            ]);
        }
        finally {
            (AspireExtensionContext as any)._debugSessionDisposalTimeoutMs = timeoutMs;
        }
    });
});

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(promiseResolve => {
        resolve = promiseResolve;
    });

    return { promise, resolve };
}
