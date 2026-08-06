import * as assert from 'assert';
import { once } from 'events';
import type { IncomingHttpHeaders } from 'http';
import * as https from 'https';
import * as sinon from 'sinon';
import WebSocket from 'ws';
import type { AspireDebugSession } from '../debugger/AspireDebugSession';
import AspireDcpServer from '../dcp/AspireDcpServer';
import type { AspireResourceDebugSession, NodeLaunchConfiguration, RunSessionPayload, SessionTerminatedNotification } from '../dcp/types';

interface DcpServerInternals {
    pendingNotificationQueueByDcpId: Map<string, SessionTerminatedNotification[]>;
    server: https.Server;
    wsBySession: Map<string, WebSocket>;
}

interface Harness {
    dcpId: string;
    dcpServer: AspireDcpServer;
    socket?: WebSocket;
    stopSession: sinon.SinonStub;
}

suite('Aspire DCP server', () => {
    let harness: Harness;

    setup(async () => {
        harness = await startHarness();
    });

    teardown(async () => {
        sinon.restore();
        await stopHarness(harness);
    });

    test('DELETE run session sends one termination notification and preserves queued delivery', async () => {
        const launchConfiguration: NodeLaunchConfiguration = {
            type: 'node',
            mode: 'Debug',
            script_path: __filename,
            working_directory: __dirname,
        };
        const payload: RunSessionPayload = {
            launch_configurations: [launchConfiguration],
        };
        const createResponse = await request(harness, 'PUT', '/run_session', payload);
        assert.strictEqual(createResponse.statusCode, 201);
        const runLocation = createResponse.headers.location;
        assert.ok(runLocation);
        const runId = runLocation.substring(runLocation.lastIndexOf('/') + 1);

        const deleteResponse = await request(harness, 'DELETE', `/run_session/${runId}`);

        assert.strictEqual(deleteResponse.statusCode, 200);
        assert.strictEqual(harness.stopSession.calledOnce, true);
        const expectedNotification: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: runId,
            dcp_id: harness.dcpId,
            exit_code: 0,
        };
        assert.deepStrictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.get(harness.dcpId), [expectedNotification]);

        const lateAdapterNotification: SessionTerminatedNotification = {
            ...expectedNotification,
            exit_code: 17,
        };
        harness.dcpServer.sendNotification(lateAdapterNotification);
        assert.deepStrictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.get(harness.dcpId), [expectedNotification]);

        const receivedNotifications: { notification_type: string }[] = [];
        const socket = new WebSocket(`wss://${harness.dcpServer.connectionInfo.address}/run_session/notify`, {
            rejectUnauthorized: false,
            headers: getHeaders(harness),
        });
        harness.socket = socket;
        const socketOpened = once(socket, 'open');
        const notificationReceived = new Promise<SessionTerminatedNotification>((resolve, reject) => {
            socket.on('message', data => {
                for (const line of data.toString().split('\n').filter(Boolean)) {
                    const notification = JSON.parse(line) as { notification_type: string };
                    receivedNotifications.push(notification);
                    if (notification.notification_type === 'sessionTerminated') {
                        resolve(notification as SessionTerminatedNotification);
                    }
                }
            });
            socket.on('error', reject);
        });

        await socketOpened;
        assert.deepStrictEqual(await notificationReceived, {
            notification_type: 'sessionTerminated',
            session_id: runId,
            exit_code: 0,
        });
        assert.strictEqual(receivedNotifications.filter(notification => notification.notification_type === 'sessionTerminated').length, 1);
        assert.strictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.has(harness.dcpId), false);

        const serverSocket = getInternals(harness.dcpServer).wsBySession.get(harness.dcpId);
        assert.ok(serverSocket);
        const sendSpy = sinon.spy(serverSocket, 'send');

        const unknownDeleteResponse = await request(harness, 'DELETE', '/run_session/unknown');

        assert.strictEqual(unknownDeleteResponse.statusCode, 204);
        assert.strictEqual(sendSpy.called, false);
        assert.strictEqual(getInternals(harness.dcpServer).pendingNotificationQueueByDcpId.has(harness.dcpId), false);
    });
});

async function startHarness(): Promise<Harness> {
    const dcpSessionId = 'aspire-extension-run-test';
    const dcpId = `${dcpSessionId}-resource`;
    const stopSession = sinon.stub().resolves();
    const resourceDebugSession: AspireResourceDebugSession = {
        id: 'resource-debug-session',
        session: {} as AspireResourceDebugSession['session'],
        stopSession,
    };
    const debugSession = {
        configuration: {},
        startAndGetDebugSession: sinon.stub().resolves(resourceDebugSession),
    } as unknown as AspireDebugSession;
    const dcpServer = await AspireDcpServer.create(debugSessionId => debugSessionId === dcpSessionId ? debugSession : null);

    return {
        dcpId,
        dcpServer,
        stopSession,
    };
}

async function stopHarness(harness: Harness): Promise<void> {
    if (harness.socket?.readyState === WebSocket.OPEN) {
        const closed = once(harness.socket, 'close');
        harness.socket.close();
        await closed;
    } else {
        harness.socket?.terminate();
    }

    const server = getInternals(harness.dcpServer).server;
    const closed = server.listening ? once(server, 'close') : Promise.resolve();
    harness.dcpServer.dispose();
    await closed;
}

async function request(harness: Harness, method: string, path: string, body?: unknown): Promise<{
    statusCode: number | undefined;
    headers: IncomingHttpHeaders;
}> {
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
                ...getHeaders(harness),
                ...(payload === undefined ? {} : {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                }),
            },
        }, response => {
            response.resume();
            response.on('end', () => resolve({
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

function getHeaders(harness: Harness): Record<string, string> {
    return {
        Authorization: `Bearer ${harness.dcpServer.connectionInfo.token}`,
        'Microsoft-Developer-DCP-Instance-ID': harness.dcpId,
    };
}

function getInternals(dcpServer: AspireDcpServer): DcpServerInternals {
    return dcpServer as unknown as DcpServerInternals;
}
