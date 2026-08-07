import * as assert from 'assert';
import type { TelemetryReporter } from '@vscode/extension-telemetry';
import { once } from 'events';
import type { IncomingHttpHeaders } from 'http';
import * as https from 'https';
import * as sinon from 'sinon';
import WebSocket from 'ws';
import type { AspireDebugSession } from '../debugger/AspireDebugSession';
import AspireDcpServer from '../dcp/AspireDcpServer';
import type { AspireResourceDebugSession, NodeLaunchConfiguration, ProcessRestartedNotification, RunSessionNotification, RunSessionPayload, ServiceLogsNotification, SessionTerminatedNotification } from '../dcp/types';
import { __setReporterForTests } from '../utils/telemetry';

interface RecordedTelemetryEvent {
    isError?: boolean;
    measurements?: Record<string, number>;
    name: string;
    properties?: Record<string, string>;
}

class FakeTelemetryReporter {
    public readonly events: RecordedTelemetryEvent[] = [];
    public readonly telemetryLevel = 'all';

    sendDangerousTelemetryEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name, properties, measurements });
    }

    sendDangerousTelemetryErrorEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name, properties, measurements, isError: true });
    }

    sendDangerousTelemetryException(error: Error, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name: error.name, properties, measurements, isError: true });
    }
}

interface DcpServerInternals {
    _runTelemetryById: Map<string, unknown>;
    _runsBySession: Map<string, unknown>;
    pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]>;
    server: https.Server;
    wsBySession: Map<string, WebSocket>;
}

interface Harness {
    dcpId: string;
    dcpSessionId: string;
    dcpServer: AspireDcpServer;
    disposed: boolean;
    queuedStopSessions: sinon.SinonStub[];
    sockets: WebSocket[];
    startAndGetDebugSession: sinon.SinonStub;
    stopSession: sinon.SinonStub;
}

interface WireNotification {
    notification_type: string;
    session_id: string;
    [key: string]: unknown;
}

interface NotificationClient {
    notifications: WireNotification[];
    socket: WebSocket;
    waitForNotification(predicate?: (notification: WireNotification) => boolean): Promise<WireNotification>;
}

interface HttpResponse {
    body: string;
    statusCode: number | undefined;
    headers: IncomingHttpHeaders;
}

