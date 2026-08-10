import * as assert from 'assert';
import { isSamePath, waitForNoDebugSessions, waitForNoRunningAppHost, waitForRepositoryIdle, waitForWorkspaceAppHost } from './helpers/assertions';
import { clearBreakpoints, executeE2eControlCommand, getAppHostPidFromState, getNodeAppBreakpointLine, isProcessAlive, runE2eTeardown, stopPrimaryAppHostIfRunning, waitForProcessExit } from './helpers/fixtures';
import { getNodeAppScriptPath, getPrimaryAppHostProjectPath } from './helpers/paths';
import { openAspireView } from './helpers/vscode';
import { readReportedPidFromDebugOutput } from '../testing/resourceDebugOutput';

interface ResourceDebugSessionSnapshot {
    id: string;
    type: string;
    name: string;
    parentSessionId?: string;
    parentSessionType?: string;
    configuration: Record<string, unknown>;
}

interface DebugAdapterMessageSummary {
    sessionId: string;
    sessionType: string;
    sessionName: string;
    command?: string;
}

interface ResourceDebugProof {
    proof: string;
    appHostPath: string;
    resourceName: string;
    breakpoint: { sourcePath: string; line: number; text?: string };
    appHostDebugSession?: ResourceDebugSessionSnapshot;
    resourceDebugSession?: ResourceDebugSessionSnapshot;
    debugSessions: ResourceDebugSessionSnapshot[];
    matchingStackFrame?: { source?: { path?: string }; line?: number; name?: string };
    topStackFrame?: { source?: { path?: string }; line?: number; name?: string };
    processEvents: Array<{ sessionId: string; sessionType: string; systemProcessId?: number; name?: string; startMethod?: string }>;
    continueRequests: DebugAdapterMessageSummary[];
    outputHead: Array<{ sessionId: string; sessionType: string; output: string }>;
    outputSample: Array<{ sessionId: string; sessionType: string; output: string }>;
}

const nodeResourceName = 'e2e-node';
const proofTimeoutMs = 300000;

