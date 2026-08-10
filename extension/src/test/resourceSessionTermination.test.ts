import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ResourceSessionTermination } from '../debugger/resourceSessionTermination';
import { registerRunCleanup } from '../debugger/runCleanupRegistry';
import { AspireResourceExtendedDebugConfiguration } from '../dcp/types';

function createTerminationConfiguration(runId: string, terminationSignal: 'debugSessionEnd' | 'adapterExit' = 'debugSessionEnd'): AspireResourceExtendedDebugConfiguration {
    return {
        type: 'chrome',
        name: `resource-${runId}`,
        request: 'launch',
        runId,
        debugSessionId: `dcp-${runId}`,
        terminationSignal,
    } as unknown as AspireResourceExtendedDebugConfiguration;
}

suite('ResourceSessionTermination', () => {
    let onDidTerminateStub: sinon.SinonStub;
    let stopDebuggingStub: sinon.SinonStub;
    let activeListeners: Array<(session: vscode.DebugSession) => void>;

    // Models VS Code's own behavior: a disposed subscription stops receiving events. Retaining the
    // captured callback instead would let a test drive `finish()` through a listener the code under
    // test had already released, which is exactly the bug this suite has to be able to see.
    function fireTermination(session: vscode.DebugSession): void {
        for (const listener of [...activeListeners]) {
            listener(session);
        }
    }

    setup(() => {
        activeListeners = [];
        onDidTerminateStub = sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(callback => {
            activeListeners.push(callback);
            return new vscode.Disposable(() => {
                const index = activeListeners.indexOf(callback);
                if (index >= 0) {
                    activeListeners.splice(index, 1);
                }
            });
        });
    });

    teardown(() => {
        stopDebuggingStub?.restore();
        onDidTerminateStub.restore();
        activeListeners = [];
    });

    test('a session that ends while the disposal stop is in flight still reports termination', async () => {
        // Aspire session disposal stops the parent, and VS Code cascades that to this child. The
        // cascade can end the session before stopDebugging resolves, which makes VS Code reject a
        // stop for a session it has already dropped. The run genuinely ended, so it still owes DCP
        // a sessionTerminated notification and owes the browser profile directory its cleanup.
        const runId = 'run-cascade';
        const session = { id: 'session-cascade', name: 'resource' } as unknown as vscode.DebugSession;
        let rejectStop!: (error: Error) => void;
        stopDebuggingStub = sinon.stub(vscode.debug, 'stopDebugging').returns(new Promise<void>((_, reject) => { rejectStop = reject; }));

        const terminated: Array<{ runId: string; dcpId: string }> = [];
        let cleanedUp = false;
        registerRunCleanup(runId, () => { cleanedUp = true; });

        const termination = new ResourceSessionTermination(
            session,
            createTerminationConfiguration(runId),
            (id, dcpId) => terminated.push({ runId: id, dcpId }));
        termination.watchForDebugSessionEnd();

        termination.stopAndDisposeOnFailure();

        // Fired through the subscription registry, so this is a no-op if the code under test has
        // already released its listener - which is precisely the failure mode being guarded.
        fireTermination(session);

        rejectStop(new Error('debug session not found'));
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        assert.deepStrictEqual(terminated, [{ runId, dcpId: `dcp-${runId}` }]);
        assert.strictEqual(cleanedUp, true, 'A run that ended must still have its cleanup handlers run');
    });

    test('a stop that fails while the session is still alive releases the termination listener', async () => {
        // The listener must not outlive the Aspire session that was tracking the run: a genuine
        // rejection means the debuggee is still running and nothing else will ever bound it.
        const runId = 'run-live';
        const session = { id: 'session-live', name: 'resource' } as unknown as vscode.DebugSession;
        stopDebuggingStub = sinon.stub(vscode.debug, 'stopDebugging').rejects(new Error('stop refused'));

        const terminated: string[] = [];
        const termination = new ResourceSessionTermination(
            session,
            createTerminationConfiguration(runId),
            id => terminated.push(id));
        termination.watchForDebugSessionEnd();

        termination.stopAndDisposeOnFailure();
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        assert.strictEqual(activeListeners.length, 0);
        assert.deepStrictEqual(terminated, [], 'A stop that never confirmed the session ended must not claim the run terminated');
    });

    test('an adapterExit run that ends naturally runs its cleanup handlers without reporting termination twice', async () => {
        // `adapterExit` runs have their sessionTerminated notification sent by the adapter tracker's
        // onExit, which does no other bookkeeping. If this class ignored the session ending for those
        // runs, a session that ended on its own - the ordinary way an Azure Functions run finishes -
        // would never release its registered cleanup handler, leaving the `func` host process alive
        // and the run's entry in the cleanup registry leaked.
        const runId = 'run-adapter-exit';
        const session = { id: 'session-adapter-exit', name: 'resource' } as unknown as vscode.DebugSession;
        stopDebuggingStub = sinon.stub(vscode.debug, 'stopDebugging').resolves();

        const terminated: string[] = [];
        let cleanedUp = false;
        registerRunCleanup(runId, () => { cleanedUp = true; });

        const termination = new ResourceSessionTermination(
            session,
            createTerminationConfiguration(runId, 'adapterExit'),
            id => terminated.push(id));
        termination.watchForDebugSessionEnd();

        fireTermination(session);

        assert.strictEqual(cleanedUp, true, 'A run whose session ended must have its cleanup handlers run regardless of termination signal');
        assert.deepStrictEqual(terminated, [], 'The adapter tracker owns the sessionTerminated notification for adapterExit runs');
        assert.strictEqual(activeListeners.length, 0, 'The terminal transition must release the termination listener');
    });

    test('stopping an adapterExit run whose session already ended resolves without asking VS Code to stop it', async () => {
        // A DCP DELETE /run_session arriving after the session ended must not reach stopDebugging for
        // a session VS Code has already dropped: that call rejects, and the DELETE would answer 500
        // for a run that genuinely finished.
        const runId = 'run-adapter-exit-late-delete';
        const session = { id: 'session-late-delete', name: 'resource' } as unknown as vscode.DebugSession;
        stopDebuggingStub = sinon.stub(vscode.debug, 'stopDebugging').resolves();

        const termination = new ResourceSessionTermination(
            session,
            createTerminationConfiguration(runId, 'adapterExit'),
            () => { });
        termination.watchForDebugSessionEnd();

        fireTermination(session);
        await termination.stop();

        assert.strictEqual(stopDebuggingStub.callCount, 0, 'A finished run must not be stopped through VS Code again');
    });
});
