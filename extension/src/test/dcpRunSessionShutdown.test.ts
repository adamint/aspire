import * as assert from 'assert';
import * as https from 'https';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import AspireDcpServer from '../dcp/AspireDcpServer';
import * as debuggerExtensions from '../debugger/debuggerExtensions';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import * as telemetry from '../utils/telemetry';
import { DcpServerConnectionInfo, ErrorResponse } from '../dcp/types';

type RunSessionResponse = { statusCode: number; body: ErrorResponse | undefined };

function putRunSession(connectionInfo: DcpServerConnectionInfo, dcpId: string): Promise<RunSessionResponse> {
    const [host, port] = connectionInfo.address.split(':');
    const payload = JSON.stringify({
        launch_configurations: [{ type: 'node', mode: 'NoDebug', project_path: '/workspace/app' }],
        env: [],
        args: [],
    });

    return new Promise<RunSessionResponse>((resolve, reject) => {
        const request = https.request({
            host,
            port: Number(port),
            path: '/run_session',
            method: 'PUT',
            // The DCP server presents a self-signed certificate it generates at startup, so the
            // default CA chain cannot validate it.
            rejectUnauthorized: false,
            headers: {
                'authorization': `Bearer ${connectionInfo.token}`,
                'microsoft-developer-dcp-instance-id': dcpId,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
        }, response => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { raw += chunk; });
            response.on('end', () => resolve({
                statusCode: response.statusCode ?? 0,
                body: raw ? JSON.parse(raw) as ErrorResponse : undefined,
            }));
        });

        request.on('error', reject);
        request.end(payload);
    });
}

suite('DCP run_session shutdown tests', () => {
    let dcpServer: AspireDcpServer | undefined;

    teardown(() => {
        dcpServer?.dispose();
        dcpServer = undefined;
        sinon.restore();
    });

    // A run that is accepted before the stop begins but only finishes preparing afterwards is a
    // cancellation, not a launch failure. Reporting it as DebugSessionFailed/500 tells DCP the
    // resource is broken and records debugger_did_not_start telemetry for a perfectly healthy run
    // the user simply stopped.
    test('a run cancelled because the session started shutting down is reported as a refusal, not a failure', async () => {
        const parentDebugSession = {
            id: 'aspire-extension-run-abc123',
            type: 'aspire',
            name: 'Aspire',
            workspaceFolder: undefined,
            configuration: {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire',
                program: '/workspace/apphost.cs',
                command: 'run',
            },
            customRequest: sinon.stub(),
            getDebugProtocolBreakpoint: sinon.stub(),
        };
        const terminalProvider = { isCliDebugLoggingEnabled: () => false, isDebugConfigEnvironmentLoggingEnabled: () => false };
        sinon.stub(vscode.debug, 'stopDebugging').callsFake(async () => { });
        const showErrorMessage = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const telemetryEvent = sinon.stub(telemetry, 'sendTelemetryEvent');
        const telemetryErrorEvent = sinon.stub(telemetry, 'sendTelemetryErrorEvent');
        const aspireDebugSession = new AspireDebugSession(parentDebugSession as unknown as vscode.DebugSession, {} as any, {} as any, terminalProvider as any, () => { });

        sinon.stub(debuggerExtensions, 'getResourceDebuggerExtensions').returns([
            { resourceType: 'node', extensionId: 'test.node', displayName: 'Node' } as any,
        ]);

        // Hold the preparation open so the stop can begin while the run is still in flight - the
        // exact interleaving the production DCP handler has to classify.
        let releasePreparation: (() => void) | undefined;
        const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
        let preparationStarted: (() => void) | undefined;
        const preparationReached = new Promise<void>(resolve => { preparationStarted = resolve; });
        sinon.stub(debuggerExtensions, 'prepareDebugSession').callsFake(async () => {
            preparationStarted!();
            await preparationGate;

            return {
                debugConfiguration: { type: 'node', request: 'launch', name: 'resource', runId: 'run-1', debugSessionId: null } as any,
                alreadyStartedSession: undefined,
            } as any;
        });

        dcpServer = await AspireDcpServer.create(id => id === parentDebugSession.id ? aspireDebugSession : null);

        const responsePromise = putRunSession(dcpServer.connectionInfo, `${parentDebugSession.id}-1`);
        await preparationReached;

        const stopPromise = aspireDebugSession.stopDebugging();
        stopPromise.catch(() => { });
        releasePreparation!();

        const response = await responsePromise;
        await stopPromise;

        assert.strictEqual(response.statusCode, 409, 'A run cancelled by the shutdown must not be reported as a server-side launch failure');
        assert.strictEqual(response.body?.error.code, 'DebugSessionStopping');
        assert.strictEqual(
            showErrorMessage.called,
            false,
            'Refusing a run because the user stopped the session must not raise a user-facing error');

        // A cancelled run must be reported on the ordinary telemetry channel with the `canceled`
        // bucket. Routing it through the error channel marks the whole AppHost session as having
        // ended with an error just because the user pressed stop.
        const endEvents = telemetryEvent.getCalls().filter(call => call.args[0] === 'aspire/vscode/debug/runsession/end');
        const endErrorEvents = telemetryErrorEvent.getCalls().filter(call => call.args[0] === 'aspire/vscode/debug/runsession/end');

        assert.strictEqual(endErrorEvents.length, 0, 'A run cancelled by the shutdown must not be reported as a telemetry error');
        assert.strictEqual(endEvents.length, 1, 'A run cancelled by the shutdown must still be paired with an end event');
        assert.strictEqual((endEvents[0].args[1] as Record<string, string>).exit_code_bucket, 'canceled');
        assert.strictEqual((endEvents[0].args[1] as Record<string, string>).end_reason, 'debug_session_stopping');
    });
});
