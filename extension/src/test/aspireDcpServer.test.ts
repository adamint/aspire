import * as assert from 'assert';
import * as https from 'https';
import * as sinon from 'sinon';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import * as debuggerExtensions from '../debugger/debuggerExtensions';
import { ResourceDebuggerExtension } from '../debugger/debuggerExtensions';
import AspireDcpServer from '../dcp/AspireDcpServer';
import { AspireResourceDebugSession, RunSessionPayload } from '../dcp/types';

suite('Aspire DCP Server Tests', () => {
    let server: AspireDcpServer | undefined;

    teardown(() => {
        server?.dispose();
        server = undefined;
        sinon.restore();
    });

    test('passes the parent Aspire debug session id for resources with distinct DCP ids', async () => {
        const parentDebugSessionId = 'aspire-extension-run-parent';
        const observedDebugSessionIds: string[] = [];
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
            configuration: {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire',
                program: '/workspace/AppHost.csproj'
            },
            startAndGetDebugSession: sinon.stub().resolves(resourceDebugSession)
        } as unknown as AspireDebugSession;

        server = await AspireDcpServer.create(debugSessionId =>
            debugSessionId === parentDebugSessionId ? aspireDebugSession : null);

        const payload: RunSessionPayload = {
            launch_configurations: [{ type: 'test-resource', mode: 'Debug' }],
            args: [],
            env: []
        };
        const statuses = await Promise.all([
            putRunSession(server, `${parentDebugSessionId}-resource-a`, payload),
            putRunSession(server, `${parentDebugSessionId}-resource-b`, payload)
        ]);

        assert.deepStrictEqual(statuses, [201, 201]);
        assert.deepStrictEqual(observedDebugSessionIds, [parentDebugSessionId, parentDebugSessionId]);
    });
});

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
