import * as assert from 'assert';

import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    aspireListDebugSessionsToolName,
    aspireOpenDashboardToolName,
    aspireOpenOutputToolName,
    type EditorAssistanceToolResult,
} from '../lm/editorAssistanceToolContracts';
import {
    EditorAssistanceTelemetry,
    type EditorAssistanceTelemetryEvent,
} from '../lm/editorAssistanceTelemetry';

suite('editor assistance telemetry', () => {
    test('records bounded status fields without AppHost or resource input', async () => {
        const events: EditorAssistanceTelemetryEvent[] = [];
        const telemetry = createTelemetry([100, 137], events);
        const sentinels = [
            '/Users/private/AppHost.csproj',
            'resource-secret',
            'https://dashboard-secret.example',
            'raw-error-secret',
            'session-secret',
            '424242',
            '--credential=secret',
            'PRIVATE_ENV=secret',
            'unsafe_path_key',
        ];
        const result = {
            success: true,
            tool: aspireDebugSessionStatusToolName,
            outcome: 'running',
            scope: 'resource',
            controller: 'editor',
            mode: 'debug',
            appHost: sentinels[0],
            resourceName: sentinels[1],
            unsafe_path_key: sentinels[0],
            dashboardUrl: sentinels[2],
            rawError: sentinels[3],
            sessionId: sentinels[4],
            pid: sentinels[5],
            args: [sentinels[6]],
            env: { PRIVATE_ENV: sentinels[7] },
        } as unknown as EditorAssistanceToolResult;

        assert.strictEqual(
            await telemetry.capture(aspireDebugSessionStatusToolName, async () => result),
            result);
        assert.deepStrictEqual(events, [{
            eventName: 'aspire/vscode/editorAssistance/result',
            properties: {
                tool: aspireDebugSessionStatusToolName,
                outcome: 'running',
                source: 'languageModelTool',
                scope: 'resource',
                controller: 'editor',
                mode: 'debug',
                state_bucket: 'running',
            },
            measurements: { duration_ms: 37 },
        }]);
        assertTelemetryOmits(events, sentinels);
    });

    test('records only sanitized launch failure dimensions', async () => {
        const events: EditorAssistanceTelemetryEvent[] = [];
        const telemetry = createTelemetry([50, 58], events);
        const sentinels = [
            '/private/failure/AppHost.csproj',
            'free-text-recommendation-secret',
            'https://failure-secret.example',
            'raw-stack-secret',
            'credential-secret',
            'unsafe_recommendation_key',
        ];
        const result = {
            success: true,
            tool: aspireExplainLaunchFailureToolName,
            outcome: 'failureFound',
            appHost: sentinels[0],
            stage: 'build',
            category: 'buildFailed',
            controller: 'editor',
            mode: 'debug',
            providerKind: 'dotnet',
            exitCodeBucket: 'one',
            recommendedActions: ['fixBuildErrors'],
            unsafe_recommendation_key: sentinels[1],
            url: sentinels[2],
            error: sentinels[3],
            environment: { TOKEN: sentinels[4] },
        } as unknown as EditorAssistanceToolResult;

        await telemetry.capture(aspireExplainLaunchFailureToolName, async () => result);

        assert.deepStrictEqual(events, [{
            eventName: 'aspire/vscode/editorAssistance/result',
            properties: {
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'failureFound',
                source: 'languageModelTool',
                controller: 'editor',
                mode: 'debug',
                stage: 'build',
                category: 'buildFailed',
                provider_kind: 'dotnet',
                exit_code_bucket: 'one',
            },
            measurements: { duration_ms: 8 },
        }]);
        assertTelemetryOmits(events, sentinels);
    });

    test('records Dashboard presentation and cancellation without its URL', async () => {
        const events: EditorAssistanceTelemetryEvent[] = [];
        const telemetry = createTelemetry([10, 12, 20, 25], events);
        const dashboardUrl = 'https://dashboard-secret.example/?token=secret';

        await telemetry.capture(aspireOpenDashboardToolName, async () => ({
            success: true,
            tool: aspireOpenDashboardToolName,
            outcome: 'opened',
            presentation: 'integratedBrowser',
            dashboardUrl,
        } as unknown as EditorAssistanceToolResult));
        await telemetry.capture(aspireOpenDashboardToolName, async () => ({
            success: false,
            tool: aspireOpenDashboardToolName,
            outcome: 'canceled',
            dashboardUrl,
        } as unknown as EditorAssistanceToolResult));

        assert.deepStrictEqual(events, [
            {
                eventName: 'aspire/vscode/editorAssistance/result',
                properties: {
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    source: 'languageModelTool',
                    presentation: 'integratedBrowser',
                },
                measurements: { duration_ms: 2 },
            },
            {
                eventName: 'aspire/vscode/editorAssistance/result',
                properties: {
                    tool: aspireOpenDashboardToolName,
                    outcome: 'canceled',
                    source: 'languageModelTool',
                },
                measurements: { duration_ms: 5 },
            },
        ]);
        assertTelemetryOmits(events, [dashboardUrl]);
    });

    test('records invalid input and workspace trust rejection as bounded outcomes', async () => {
        const events: EditorAssistanceTelemetryEvent[] = [];
        const telemetry = createTelemetry([30, 31, 40, 42], events);

        await telemetry.capture(aspireDebugSessionStatusToolName, async () => ({
            success: false,
            tool: aspireDebugSessionStatusToolName,
            outcome: 'invalidInput',
        }));
        await telemetry.capture(aspireOpenOutputToolName, async () => ({
            success: false,
            tool: aspireOpenOutputToolName,
            outcome: 'workspaceNotTrusted',
        }));

        assert.deepStrictEqual(events, [
            {
                eventName: 'aspire/vscode/editorAssistance/result',
                properties: {
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'invalidInput',
                    source: 'languageModelTool',
                },
                measurements: { duration_ms: 1 },
            },
            {
                eventName: 'aspire/vscode/editorAssistance/result',
                properties: {
                    tool: aspireOpenOutputToolName,
                    outcome: 'workspaceNotTrusted',
                    source: 'languageModelTool',
                },
                measurements: { duration_ms: 2 },
            },
        ]);
    });

    test('records a bounded error when an invocation throws', async () => {
        const events: EditorAssistanceTelemetryEvent[] = [];
        const telemetry = createTelemetry([70, 73], events);
        const sentinels = [
            'raw-error-secret',
            '/private/output-secret',
            'https://output-secret.example',
            'caller-extension-id-secret',
        ];
        const error = Object.assign(new Error(sentinels[0]), {
            path: sentinels[1],
            url: sentinels[2],
            extensionId: sentinels[3],
        });

        await assert.rejects(
            telemetry.capture(aspireOpenOutputToolName, async () => { throw error; }),
            error);

        assert.deepStrictEqual(events, [{
            eventName: 'aspire/vscode/editorAssistance/result',
            properties: {
                tool: aspireOpenOutputToolName,
                outcome: 'error',
                source: 'languageModelTool',
            },
            measurements: { duration_ms: 3 },
        }]);
        assertTelemetryOmits(events, sentinels);
    });

    test('does not serialize list session summaries or aggregate counts', async () => {
        const events: EditorAssistanceTelemetryEvent[] = [];
        const telemetry = createTelemetry([90, 94], events);
        const sentinels = [
            '/private/list/AppHost.csproj',
            'session-resource-secret',
            'raw-debug-config-secret',
            '98765',
        ];

        await telemetry.capture(aspireListDebugSessionsToolName, async () => ({
            success: true,
            tool: aspireListDebugSessionsToolName,
            outcome: 'sessionsFound',
            sessions: [{
                appHost: sentinels[0],
                state: 'running',
                controller: 'editor',
                mode: 'debug',
                resources: [sentinels[1]],
                debugConfiguration: sentinels[2],
                pid: sentinels[3],
            }],
            truncated: true,
        } as unknown as EditorAssistanceToolResult));

        assert.deepStrictEqual(events, [{
            eventName: 'aspire/vscode/editorAssistance/result',
            properties: {
                tool: aspireListDebugSessionsToolName,
                outcome: 'sessionsFound',
                source: 'languageModelTool',
            },
            measurements: { duration_ms: 4 },
        }]);
        assertTelemetryOmits(events, sentinels);
    });
});

function createTelemetry(
    times: readonly number[],
    events: EditorAssistanceTelemetryEvent[]): EditorAssistanceTelemetry {
    let index = 0;
    return new EditorAssistanceTelemetry({
        clock: { now: () => times[index++] },
        sendEvent: (eventName, properties, measurements) => {
            events.push({ eventName, properties, measurements });
        },
    });
}

function assertTelemetryOmits(events: readonly EditorAssistanceTelemetryEvent[], sentinels: readonly string[]): void {
    const serialized = JSON.stringify(events);
    for (const sentinel of sentinels) {
        assert.strictEqual(
            serialized.includes(sentinel),
            false,
            `Telemetry contained unsafe sentinel '${sentinel}'. Payload: ${serialized}`);
    }
}