suite('Aspire resource debugger E2E', function () {
    this.timeout(600000);

    teardown(async () => {
        await runE2eTeardown([
            () => executeE2eControlCommand({ name: 'stopDebugging' }),
            () => clearBreakpoints(),
            () => stopPrimaryAppHostIfRunning(),
            () => waitForNoDebugSessions().catch(() => undefined),
            () => waitForNoRunningAppHost().catch(() => undefined),
        ], 'Resource debugger E2E teardown failed.');
    });

    test('stops on a breakpoint inside the Node resource and reports a matching stack frame', async () => {
        const proof = await getSharedResourceDebugProof();
        const scriptPath = getNodeAppScriptPath();

        assert.strictEqual(proof.proof, 'aspire-resource-debug-breakpoint-hit');
        assert.strictEqual(proof.resourceName, nodeResourceName);
        assert.ok(isSamePath(proof.breakpoint.sourcePath, scriptPath), `Expected the breakpoint to be set in ${scriptPath}, got ${proof.breakpoint.sourcePath}.`);
        assert.strictEqual(proof.breakpoint.line, getNodeAppBreakpointLine() + 1);

        const matchingFrame = proof.matchingStackFrame;
        assert.ok(matchingFrame, `Expected a stack frame in ${scriptPath}: ${JSON.stringify(proof.topStackFrame)}`);
        assert.ok(matchingFrame.source?.path && isSamePath(matchingFrame.source.path, scriptPath), `Expected the stopped frame to come from ${scriptPath}, got ${matchingFrame.source?.path}.`);
        assert.strictEqual(matchingFrame.line, getNodeAppBreakpointLine() + 1);
    });

    test('debugs the Node resource in a session distinct from the AppHost or Aspire session', async () => {
        const proof = await getSharedResourceDebugProof();

        const appHostSession = proof.appHostDebugSession;
        const resourceSession = proof.resourceDebugSession;
        assert.ok(resourceSession, `Expected the stopped resource debug session: ${JSON.stringify(proof.debugSessions.map(toSessionSummary))}`);

        assert.strictEqual(resourceSession.type, 'pwa-node');
        if (appHostSession) {
            assert.strictEqual(appHostSession.type, 'coreclr');
            assert.strictEqual(appHostSession.configuration.isApphost, true);
            assert.notStrictEqual(resourceSession.id, appHostSession.id);
            assert.ok(isSamePath(String(appHostSession.configuration.program ?? ''), getPrimaryAppHostProjectPath()));
        }
        else {
            // Some CI runs use the .NET fallback launch path, which runs the AppHost under the
            // synthetic Aspire session without a separate coreclr child session. The invariant this
            // test owns is still that the resource debugger is not the Aspire session that launched
            // it; a dedicated AppHost child session is asserted when the launch path creates one.
            const aspireSession = proof.debugSessions.find(session => session.type === 'aspire');
            assert.ok(aspireSession, `Expected an Aspire launcher session: ${JSON.stringify(proof.debugSessions.map(toSessionSummary))}`);
            assert.notStrictEqual(resourceSession.id, aspireSession.id);
        }
    });

    test('stopping debugging tears down the Node resource process tree', async () => {
        const proof = await runResourceDebugProof({ stopDebuggingOnCompletion: false });

        assert.ok(proof.resourceDebugSession, `Expected the stopped resource debug session: ${JSON.stringify(proof.debugSessions.map(toSessionSummary))}`);
        assert.deepStrictEqual(
            proof.continueRequests.filter(request => request.sessionId === proof.resourceDebugSession!.id),
            [],
            'Expected the resource debug session to remain suspended until this test starts the stop.');

        // The debuggee reports its own pid and the pid of the child it spawns, so the assertion covers
        // the process tree rather than only the process js-debug launched. The pids come from the
        // resource's own captured output because js-debug does not send the optional DAP `process`
        // event when it runs inside VS Code: it only sends `process` from its standalone DAP server
        // entry points, and even there it carries no `systemProcessId`.
        // See https://github.com/microsoft/vscode-js-debug/blob/main/src/vsDebugServer.ts
        const debuggeePid = readReportedPidFromDebugOutput(proof, 'ASPIRE_E2E_NODE_PID');
        const childPid = readReportedPidFromDebugOutput(proof, 'ASPIRE_E2E_NODE_CHILD_PID');
        assert.ok(isProcessAlive(debuggeePid), `Expected the Node resource process ${debuggeePid} to still be running before debugging stops.`);
        assert.ok(isProcessAlive(childPid), `Expected the Node child process ${childPid} to still be running before debugging stops.`);

        // Captured while the AppHost is still running so the teardown assertion below can check the
        // real process rather than the extension's view of it.
        const appHostPid = getAppHostPidFromState(proof.appHostPath);
        assert.ok(appHostPid !== undefined, 'Expected the extension state to report an AppHost pid while the AppHost is running.');

        // Only the start of the stop is awaited here. This test is about the debuggee's process tree,
        // and waiting for the whole Aspire stop to settle would fold AppHost shutdown timing into the
        // assertion. The suite teardown still performs and awaits the full stop.
        // Cleanup for a failure before this point is handled by that teardown; a local finally here
        // would replace the assertion error with the teardown error and hide why the test failed.
        await executeE2eControlCommand({ name: 'stopDebugging' }, { waitFor: 'started' });

        await Promise.all([
            waitForProcessExit(debuggeePid, 'the debugged Node resource process', 120000),
            waitForProcessExit(childPid, 'the Node resource child process', 120000),
        ]);

        await waitForNoDebugSessions();

        // The stop is still in flight in the extension host: the AppHost's own graceful shutdown after
        // an IDE debug session can outlast the extension's internal wait, and the E2E control channel
        // applies one command at a time, so the teardown's commands would queue behind it. Stopping the
        // AppHost through the CLI does not use the control channel, so it lets that wait settle.
        await stopPrimaryAppHostIfRunning();

        // Assert on the AppHost process rather than on `waitForNoRunningAppHost`. The state file's
        // AppHost list is a mirror that lags a stop and can still name a dead pid long afterwards
        // (documented in `waitForNoRunningAppHostPathOrStopKnownProcess`, and why the teardown above
        // tolerates that wait failing). Process liveness is the stronger claim and the one this test
        // is actually making: stopping the debugger must leave no part of the tree running.
        await waitForProcessExit(appHostPid, 'the AppHost process', 120000);
    });
});

let sharedResourceDebugProof: Promise<ResourceDebugProof> | undefined;

/**
 * Runs the debug proof once for the assertions that only read its payload.
 *
 * Each proof launches the AppHost and starts the resource under the debugger, so repeating it per
 * assertion would double the shard's runtime and its exposure to startup flakiness for no extra
 * coverage. The teardown between tests does not invalidate the captured payload.
 */
async function getSharedResourceDebugProof(): Promise<ResourceDebugProof> {
    sharedResourceDebugProof ??= runResourceDebugProof({ stopDebuggingOnCompletion: true });

    return await sharedResourceDebugProof;
}

async function runResourceDebugProof(options: { stopDebuggingOnCompletion: boolean }): Promise<ResourceDebugProof> {
    await openAspireView();
    await waitForRepositoryIdle();
    const discovered = await waitForWorkspaceAppHost();
    const appHostPath = discovered.state.workspaceAppHostPath ?? getPrimaryAppHostProjectPath();

    const status = await executeE2eControlCommand({
        name: 'proveResourceDebugging',
        appHostPath,
        resourceName: nodeResourceName,
        sourcePath: getNodeAppScriptPath(),
        breakpointLine: getNodeAppBreakpointLine(),
        timeoutMs: proofTimeoutMs,
        expectedResourceDebugSessionType: 'pwa-node',
        stopDebuggingOnCompletion: options.stopDebuggingOnCompletion,
    }, { timeoutMs: proofTimeoutMs + 60000 });

    const proof = status.result as ResourceDebugProof | undefined;
    assert.ok(proof, `The resource debug proof returned no result: ${JSON.stringify(status)}`);

    return proof;
}

function toSessionSummary(session: ResourceDebugSessionSnapshot): { id: string; type: string; name: string } {
    return { id: session.id, type: session.type, name: session.name };
}