suite('Aspire DCP server', () => {
    let harness: Harness;
    let telemetryReporter: FakeTelemetryReporter;
    let restoreTelemetry: () => void;

    setup(async () => {
        telemetryReporter = new FakeTelemetryReporter();
        restoreTelemetry = __setReporterForTests(telemetryReporter as unknown as TelemetryReporter);
        harness = await startHarness();
    });

    teardown(async () => {
        sinon.restore();
        await stopHarness(harness);
        restoreTelemetry();
    });

    test('reconnect drains queued notifications in order and excludes post-terminal events', async () => {
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const adapterNotificationHandler = harness.dcpServer.createRunSessionNotificationHandler(runId);
        assert.ok(adapterNotificationHandler);
        await closeNotificationClient(harness, client);

        const restarted: ProcessRestartedNotification = {
            notification_type: 'processRestarted',
            session_id: runId,
            dcp_id: harness.dcpId,
            pid: 42,
        };
        const log: ServiceLogsNotification = {
            notification_type: 'serviceLogs',
            session_id: runId,
            dcp_id: harness.dcpId,
            is_std_err: false,
            log_message: 'before termination',
        };
        const terminated: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: harness.dcpId,
            exit_code: 5,
        };
        const lateLog: ServiceLogsNotification = {
            ...log,
            log_message: 'after termination',
        };
        adapterNotificationHandler(restarted);
        adapterNotificationHandler(log);
        adapterNotificationHandler(terminated);
        adapterNotificationHandler(lateLog);

        assert.deepStrictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.get(harness.dcpId), [
            restarted,
            log,
            terminated,
        ]);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);

        const reconnectedClient = await openNotificationClient(harness);
        await drainNotifications(reconnectedClient);

        assert.deepStrictEqual(reconnectedClient.notifications, [
            {
                notification_type: 'processRestarted',
                session_id: runId,
                pid: 42,
            },
            {
                notification_type: 'serviceLogs',
                session_id: runId,
                is_std_err: false,
                log_message: 'before termination',
            },
            {
                notification_type: 'sessionTerminated',
                session_id: runId,
                exit_code: 5,
            },
        ]);
        assert.strictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.has(harness.dcpId), false);
    });

    test('closing a replaced WebSocket keeps the replacement registered', async () => {
        const firstClient = await openNotificationClient(harness);
        const firstServerSocket = getInternals(harness.dcpServer).wsBySession.get(harness.dcpId);
        assert.ok(firstServerSocket);
        const replacementClient = await openNotificationClient(harness);
        const replacementServerSocket = getInternals(harness.dcpServer).wsBySession.get(harness.dcpId);
        assert.ok(replacementServerSocket);
        assert.notStrictEqual(replacementServerSocket, firstServerSocket);

        const firstClientClosed = once(firstClient.socket, 'close');
        const firstServerClosed = once(firstServerSocket, 'close');
        firstClient.socket.terminate();
        await Promise.all([firstClientClosed, firstServerClosed]);

        assert.strictEqual(getInternals(harness.dcpServer).wsBySession.get(harness.dcpId) === replacementServerSocket, true);

        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const deleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const notification = await replacementClient.waitForNotification();

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
    });

    test('DELETE during startup prevents a late debug session from reviving the run', async () => {
        await stopHarness(harness);
        harness = await startHarness({ requestedStopTelemetryTimeoutMs: 25 });
        const startupCompleted = createDeferred<AspireResourceDebugSession>();
        harness.startAndGetDebugSession.returns(startupCompleted.promise);
        const client = await openNotificationClient(harness);

        const createPromise = createRunSession(harness);
        await waitFor(() => getInternals(harness.dcpServer)._runsBySession.size === 1);
        const [runId] = getInternals(harness.dcpServer)._runsBySession.keys();

        const deleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const notification = await client.waitForNotification();

        startupCompleted.resolve({
            id: 'late-resource-debug-session',
            session: {} as AspireResourceDebugSession['session'],
            stopSession: harness.stopSession,
        });
        const createResponse = await createPromise;
        await delay(100);

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
        assert.strictEqual(createResponse.statusCode, 409);
        assert.strictEqual(harness.stopSession.calledOnce, true);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.has(runId), false);
    });

    test('startup failure after DELETE does not send a second terminal notification', async () => {
        const startupCompleted = createDeferred<AspireResourceDebugSession>();
        harness.startAndGetDebugSession.returns(startupCompleted.promise);
        const client = await openNotificationClient(harness);

        const createPromise = createRunSession(harness);
        await waitFor(() => getInternals(harness.dcpServer)._runsBySession.size === 1);
        const [runId] = getInternals(harness.dcpServer)._runsBySession.keys();

        const deleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const notification = await client.waitForNotification();
        startupCompleted.reject(new Error('startup failed after stop'));
        const createResponse = await createPromise;
        await drainNotifications(client);

        assert.deepStrictEqual(client.notifications, [notification]);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.strictEqual(createResponse.statusCode, 409);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);
    });

    test('DELETE waits for stop completion before notifying DCP and responding', async () => {
        const stopStarted = createDeferred<void>();
        const stopCompleted = createDeferred<void>();
        const stopCompletedObserved = sinon.spy();
        harness.stopSession.callsFake(() => {
            stopStarted.resolve();
            return stopCompleted.promise.then(() => {
                stopCompletedObserved();
            });
        });
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const sendNotificationSpy = sinon.spy(AspireDcpServer, 'sendNotificationCore');
        const responseObserved = sinon.spy();
        let responseReceived = false;

        const deletePromise = request(harness, 'DELETE', `/run_session/${runId}`).then(response => {
            responseReceived = true;
            responseObserved();
            return response;
        });
        await stopStarted.promise;

        assert.strictEqual(sendNotificationSpy.called, false);
        assert.strictEqual(responseReceived, false);

        stopCompleted.resolve();
        const [deleteResponse, notification] = await Promise.all([
            deletePromise,
            client.waitForNotification(),
        ]);

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
        assert.strictEqual(sendNotificationSpy.calledOnce, true);
        assert.strictEqual(stopCompletedObserved.calledBefore(sendNotificationSpy), true);
        assert.strictEqual(sendNotificationSpy.calledBefore(responseObserved), true);
    });

    test('DELETE completes within a bound while a debugger stop remains pending', async () => {
        await stopHarness(harness);
        harness = await startHarness({ stopRequestTimeoutMs: 25 });
        const stopStarted = createDeferred<void>();
        const stopCompleted = createDeferred<void>();
        const stopCompletedObserved = sinon.spy();
        harness.stopSession.callsFake(() => {
            stopStarted.resolve();
            return stopCompleted.promise.then(() => {
                stopCompletedObserved();
            });
        });
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);

        const deletePromise = request(harness, 'DELETE', `/run_session/${runId}`);
        await stopStarted.promise;
        const boundedResponse = await Promise.race([
            deletePromise,
            delay(250).then(() => undefined),
        ]);

        if (!boundedResponse) {
            stopCompleted.resolve();
            await deletePromise;
            await client.waitForNotification();
        }

        assert.ok(boundedResponse, 'DELETE did not complete within the configured stop bound');
        const notification = await client.waitForNotification();
        assert.strictEqual(boundedResponse.statusCode, 200);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
        assert.strictEqual(stopCompletedObserved.called, false);

        stopCompleted.resolve();
        await waitFor(() => stopCompletedObserved.called);
        await drainNotifications(client);

        assert.deepStrictEqual(client.notifications, [notification]);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);
    });

    test('DELETE retries a stop attempt that previously timed out', async () => {
        await stopHarness(harness);
        harness = await startHarness({ stopRequestTimeoutMs: 25 });
        const firstStop = createDeferred<void>();
        harness.stopSession.onFirstCall().returns(firstStop.promise);
        harness.stopSession.onSecondCall().resolves();
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);

        const firstDeleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const notification = await client.waitForNotification();
        const retryResponse = await request(harness, 'DELETE', `/run_session/${runId}`);

        assert.strictEqual(firstDeleteResponse.statusCode, 200);
        assert.strictEqual(retryResponse.statusCode, 200);
        assert.strictEqual(harness.stopSession.callCount, 2);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);

        firstStop.reject(new Error('stale stop failure'));
        await drainNotifications(client);

        assert.deepStrictEqual(client.notifications, [notification]);
    });

    test('DELETE returns an error and allows retry when stop fails', async () => {
        harness.stopSession.onFirstCall().rejects(new Error('stop failed'));
        harness.stopSession.onSecondCall().resolves();
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const sendNotificationSpy = sinon.spy(AspireDcpServer, 'sendNotificationCore');

        const failedResponse = await request(harness, 'DELETE', `/run_session/${runId}`);

        assert.strictEqual(failedResponse.statusCode, 500);
        assert.deepStrictEqual(JSON.parse(failedResponse.body), {
            error: {
                code: 'DebugSessionStopFailed',
                message: `Failed to stop debug session for run ID ${runId}: stop failed`,
                details: [],
            },
        });
        assert.strictEqual(sendNotificationSpy.called, false);

        const retryResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const notification = await client.waitForNotification();

        assert.strictEqual(retryResponse.statusCode, 200);
        assert.strictEqual(harness.stopSession.callCount, 2);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
    });

    test('DELETE rejects a DCP instance that does not own the run', async () => {
        const intruderDcpId = 'aspire-extension-run-test-intruder';
        const ownerClient = await openNotificationClient(harness);
        const intruderClient = await openNotificationClient(harness, intruderDcpId);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);

        const intruderResponse = await request(harness, 'DELETE', `/run_session/${runId}`, undefined, intruderDcpId);

        assert.strictEqual(intruderResponse.statusCode, 403);
        assert.deepStrictEqual(JSON.parse(intruderResponse.body), {
            error: {
                code: 'RunSessionOwnerMismatch',
                message: `Run session ${runId} is owned by a different DCP instance.`,
                details: [],
            },
        });
        assert.strictEqual(harness.stopSession.called, false);
        await Promise.all([drainNotifications(ownerClient), drainNotifications(intruderClient)]);
        assert.deepStrictEqual(ownerClient.notifications, []);
        assert.deepStrictEqual(intruderClient.notifications, []);

        const ownerResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const ownerNotification = await ownerClient.waitForNotification();

        assert.strictEqual(ownerResponse.statusCode, 200);
        assert.strictEqual(harness.stopSession.calledOnce, true);
        assert.deepStrictEqual(ownerNotification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
        await drainNotifications(intruderClient);
        assert.deepStrictEqual(intruderClient.notifications, []);
    });

    test('requested stop omits exit code while late adapter exit still records its telemetry', async () => {
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const adapterNotificationHandler = harness.dcpServer.createRunSessionNotificationHandler(runId);
        assert.ok(adapterNotificationHandler);

        const deleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const requestedStopNotification = await client.waitForNotification();

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(requestedStopNotification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
        });
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.has(runId), true);

        const lateAdapterNotification: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: harness.dcpId,
            exit_code: 17,
        };
        adapterNotificationHandler(lateAdapterNotification);
        adapterNotificationHandler(lateAdapterNotification);
        await drainNotifications(client);

        assert.deepStrictEqual(client.notifications, [requestedStopNotification]);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.has(runId), false);
        const runSessionEndEvents = telemetryReporter.events.filter(event => event.name === 'aspire/vscode/debug/runsession/end');
        assert.deepStrictEqual(runSessionEndEvents, [{
            name: 'aspire/vscode/debug/runsession/end',
            properties: {
                resource_type: 'node',
                mode: 'Debug',
                exit_code_bucket: 'nonzero',
            },
            measurements: {
                duration_ms: runSessionEndEvents[0]?.measurements?.duration_ms,
                exit_code: 17,
            },
            isError: true,
        }]);
        assert.strictEqual(harness.dcpServer.takeDebugSessionAggregateStats('aspire-extension-run-test')?.anyNonZeroExit, true);
    });

    test('requested stop emits one canceled telemetry fallback when the adapter never completes', async () => {
        await stopHarness(harness);
        harness = await startHarness({ requestedStopTelemetryTimeoutMs: 25 });
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const adapterNotificationHandler = harness.dcpServer.createRunSessionNotificationHandler(runId);
        assert.ok(adapterNotificationHandler);

        const deleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);
        const notification = await client.waitForNotification();
        await delay(100);

        const runSessionEndEvents = telemetryReporter.events.filter(event => event.name === 'aspire/vscode/debug/runsession/end');
        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(runSessionEndEvents, [{
            name: 'aspire/vscode/debug/runsession/end',
            properties: {
                resource_type: 'node',
                mode: 'Debug',
                exit_code_bucket: 'canceled',
            },
            measurements: {
                duration_ms: runSessionEndEvents[0]?.measurements?.duration_ms,
                exit_code: -1,
            },
        }]);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.has(runId), false);

        const lateAdapterNotification: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: harness.dcpId,
            exit_code: 17,
        };
        adapterNotificationHandler(lateAdapterNotification);
        adapterNotificationHandler(lateAdapterNotification);
        await drainNotifications(client);

        assert.deepStrictEqual(client.notifications, [notification]);
        assert.strictEqual(telemetryReporter.events.filter(event => event.name === 'aspire/vscode/debug/runsession/end').length, 1);
    });

    test('adapter exit wins the stop race with its actual exit code', async () => {
        const stopStarted = createDeferred<void>();
        const stopCompleted = createDeferred<void>();
        harness.stopSession.callsFake(() => {
            stopStarted.resolve();
            return stopCompleted.promise;
        });
        const intruderClient = await openNotificationClient(harness, 'aspire-extension-run-test-intruder');
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const adapterNotificationHandler = harness.dcpServer.createRunSessionNotificationHandler(runId);
        assert.ok(adapterNotificationHandler);
        let responseReceived = false;

        const deletePromise = request(harness, 'DELETE', `/run_session/${runId}`).then(response => {
            responseReceived = true;
            return response;
        });
        await stopStarted.promise;

        const adapterNotification: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: 'aspire-extension-run-test-intruder',
            exit_code: 23,
        };
        adapterNotificationHandler(adapterNotification);
        const notification = await client.waitForNotification();

        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
            exit_code: 23,
        });
        assert.strictEqual(responseReceived, false);

        stopCompleted.resolve();
        const deleteResponse = await deletePromise;
        adapterNotificationHandler(adapterNotification);
        await Promise.all([drainNotifications(client), drainNotifications(intruderClient)]);

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(client.notifications, [notification]);
        assert.deepStrictEqual(intruderClient.notifications, []);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.has(runId), false);
        const runSessionEndEvents = telemetryReporter.events.filter(event => event.name === 'aspire/vscode/debug/runsession/end');
        assert.strictEqual(runSessionEndEvents.length, 1);
        assert.strictEqual(runSessionEndEvents[0].measurements?.exit_code, 23);
        assert.strictEqual(runSessionEndEvents[0].isError, true);
    });

    test('adapter exit keeps DELETE successful when the stop later rejects', async () => {
        const stopStarted = createDeferred<void>();
        const stopCompleted = createDeferred<void>();
        harness.stopSession.callsFake(() => {
            stopStarted.resolve();
            return stopCompleted.promise;
        });
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const adapterNotificationHandler = harness.dcpServer.createRunSessionNotificationHandler(runId);
        assert.ok(adapterNotificationHandler);

        const deletePromise = request(harness, 'DELETE', `/run_session/${runId}`);
        await stopStarted.promise;

        const adapterNotification: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: harness.dcpId,
            exit_code: 23,
        };
        adapterNotificationHandler(adapterNotification);
        const notification = await client.waitForNotification();
        stopCompleted.reject(new Error('stop rejected after adapter exit'));
        const deleteResponse = await deletePromise;
        await drainNotifications(client);

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.deepStrictEqual(client.notifications, [notification]);
        assert.deepStrictEqual(notification, {
            notification_type: 'sessionTerminated',
            session_id: runId,
            exit_code: 23,
        });
    });

    test('terminal state and cleanup are isolated across concurrent runs', async () => {
        const firstStopSession = sinon.stub().resolves();
        const secondStopSession = sinon.stub().resolves();
        const client = await openNotificationClient(harness);
        const firstCreateResponse = await createRunSession(harness, firstStopSession);
        const secondCreateResponse = await createRunSession(harness, secondStopSession);
        const firstLocation = firstCreateResponse.headers.location;
        const secondLocation = secondCreateResponse.headers.location;
        assert.ok(firstLocation);
        assert.ok(secondLocation);
        const firstRunId = firstLocation.substring(firstLocation.lastIndexOf('/') + 1);
        const secondRunId = secondLocation.substring(secondLocation.lastIndexOf('/') + 1);
        const firstHandler = harness.dcpServer.createRunSessionNotificationHandler(firstRunId);
        const secondHandler = harness.dcpServer.createRunSessionNotificationHandler(secondRunId);
        assert.ok(firstHandler);
        assert.ok(secondHandler);

        const firstDeleteResponse = await request(harness, 'DELETE', `/run_session/${firstRunId}`);
        await client.waitForNotification(notification => notification.session_id === firstRunId);

        const lateFirstLog: ServiceLogsNotification = {
            notification_type: 'serviceLogs',
            session_id: firstRunId,
            dcp_id: harness.dcpId,
            is_std_err: false,
            log_message: 'late first log',
        };
        const secondLog: ServiceLogsNotification = {
            notification_type: 'serviceLogs',
            session_id: secondRunId,
            dcp_id: harness.dcpId,
            is_std_err: false,
            log_message: 'second run log',
        };
        const secondTerminated: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: secondRunId,
            dcp_id: harness.dcpId,
            exit_code: 0,
        };
        const firstTerminated: SessionTerminatedNotification = {
            ...secondTerminated,
            session_id: firstRunId,
        };
        firstHandler(lateFirstLog);
        firstHandler(firstTerminated);
        secondHandler(secondLog);
        secondHandler(secondTerminated);
        await drainNotifications(client);

        assert.strictEqual(firstDeleteResponse.statusCode, 200);
        assert.strictEqual(firstStopSession.calledOnce, true);
        assert.strictEqual(secondStopSession.called, false);
        assert.deepStrictEqual(client.notifications, [
            {
                notification_type: 'sessionTerminated',
                session_id: firstRunId,
            },
            {
                notification_type: 'serviceLogs',
                session_id: secondRunId,
                is_std_err: false,
                log_message: 'second run log',
            },
            {
                notification_type: 'sessionTerminated',
                session_id: secondRunId,
                exit_code: 0,
            },
        ]);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.size, 0);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.size, 0);

        const completedRunDeleteResponse = await request(harness, 'DELETE', `/run_session/${secondRunId}`);
        assert.strictEqual(completedRunDeleteResponse.statusCode, 204);
    });

    test('dispose clears run state and prevents captured callbacks from refilling queues', async () => {
        const client = await openNotificationClient(harness);
        const createResponse = await createRunSession(harness);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);
        const adapterNotificationHandler = harness.dcpServer.createRunSessionNotificationHandler(runId);
        assert.ok(adapterNotificationHandler);
        await closeNotificationClient(harness, client);

        const log: ServiceLogsNotification = {
            notification_type: 'serviceLogs',
            session_id: runId,
            dcp_id: harness.dcpId,
            is_std_err: false,
            log_message: 'queued before dispose',
        };
        adapterNotificationHandler(log);
        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.size, 1);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.size, 1);
        assert.strictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.size, 1);

        const server = getInternals(harness.dcpServer).server;
        const serverClosed = once(server, 'close');
        harness.dcpServer.dispose();
        harness.disposed = true;
        await serverClosed;

        adapterNotificationHandler(log);
        const terminated: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: harness.dcpId,
            exit_code: 9,
        };
        adapterNotificationHandler(terminated);

        assert.strictEqual(getInternals(harness.dcpServer)._runsBySession.size, 0);
        assert.strictEqual(getInternals(harness.dcpServer)._runTelemetryById.size, 0);
        assert.strictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.size, 0);
        assert.strictEqual(getInternals(harness.dcpServer).wsBySession.size, 0);
    });
});

