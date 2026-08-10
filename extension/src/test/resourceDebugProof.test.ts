import * as assert from 'assert';
import { createDebugAdapterOutputCapture, findAppHostDebugSession, getResourceDebugProofRequest, resourceDebugProofPhaseBudgetMs } from '../testing/e2eStateFileBridge';
import type { AspireExtensionE2EControlCommand } from '../types/extensionApi';

suite('Resource debug proof request', () => {
    const appHostPath = '/workspace/AspireE2E.AppHost/AspireE2E.AppHost.csproj';
    const sourcePath = '/workspace/AspireE2E.NodeApp/app.js';

    function languageNeutralCommand(overrides: Partial<Extract<AspireExtensionE2EControlCommand, { name: 'proveResourceDebugging' }>> = {}): Extract<AspireExtensionE2EControlCommand, { name: 'proveResourceDebugging' }> {
        return {
            name: 'proveResourceDebugging',
            appHostPath,
            resourceName: 'e2e-node',
            sourcePath,
            breakpointLine: 12,
            ...overrides,
        };
    }

    test('normalizes the language-neutral command with a language-neutral proof name', () => {
        const request = getResourceDebugProofRequest(languageNeutralCommand());

        assert.strictEqual(request.proof, 'aspire-resource-debug-breakpoint-hit');
        assert.strictEqual(request.appHostPath, appHostPath);
        assert.strictEqual(request.sourcePath, sourcePath);
        assert.strictEqual(request.resourceName, 'e2e-node');
        assert.strictEqual(request.breakpointLine, 12);
        assert.strictEqual(request.timeoutMs, 300000);
        assert.strictEqual(request.pauseOnBreakpointMs, 0);
        assert.strictEqual(request.expectedResourceDebugSessionType, undefined);
        assert.strictEqual(request.stopDebuggingOnCompletion, true);
    });

    test('keeps the language-neutral proof name stable for callers that grep the payload', () => {
        // Callers assert on this exact string (see resourceDebugger.e2e.test.ts), so the constant
        // is pinned here to catch an accidental rename before the E2E shard flakes on it.
        const request = getResourceDebugProofRequest(languageNeutralCommand({
            resourceName: 'e2e-node',
            sourcePath: '/workspace/AspireE2E.NodeApp/app.js',
            breakpointLine: 4,
            timeoutMs: 120000,
            pauseOnBreakpointMs: 1500,
        }));

        assert.strictEqual(request.proof, 'aspire-resource-debug-breakpoint-hit');
        assert.strictEqual(request.resourceName, 'e2e-node');
        assert.strictEqual(request.breakpointLine, 4);
        assert.strictEqual(request.timeoutMs, 120000);
        assert.strictEqual(request.pauseOnBreakpointMs, 1500);
        assert.strictEqual(request.stopDebuggingOnCompletion, true);
    });

    test('carries the expected resource debug session type and teardown opt-out', () => {
        const request = getResourceDebugProofRequest(languageNeutralCommand({
            expectedResourceDebugSessionType: 'pwa-node',
            stopDebuggingOnCompletion: false,
        }));

        assert.strictEqual(request.expectedResourceDebugSessionType, 'pwa-node');
        assert.strictEqual(request.stopDebuggingOnCompletion, false);
    });

    test('selects the real AppHost debugger session instead of the synthetic Aspire parent', () => {
        const appHostSession = findAppHostDebugSession([
            {
                id: 'aspire-parent',
                type: 'aspire',
                name: 'Aspire',
                configuration: { program: appHostPath },
            },
            {
                id: 'apphost-child',
                type: 'coreclr',
                name: 'C#: AppHost',
                configuration: { program: appHostPath, isApphost: true },
            },
            {
                id: 'node-resource',
                type: 'pwa-node',
                name: 'Node.js: app.js',
                configuration: { program: sourcePath },
            },
        ], appHostPath);

        assert.strictEqual(appHostSession?.id, 'apphost-child');
    });

    test('falls back to the Aspire parent when the CLI launched the AppHost itself', () => {
        // The session shape the E2E shard actually produces: the CLI hands the AppHost launch to the
        // extension only when the `project` capability is advertised, which needs the C# extension,
        // and the E2E VS Code instance installs only the Aspire VSIX. No `isApphost` session exists
        // there, so requiring one makes the proof report no AppHost session at all.
        const appHostSession = findAppHostDebugSession([
            {
                id: 'aspire-parent',
                type: 'aspire',
                name: 'Aspire run: AspireE2E.AppHost/AspireE2E.AppHost.csproj',
                configuration: { program: appHostPath },
            },
            {
                id: 'node-resource',
                type: 'pwa-node',
                name: 'Debug Node.js: AspireE2E.NodeApp/app.js',
                configuration: { program: sourcePath },
            },
            {
                id: 'node-resource-child',
                type: 'pwa-node',
                name: 'app.js [5744] « Debug Node.js: AspireE2E.NodeApp/app.js',
                configuration: {},
            },
        ], appHostPath);

        assert.strictEqual(appHostSession?.id, 'aspire-parent');
    });

    test('ignores an Aspire parent session that owns a different AppHost', () => {
        const appHostSession = findAppHostDebugSession([
            {
                id: 'other-aspire-parent',
                type: 'aspire',
                name: 'Aspire',
                configuration: { program: '/workspace/Other.AppHost/Other.AppHost.csproj' },
            },
        ], appHostPath);

        assert.strictEqual(appHostSession, undefined);
    });

    test('clamps the per-phase timeout budgets to the requested timeout', () => {
        const request = getResourceDebugProofRequest(languageNeutralCommand({ timeoutMs: 60000 }));

        assert.strictEqual(request.appHostStartupTimeoutMs, 60000);
        assert.strictEqual(request.resourceStartTimeoutMs, 60000);
        assert.strictEqual(request.breakpointTimeoutMs, 60000);
    });

    test('caps each phase independently when the requested timeout is large', () => {
        const request = getResourceDebugProofRequest(languageNeutralCommand({ timeoutMs: 600000 }));

        assert.strictEqual(request.appHostStartupTimeoutMs, 180000);
        assert.strictEqual(request.resourceStartTimeoutMs, 180000);
        assert.strictEqual(request.breakpointTimeoutMs, 240000);
    });

    test('rejects a missing resource name', () => {
        assert.throws(
            () => getResourceDebugProofRequest(languageNeutralCommand({ resourceName: '' })),
            /requires resourceName/);
    });

    test('rejects a negative breakpoint line', () => {
        assert.throws(
            () => getResourceDebugProofRequest(languageNeutralCommand({ breakpointLine: -1 })),
            /zero-based non-negative integer line/);
    });

    test('rejects a non-integer timeout', () => {
        assert.throws(
            () => getResourceDebugProofRequest(languageNeutralCommand({ timeoutMs: 1.5 })),
            /timeoutMs must be a non-negative integer/);
    });

    test('rejects an unknown proof command name', () => {
        assert.throws(
            () => getResourceDebugProofRequest({ name: 'proveRustResourceDebugging' } as unknown as Extract<AspireExtensionE2EControlCommand, { name: 'proveResourceDebugging' }>),
            /Unsupported Aspire resource debug proof command/);
    });
});

