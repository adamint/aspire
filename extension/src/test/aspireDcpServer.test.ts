import * as assert from 'assert';
import * as https from 'https';
import * as sinon from 'sinon';
import WebSocket from 'ws';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import * as debuggerExtensions from '../debugger/debuggerExtensions';
import { ResourceDebuggerExtension } from '../debugger/debuggerExtensions';
import AspireDcpServer from '../dcp/AspireDcpServer';
import { AspireResourceDebugSession, AspireResourceExtendedDebugConfiguration, RunSessionPayload, ServiceLogsNotification } from '../dcp/types';

suite('Aspire DCP Server Tests', () => {
    let server: AspireDcpServer | undefined;

    teardown(() => {
        server?.dispose();
        server = undefined;
        sinon.restore();
    });

    test('keeps distinct raw DCP ids in generated resource debug configurations', async () => {
        const parentDebugSessionId = 'aspire-extension-run-parent';
        const observedDebugSessionIds: string[] = [];
        const startedConfigurations: AspireResourceExtendedDebugConfiguration[] = [];
        const debuggerExtension: ResourceDebuggerExtension = {
            resourceType: 'test-resource',
            debugAdapter: 'test-debugger',
            extensionId: null,
            getDisplayName: () => 'Test Resource',
            getProjectFile: () => '/workspace/resource',
            getSupportedFileTypes: () => [],
            createDebugSessionConfigurationCallback: async (_launchConfig, _args, _env, launchOptions) => {
                observedDebugSessionIds.push(launchOptions.debugSessionId);
            }
        };
        sinon.stub(debuggerExtensions, 'getResourceDebuggerExtensions').returns([debuggerExtension]);

        const resourceDebugSession = {
            id: 'resource-session',
            session: {},
            stopSession: async () => undefined
        } as unknown as AspireResourceDebugSession;
        const aspireDebugSession = {
            debugSessionId: parentDebugSessionId,
            configuration: {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire',
                program: '/workspace/AppHost.csproj'
            },
            startAndGetDebugSession: sinon.stub().callsFake(async (configuration: AspireResourceExtendedDebugConfiguration) => {
                startedConfigurations.push(configuration);
                return resourceDebugSession;
            })
        } as unknown as AspireDebugSession;

        server = await AspireDcpServer.create(debugSessionId =>
            debugSessionId === parentDebugSessionId ? aspireDebugSession : null);

        const payload: RunSessionPayload = {
            launch_configurations: [{ type: 'test-resource', mode: 'Debug' }],
            args: [],
            env: []
        };
        const rawDcpIds = [`${parentDebugSessionId}-resource-a`, `${parentDebugSessionId}-resource-b`];
        const statuses = await Promise.all(rawDcpIds.map(dcpId => putRunSession(server!, dcpId, payload)));

        assert.deepStrictEqual(statuses, [201, 201]);
        // Both PUTs are in flight at once, so Express may service them in either order. The invariant
        // under test is that each raw DCP id survives distinctly - not the order they arrived in - so
        // compare sorted copies rather than pinning an ordering the server never promised.
        const expectedDcpIds = [...rawDcpIds].sort();
        assert.deepStrictEqual([...observedDebugSessionIds].sort(), expectedDcpIds);
        assert.deepStrictEqual(startedConfigurations.map(configuration => configuration.debugSessionId).sort(), expectedDcpIds);
    });

    test('routes a service notification through the raw DCP id retained by the debug configuration', async () => {
        const parentDebugSessionId = 'aspire-extension-run-parent';
        const rawDcpId = `${parentDebugSessionId}-resource-a`;
        let startedConfiguration: AspireResourceExtendedDebugConfiguration | undefined;
        const debuggerExtension: ResourceDebuggerExtension = {
            resourceType: 'test-resource',
            debugAdapter: 'test-debugger',
            extensionId: null,
            getDisplayName: () => 'Test Resource',
            getProjectFile: () => '/workspace/resource',
            getSupportedFileTypes: () => []
        };
        sinon.stub(debuggerExtensions, 'getResourceDebuggerExtensions').returns([debuggerExtension]);

        const resourceDebugSession = {
            id: 'resource-session',
            session: {},
            stopSession: async () => undefined
        } as unknown as AspireResourceDebugSession;
        const aspireDebugSession = {
            debugSessionId: parentDebugSessionId,
            configuration: {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire',
                program: '/workspace/AppHost.csproj'
            },
            startAndGetDebugSession: sinon.stub().callsFake(async (configuration: AspireResourceExtendedDebugConfiguration) => {
                startedConfiguration = configuration;
                return resourceDebugSession;
            })
        } as unknown as AspireDebugSession;

        server = await AspireDcpServer.create(debugSessionId =>
            debugSessionId === parentDebugSessionId ? aspireDebugSession : null);
        const socket = await openNotificationSocket(server, rawDcpId);

        try {
            const status = await putRunSession(server, rawDcpId, {
                launch_configurations: [{ type: 'test-resource', mode: 'Debug' }],
                args: [],
                env: []
            });
            assert.strictEqual(status, 201);
            assert.ok(startedConfiguration);

            const received = waitForServiceLogs(socket);
            const notification: ServiceLogsNotification = {
                notification_type: 'serviceLogs',
                session_id: startedConfiguration.runId,
                dcp_id: startedConfiguration.debugSessionId!,
                is_std_err: false,
                log_message: 'routed'
            };
            server.sendNotification(notification);

            assert.deepStrictEqual(await received, {
                notification_type: 'serviceLogs',
                session_id: startedConfiguration.runId,
                is_std_err: false,
                log_message: 'routed'
            });
        }
        finally {
            socket.close();
        }
    });
});

async function openNotificationSocket(server: AspireDcpServer, dcpId: string): Promise<WebSocket> {
    const socket = new WebSocket(`wss://${server.connectionInfo.address}/run_session/notify`, {
        rejectUnauthorized: false,
        headers: {
            Authorization: `Bearer ${server.connectionInfo.token}`,
            'Microsoft-Developer-DCP-Instance-ID': dcpId
        }
    });

    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });

    return socket;
}

async function waitForServiceLogs(socket: WebSocket): Promise<Omit<ServiceLogsNotification, 'dcp_id'>> {
    return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for a routed serviceLogs notification.')), 5000);
        socket.on('message', data => {
            const message = JSON.parse(String(data).trim());
            if (message.notification_type === 'serviceLogs') {
                clearTimeout(timeout);
                resolve(message);
            }
        });
    });
}

async function putRunSession(server: AspireDcpServer, dcpId: string, payload: RunSessionPayload): Promise<number | undefined> {
    const [host, port] = server.connectionInfo.address.split(':');

    return await new Promise<number | undefined>((resolve, reject) => {
        const request = https.request({
            host,
            port: Number(port),
            path: '/run_session',
            method: 'PUT',
            rejectUnauthorized: false,
            headers: {
                Authorization: `Bearer ${server.connectionInfo.token}`,
                'Content-Type': 'application/json',
                'Microsoft-Developer-DCP-Instance-ID': dcpId
            }
        }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });

        request.on('error', reject);
        request.end(JSON.stringify(payload));
    });
}
