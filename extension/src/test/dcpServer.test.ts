import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { stopRunSession } from '../dcp/AspireDcpServer';
import { AspireResourceDebugSession } from '../dcp/types';

suite('Aspire DCP Server Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    test('retains a run session when stopping one of its debug sessions fails', async () => {
        const runId = 'run-1';
        const failingDebugSession = createResourceDebugSession('resource-session-1', sinon.stub().rejects(new Error('VS Code failed to stop')));
        const runSessions = [failingDebugSession];
        const runsBySession = new Map<string, AspireResourceDebugSession[]>([
            [runId, runSessions]
        ]);

        await assert.rejects(stopRunSession(runId, runsBySession), /VS Code failed to stop/);

        assert.strictEqual(runsBySession.get(runId), runSessions, 'Expected the failed run entry to stay retryable');
        assert.strictEqual(runsBySession.get(runId)?.[0], failingDebugSession);
        assert.strictEqual(failingDebugSession.stopSession.calledOnce, true);
    });

    test('removes a run session only after all debug sessions stop successfully', async () => {
        const runId = 'run-1';
        const firstDebugSession = createResourceDebugSession('resource-session-1', sinon.stub().resolves());
        const secondDebugSession = createResourceDebugSession('resource-session-2', sinon.stub().resolves());
        const runsBySession = new Map<string, AspireResourceDebugSession[]>([
            [runId, [firstDebugSession, secondDebugSession]]
        ]);

        const result = await stopRunSession(runId, runsBySession);

        assert.strictEqual(result, true);
        assert.strictEqual(runsBySession.has(runId), false);
        assert.strictEqual(firstDebugSession.stopSession.calledOnce, true);
        assert.strictEqual(secondDebugSession.stopSession.calledOnce, true);
    });

    test('times out a hung stop attempt while retaining and observing the run', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const runId = 'run-1';
        const stop = deferred<void>();
        const debugSession = createResourceDebugSession('resource-session-1', sinon.stub().returns(stop.promise));
        const runsBySession = new Map<string, AspireResourceDebugSession[]>([
            [runId, [debugSession]]
        ]);

        const result = stopRunSession(runId, runsBySession);
        const rejection = assert.rejects(result, /Timed out stopping debug session/);
        await clock.tickAsync(10_000);

        await rejection;
        assert.strictEqual(runsBySession.has(runId), true);
        assert.strictEqual(debugSession.stopSession.calledOnce, true);

        stop.resolve();
        await Promise.resolve();
        await Promise.resolve();

        assert.strictEqual(runsBySession.has(runId), false);
    });

    test('observes a stop attempt that rejects after timing out', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const runId = 'run-1';
        const stop = deferred<void>();
        const runsBySession = new Map<string, AspireResourceDebugSession[]>([
            [runId, [createResourceDebugSession('resource-session-1', sinon.stub().returns(stop.promise))]]
        ]);

        const rejection = assert.rejects(stopRunSession(runId, runsBySession), /Timed out stopping debug session/);
        await clock.tickAsync(10_000);
        await rejection;

        stop.reject(new Error('late stop failure'));
        await Promise.resolve();
        await Promise.resolve();

        assert.strictEqual(runsBySession.has(runId), true);
    });
});

type StopSessionStub = sinon.SinonStub;

function createResourceDebugSession(id: string, stopSession: StopSessionStub): AspireResourceDebugSession & { stopSession: StopSessionStub } {
    return {
        id,
        session: {
            id,
            type: 'coreclr',
            name: id,
            workspaceFolder: undefined,
            configuration: { type: 'coreclr', name: id, request: 'launch' },
            customRequest: sinon.stub(),
            getDebugProtocolBreakpoint: sinon.stub()
        } as vscode.DebugSession,
        stopSession,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return { promise, resolve, reject };
}