async function startHarness(options?: { stopRequestTimeoutMs?: number; requestedStopTelemetryTimeoutMs?: number }): Promise<Harness> {
    const dcpSessionId = 'aspire-extension-run-test';
    const dcpId = `${dcpSessionId}-resource`;
    const stopSession = sinon.stub().resolves();
    const queuedStopSessions: sinon.SinonStub[] = [];
    const startAndGetDebugSession = sinon.stub().callsFake(() => {
        const resourceStopSession = queuedStopSessions.shift() ?? stopSession;
        const resourceDebugSession: AspireResourceDebugSession = {
            id: `resource-debug-session-${resourceStopSession.callCount}`,
            session: {} as AspireResourceDebugSession['session'],
            stopSession: resourceStopSession,
        };

        return Promise.resolve(resourceDebugSession);
    });
    const debugSession = {
        configuration: {},
        startAndGetDebugSession,
    } as unknown as AspireDebugSession;
    const createDcpServer = AspireDcpServer.create as unknown as (
        getDebugSession: (debugSessionId: string) => AspireDebugSession | null,
        hooks: Record<string, never>,
        options?: { stopRequestTimeoutMs?: number; requestedStopTelemetryTimeoutMs?: number },
    ) => Promise<AspireDcpServer>;
    const dcpServer = await createDcpServer(debugSessionId => debugSessionId === dcpSessionId ? debugSession : null, {}, options);

    return {
        dcpId,
        dcpSessionId,
        dcpServer,
        disposed: false,
        queuedStopSessions,
        sockets: [],
        startAndGetDebugSession,
        stopSession,
    };
}

