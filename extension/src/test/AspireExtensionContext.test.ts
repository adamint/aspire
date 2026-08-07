// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import { AspireExtensionContext } from '../AspireExtensionContext';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { extensionLogOutputChannel } from '../utils/logging';

suite('AspireExtensionContext', () => {
    test('deactivation waits for every CLI stop request before disposing transport', async () => {
        const order: string[] = [];
        const context = createContext(order);
        const firstStop = createDeferred<void>();
        const secondStop = createDeferred<void>();
        addSession(context, 'first', () => {
            order.push('stop first');
            return firstStop.promise;
        }, () => order.push('dispose first'));
        addSession(context, 'second', () => {
            order.push('stop second');
            return secondStop.promise;
        }, () => order.push('dispose second'));

        const shutdown = deactivateContext(context);
        await Promise.resolve();

        assert.deepStrictEqual(order, ['stop first', 'stop second']);

        firstStop.resolve();
        await Promise.resolve();
        assert.deepStrictEqual(order, ['stop first', 'stop second']);

        secondStop.resolve();
        await shutdown;

        assert.deepStrictEqual(order, [
            'stop first',
            'stop second',
            'dispose first',
            'dispose second',
            'rpc server',
            'dcp server',
            'terminal provider',
            'editor command provider',
        ]);
    });

    test('deactivation timeout falls back to synchronous session and terminal teardown', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const order: string[] = [];
        const context = createContext(order);
        addSession(context, 'session', () => {
            order.push('stop session');
            return new Promise<void>(() => { });
        }, () => order.push('dispose session'));

        try {
            const shutdown = deactivateContext(context);
            await Promise.resolve();

            assert.deepStrictEqual(order, ['stop session']);

            await clock.tickAsync(5_000);
            await shutdown;

            assert.deepStrictEqual(order, [
                'stop session',
                'dispose session',
                'rpc server',
                'dcp server',
                'terminal provider',
                'editor command provider',
            ]);
        }
        finally {
            clock.restore();
        }
    });

    test('dispose does not race an in-flight deactivation and repeated shutdown is idempotent', async () => {
        const order: string[] = [];
        const context = createContext(order);
        const stop = createDeferred<void>();
        let stopCalls = 0;
        addSession(context, 'session', () => {
            stopCalls++;
            order.push('stop session');
            return stop.promise;
        }, () => order.push('dispose session'));

        const firstShutdown = deactivateContext(context);
        const secondShutdown = deactivateContext(context);
        await Promise.resolve();
        context.dispose();

        assert.deepStrictEqual(order, ['stop session']);
        assert.strictEqual(stopCalls, 1);

        stop.resolve();
        await Promise.all([firstShutdown, secondShutdown]);
        context.dispose();
        await deactivateContext(context);

        assert.strictEqual(stopCalls, 1);
        assert.deepStrictEqual(order, [
            'stop session',
            'dispose session',
            'rpc server',
            'dcp server',
            'terminal provider',
            'editor command provider',
        ]);
    });

    test('deactivation warns and absorbs CLI stop errors after completing teardown', async () => {
        const order: string[] = [];
        const context = createContext(order);
        const expectedError = new Error('stop failed');
        const warnStub = sinon.stub(extensionLogOutputChannel, 'warn');
        addSession(context, 'session', async () => {
            order.push('stop session');
            throw expectedError;
        }, () => order.push('dispose session'));

        try {
            await deactivateContext(context);

            sinon.assert.calledWithMatch(warnStub, 'Failed to stop Aspire CLI during extension deactivation: Error: stop failed');
            assert.deepStrictEqual(order, [
                'stop session',
                'dispose session',
                'rpc server',
                'dcp server',
                'terminal provider',
                'editor command provider',
            ]);
        }
        finally {
            warnStub.restore();
        }
    });

    test('deactivation logs and absorbs PendingResponseRejected after the RPC transport closes', async () => {
        const order: string[] = [];
        const context = createContext(order);
        const infoStub = sinon.stub(extensionLogOutputChannel, 'info');
        const warnStub = sinon.stub(extensionLogOutputChannel, 'warn');
        addSession(context, 'session', async () => {
            order.push('stop session');
            throw new ResponseError(ErrorCodes.PendingResponseRejected, 'Pending response rejected since connection got disposed');
        }, () => order.push('dispose session'));

        try {
            await deactivateContext(context);

            sinon.assert.calledWithMatch(infoStub, 'Aspire CLI stop request ended after the RPC transport closed:');
            assert.strictEqual(warnStub.calledWithMatch('Failed to stop Aspire CLI during extension deactivation:'), false);
            assert.deepStrictEqual(order, [
                'stop session',
                'dispose session',
                'rpc server',
                'dcp server',
                'terminal provider',
                'editor command provider',
            ]);
        }
        finally {
            infoStub.restore();
            warnStub.restore();
        }
    });
});

function createContext(order: string[]): AspireExtensionContext {
    const context = new AspireExtensionContext();
    context.initialize(
        { dispose: () => order.push('rpc server') } as any,
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        { dispose: () => { } } as any,
        { dispose: () => order.push('dcp server') } as any,
        { dispose: () => order.push('terminal provider') } as any,
        { dispose: () => order.push('editor command provider') } as any);
    return context;
}

function addSession(context: AspireExtensionContext, debugSessionId: string, stopCli: () => Promise<void>, dispose: () => void): void {
    context.addAspireDebugSession({
        debugSessionId,
        onDidChangeState: () => ({ dispose: () => { } }),
        onDidSendDebugConsoleOutput: () => ({ dispose: () => { } }),
        requestCliStopForExtensionShutdown: stopCli,
        dispose,
    } as unknown as AspireDebugSession);
}

function deactivateContext(context: AspireExtensionContext): Promise<void> {
    const deactivate = (context as AspireExtensionContext & { deactivate?: () => Promise<void> }).deactivate;
    if (deactivate) {
        return deactivate.call(context);
    }

    context.dispose();
    return Promise.resolve();
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(promiseResolve => {
        resolve = promiseResolve;
    });

    return { promise, resolve };
}