suite('Resource debug proof phase budget', () => {
    const appHostPath = '/workspace/AspireE2E.AppHost/AspireE2E.AppHost.csproj';
    const sourcePath = '/workspace/AspireE2E.NodeApp/app.js';

    test('keeps the phases inside the requested timeout even at their ceilings', () => {
        const timeoutMs = 300000;
        const request = getResourceDebugProofRequest({
            name: 'proveResourceDebugging',
            appHostPath,
            resourceName: 'e2e-node',
            sourcePath,
            breakpointLine: 12,
            timeoutMs,
        });

        // The ceilings on their own sum past the request, which is the whole point of the deadline:
        // without it a proof asked for 300s could run for 600s.
        const ceilingTotal = request.appHostStartupTimeoutMs + request.resourceStartTimeoutMs + request.breakpointTimeoutMs;
        assert.ok(ceilingTotal > timeoutMs, `Expected the phase ceilings to exceed the request on their own, got ${ceilingTotal}.`);

        // Walk the phases with each one consuming everything it is granted, which is the worst case.
        const start = 1_000_000;
        const deadline = start + timeoutMs;
        let now = start;
        let granted = 0;
        for (const ceiling of [request.appHostStartupTimeoutMs, request.resourceStartTimeoutMs, request.breakpointTimeoutMs]) {
            const budget = resourceDebugProofPhaseBudgetMs(ceiling, deadline, now);
            granted += budget;
            now += budget;
        }

        assert.strictEqual(granted, timeoutMs, 'The phases together must not be granted more than the requested timeout.');
    });

    test('still caps a single phase at its own ceiling when budget remains', () => {
        const start = 1_000_000;
        assert.strictEqual(resourceDebugProofPhaseBudgetMs(180000, start + 300000, start), 180000);
    });

    test('grants nothing once the deadline has passed', () => {
        const start = 1_000_000;
        assert.strictEqual(resourceDebugProofPhaseBudgetMs(180000, start, start + 5000), 0);
    });
});

suite('Resource debug proof output capture', () => {
    test('keeps startup output head entries per debug session', () => {
        const capture = createDebugAdapterOutputCapture(2, 5);

        for (let i = 0; i < 20; i++) {
            capture.recordOutputEvent({
                sessionId: 'aspire-parent-session',
                sessionType: 'aspire',
                output: `aspire ${i}\n`,
            });
        }
        capture.recordOutputEvent({
            sessionId: 'node-resource-session',
            sessionType: 'pwa-node',
            output: 'ASPIRE_E2E_NODE_PID=12345\n',
        });
        capture.recordOutputEvent({
            sessionId: 'node-resource-session',
            sessionType: 'pwa-node',
            output: 'ASPIRE_E2E_NODE_CHILD_PID=12346\n',
        });
        capture.recordOutputEvent({
            sessionId: 'node-resource-session',
            sessionType: 'pwa-node',
            output: 'later node output\n',
        });

        assert.deepStrictEqual(
            capture.getOutputHeadEvents().filter(event => event.sessionId === 'aspire-parent-session').map(event => event.output),
            ['aspire 0\n', 'aspire 1\n']);
        assert.deepStrictEqual(
            capture.getOutputHeadEvents().filter(event => event.sessionId === 'node-resource-session').map(event => event.output),
            ['ASPIRE_E2E_NODE_PID=12345\n', 'ASPIRE_E2E_NODE_CHILD_PID=12346\n']);
        assert.strictEqual(capture.observedOutputEventCount, 23);
        assert.strictEqual(capture.getOutputSampleEvents().length, 5);
    });
});