async function stopHarness(harness: Harness): Promise<void> {
    const socketsClosed = harness.sockets
        .filter(socket => socket.readyState !== WebSocket.CLOSED)
        .map(socket => {
            const closed = once(socket, 'close');
            socket.terminate();
            return closed;
        });

    const server = getInternals(harness.dcpServer).server;
    const closed = server.listening ? once(server, 'close') : Promise.resolve();
    if (!harness.disposed) {
        harness.dcpServer.dispose();
    }
    await Promise.all([closed, ...socketsClosed]);
}

async function createRunSession(harness: Harness, stopSession?: sinon.SinonStub): Promise<HttpResponse> {
    const launchConfiguration: NodeLaunchConfiguration = {
        type: 'node',
        mode: 'Debug',
        script_path: __filename,
        working_directory: __dirname,
    };
    const payload: RunSessionPayload = {
        launch_configurations: [launchConfiguration],
    };
    if (stopSession) {
        harness.queuedStopSessions.push(stopSession);
    }

    return await request(harness, 'PUT', '/run_session', payload);
}

async function openNotificationClient(harness: Harness, dcpId = harness.dcpId): Promise<NotificationClient> {
    const notifications: WireNotification[] = [];
    const waiters: {
        predicate: (notification: WireNotification) => boolean;
        resolve: (notification: WireNotification) => void;
    }[] = [];
    const socket = new WebSocket(`wss://${harness.dcpServer.connectionInfo.address}/run_session/notify`, {
        rejectUnauthorized: false,
        headers: getHeaders(harness, dcpId),
    });
    harness.sockets.push(socket);
    socket.on('message', data => {
        for (const line of data.toString().split('\n').filter(Boolean)) {
            const notification = JSON.parse(line) as WireNotification;
            notifications.push(notification);
            const waiterIndex = waiters.findIndex(waiter => waiter.predicate(notification));
            if (waiterIndex >= 0) {
                waiters.splice(waiterIndex, 1)[0].resolve(notification);
            }
        }
    });
    await once(socket, 'open');

    return {
        notifications,
        socket,
        waitForNotification: (predicate = () => true) => {
            const notification = notifications.find(predicate);
            return notification
                ? Promise.resolve(notification)
                : new Promise(resolve => waiters.push({ predicate, resolve }));
        },
    };
}

async function closeNotificationClient(harness: Harness, client: NotificationClient, dcpId = harness.dcpId): Promise<void> {
    if (client.socket.readyState === WebSocket.CLOSED) {
        return;
    }

    const clientClosed = once(client.socket, 'close');
    const serverSocket = getInternals(harness.dcpServer).wsBySession.get(dcpId);
    const serverClosed = serverSocket ? once(serverSocket, 'close') : Promise.resolve();
    client.socket.terminate();
    await Promise.all([clientClosed, serverClosed]);
}

async function drainNotifications(client: NotificationClient): Promise<void> {
    const pong = once(client.socket, 'pong');
    client.socket.ping();
    await pong;
}

async function request(harness: Harness, method: string, path: string, body?: unknown, dcpId = harness.dcpId): Promise<HttpResponse> {
    const [host, port] = harness.dcpServer.connectionInfo.address.split(':');
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return await new Promise((resolve, reject) => {
        const request = https.request({
            host,
            port: Number(port),
            path,
            method,
            rejectUnauthorized: false,
            headers: {
                ...getHeaders(harness, dcpId),
                ...(payload === undefined ? {} : {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                }),
            },
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => resolve({
                body: Buffer.concat(chunks).toString(),
                statusCode: response.statusCode,
                headers: response.headers,
            }));
        });
        request.on('error', reject);
        if (payload !== undefined) {
            request.write(payload);
        }
        request.end();
    });
}

function getHeaders(harness: Harness, dcpId = harness.dcpId): Record<string, string> {
    return {
        Authorization: `Bearer ${harness.dcpServer.connectionInfo.token}`,
        'Microsoft-Developer-DCP-Instance-ID': dcpId,
    };
}

function getInternals(dcpServer: AspireDcpServer): DcpServerInternals {
    return dcpServer as unknown as DcpServerInternals;
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
}
