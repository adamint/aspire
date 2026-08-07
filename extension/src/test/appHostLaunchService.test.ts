import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireExtendedDebugConfiguration } from '../dcp/types';
import { appHostLifecycleBusy } from '../loc/strings';
import { AppHostLaunchService, AppHostLifecycleLockTimeoutError, appHostLifecycleLockMaxHoldMs, appHostLifecycleLockWaitTimeoutMs } from '../services/AppHostLaunchService';
import * as cliPathModule from '../utils/cliPath';
import { __resetCommonPropertiesForTests, __setReporterForTests } from '../utils/telemetry';

interface RecordedEvent {
    name: string;
    properties?: Record<string, string>;
    measurements?: Record<string, number>;
}

class FakeTelemetryReporter {
    public events: RecordedEvent[] = [];

    public telemetryLevel: 'all' | 'error' | 'crash' | 'off' = 'all';

    sendTelemetryEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        // Extension code now bypasses this path; recording here would only
        // see a regression to the prefixed channel. Kept as a typed no-op
        // so the fake still satisfies the TelemetryReporter shape.
    }

    sendTelemetryErrorEvent(): void { /* not used here */ }

    sendDangerousTelemetryEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name, properties, measurements });
    }

    sendDangerousTelemetryErrorEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name, properties, measurements });
    }
    sendRawTelemetryEvent(): void { /* not used here */ }
    dispose(): Promise<void> { return Promise.resolve(); }
}

suite('AppHostLaunchService', () => {
    let service: AppHostLaunchService;
    let startDebuggingStub: sinon.SinonStub;
    let resolveCliPathStub: sinon.SinonStub;
    let onDidTerminateDebugSessionStub: sinon.SinonStub;
    let onDidTerminateDebugSessionCallback: ((session: vscode.DebugSession) => void) | undefined;

    setup(() => {
        onDidTerminateDebugSessionStub = sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(callback => {
            onDidTerminateDebugSessionCallback = callback;
            return new vscode.Disposable(() => { });
        });
        service = new AppHostLaunchService();
        startDebuggingStub = sinon.stub(vscode.debug, 'startDebugging').resolves(true);
        resolveCliPathStub = sinon.stub(cliPathModule, 'resolveCliPath').resolves({ cliPath: 'aspire', available: true, source: 'path' });
    });

    teardown(() => {
        service.dispose();
        startDebuggingStub.restore();
        resolveCliPathStub.restore();
        onDidTerminateDebugSessionStub.restore();
        onDidTerminateDebugSessionCallback = undefined;
    });

    test('isLaunching returns false before launch', () => {
        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
    });

    test('launch marks path as launching', async () => {
        await service.launch('/repo/AppHost.csproj', 'run', true);

        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), true);
    });

    test('launch fires onDidChangeLaunchingState event', async () => {
        let fired = false;
        service.onDidChangeLaunchingState(() => { fired = true; });

        await service.launch('/repo/AppHost.csproj', 'run', true);

        assert.strictEqual(fired, true);
    });

    test('launch starts a debug session with correct configuration', async () => {
        await service.launch('/repo/AppHost.csproj', 'run', false);

        assert.ok(startDebuggingStub.calledOnce);
        const config = startDebuggingStub.firstCall.args[1] as AspireExtendedDebugConfiguration;
        assert.strictEqual(config.type, 'aspire');
        assert.strictEqual(config.request, 'launch');
        assert.strictEqual(config.program, '/repo/AppHost.csproj');
        assert.strictEqual(config.command, 'run');
        assert.strictEqual(config.noDebug, false);
        assert.strictEqual(config.step, undefined);
        assert.strictEqual(config.skipCliAvailabilityCheck, true);
    });

    test('launch includes step when doStep is provided', async () => {
        await service.launch('/repo/AppHost.csproj', 'do', true, 'deploy');

        const config = startDebuggingStub.firstCall.args[1] as AspireExtendedDebugConfiguration;
        assert.strictEqual(config.command, 'do');
        assert.strictEqual(config.step, 'deploy');
    });

    test('launch owns CLI availability probe', async () => {
        resolveCliPathStub.resolves({ cliPath: 'aspire', available: false, source: 'not-found' });
        const showErrorMessageStub = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);

        try {
            await assert.rejects(service.launch('/repo/AppHost.csproj', 'deploy', false), vscode.CancellationError);

            assert.strictEqual(resolveCliPathStub.calledOnce, true);
            assert.strictEqual(startDebuggingStub.called, false);
        }
        finally {
            showErrorMessageStub.restore();
        }
    });

    test('clearLaunching removes the path from launching state', async () => {
        await service.launch('/repo/AppHost.csproj', 'run', true);
        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), true);

        service.clearLaunching('/repo/AppHost.csproj');

        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
    });

    test('clearLaunching fires onDidChangeLaunchingState event', async () => {
        await service.launch('/repo/AppHost.csproj', 'run', true);

        let fired = false;
        service.onDidChangeLaunchingState(() => { fired = true; });
        service.clearLaunching('/repo/AppHost.csproj');

        assert.strictEqual(fired, true);
    });

    test('clearLaunching does not fire event when path was not launching', () => {
        let fired = false;
        service.onDidChangeLaunchingState(() => { fired = true; });

        service.clearLaunching('/repo/nonexistent.csproj');

        assert.strictEqual(fired, false);
    });

    test('clearMatchingLaunching matches project paths to AppHost source files in the same directory', async () => {
        await service.launch('/repo/AppHost/AppHost.csproj', 'run', true);

        service.clearMatchingLaunching('/repo/AppHost/Program.cs');

        assert.strictEqual(service.isLaunching('/repo/AppHost/AppHost.csproj'), false);
    });

    test('isLaunching matches project paths to AppHost source files in the same directory', async () => {
        await service.launch('/repo/AppHost/Program.cs', 'run', true);

        assert.strictEqual(service.isLaunching('/repo/AppHost/AppHost.csproj'), true);
    });

    test('clearMatchingLaunching does not clear unrelated paths in the same directory', async () => {
        await service.launch('/repo/AppHost/First.csproj', 'run', true);
        await service.launch('/repo/AppHost/Second.csproj', 'run', true);

        service.clearMatchingLaunching('/repo/AppHost/Program.cs');

        assert.strictEqual(service.isLaunching('/repo/AppHost/First.csproj'), true);
        assert.strictEqual(service.isLaunching('/repo/AppHost/Second.csproj'), true);
    });

    test('multiple paths can be tracked independently', async () => {
        await service.launch('/repo/AppHost1.csproj', 'run', true);
        await service.launch('/repo/AppHost2.csproj', 'run', true);

        assert.strictEqual(service.isLaunching('/repo/AppHost1.csproj'), true);
        assert.strictEqual(service.isLaunching('/repo/AppHost2.csproj'), true);

        service.clearLaunching('/repo/AppHost1.csproj');

        assert.strictEqual(service.isLaunching('/repo/AppHost1.csproj'), false);
        assert.strictEqual(service.isLaunching('/repo/AppHost2.csproj'), true);
    });

    test('serializes editor and tool launch work for the same AppHost identity', async () => {
        let releaseFirst: (() => void) | undefined;
        let signalFirstStarted: (() => void) | undefined;
        let firstActionStarted = false;
        let secondActionStarted = false;
        const firstAction = new Promise<void>(resolve => { releaseFirst = resolve; });
        const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });

        const editorLaunch = service.runWithAppHostLifecycleLock('/repo/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token, async () => {
            firstActionStarted = true;
            signalFirstStarted?.();
            await firstAction;
            return 'editor';
        });
        const toolLaunch = service.runWithAppHostLifecycleLock('/repo/AppHost/Program.cs', new vscode.CancellationTokenSource().token, async () => {
            secondActionStarted = true;
            return 'tool';
        });
        await firstStarted;

        assert.strictEqual(firstActionStarted, true);
        assert.strictEqual(secondActionStarted, false);

        releaseFirst?.();
        assert.deepStrictEqual(await Promise.all([editorLaunch, toolLaunch]), ['editor', 'tool']);
        assert.strictEqual(secondActionStarted, true);
    });

    test('cancels a queued lifecycle operation without waiting for the active operation', async () => {
        const activeOperation = new Promise<void>(() => { });
        const active = service.runWithAppHostLifecycleLock('/repo/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token, () => activeOperation);
        const tokenSource = new vscode.CancellationTokenSource();
        const queued = service.runWithAppHostLifecycleLock('/repo/AppHost/AppHost.csproj', tokenSource.token, async () => 'queued');
        tokenSource.cancel();

        await assert.rejects(queued, vscode.CancellationError);
        assert.strictEqual(service.pendingLifecycleOperationCount, 1);
        void active;
    });

    test('bounds lifecycle lock waits when the active operation does not settle', async () => {
        const clock = sinon.useFakeTimers();
        let releaseActive: (() => void) | undefined;
        try {
            const active = service.runWithAppHostLifecycleLock(
                '/repo/AppHost/AppHost.csproj',
                new vscode.CancellationTokenSource().token,
                () => new Promise<void>(resolve => { releaseActive = resolve; }));
            await Promise.resolve();

            const queued = service.runWithAppHostLifecycleLock(
                '/repo/AppHost/Program.cs',
                new vscode.CancellationTokenSource().token,
                async () => 'queued');
            const rejection = assert.rejects(queued, AppHostLifecycleLockTimeoutError);

            await clock.tickAsync(appHostLifecycleLockWaitTimeoutMs);
            await rejection;

            releaseActive?.();
            await active;
        }
        finally {
            releaseActive?.();
            clock.restore();
        }
    });

    test('surfaces a localized message when the editor launch path times out on the lifecycle lock', async () => {
        const clock = sinon.useFakeTimers();
        let releaseActive: (() => void) | undefined;
        try {
            const active = service.runWithAppHostLifecycleLock(
                '/repo/AppHost/AppHost.csproj',
                new vscode.CancellationTokenSource().token,
                () => new Promise<void>(resolve => { releaseActive = resolve; }));
            await Promise.resolve();

            const blockedLaunch = service.launch('/repo/AppHost/AppHost.csproj', 'run', true);
            const rejection = assert.rejects(blockedLaunch, (error: unknown) => {
                assert.ok(error instanceof AppHostLifecycleLockTimeoutError);
                assert.strictEqual(error.message, appHostLifecycleBusy);
                return true;
            });

            await clock.tickAsync(appHostLifecycleLockWaitTimeoutMs);
            await rejection;

            releaseActive?.();
            await active;
        }
        finally {
            releaseActive?.();
            clock.restore();
        }
    });

    test('serializes lifecycle work across every path shape that names one AppHost', async () => {
        // The lock key must be a pure function of the path. `AppHost.csproj` matches both
        // a sibling `apphost.cs` and a sibling `Program.cs`, but those two do not match
        // each other, so a key derived by scanning existing keys would hand the third
        // caller its own lock and let two operations run against one AppHost.
        const started: string[] = [];
        let releaseFirst: (() => void) | undefined;
        let signalFirstStarted: (() => void) | undefined;
        const firstAction = new Promise<void>(resolve => { releaseFirst = resolve; });
        const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });

        const first = service.runWithAppHostLifecycleLock('/repo/AppHost/apphost.cs', new vscode.CancellationTokenSource().token, async () => {
            started.push('apphost.cs');
            signalFirstStarted?.();
            await firstAction;
            return 'apphost.cs';
        });
        await firstStarted;

        const second = service.runWithAppHostLifecycleLock('/repo/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token, async () => {
            started.push('AppHost.csproj');
            return 'AppHost.csproj';
        });
        const third = service.runWithAppHostLifecycleLock('/repo/AppHost/Program.cs', new vscode.CancellationTokenSource().token, async () => {
            started.push('Program.cs');
            return 'Program.cs';
        });

        assert.deepStrictEqual(started, ['apphost.cs']);

        releaseFirst?.();
        await Promise.all([first, second, third]);
        assert.deepStrictEqual(started, ['apphost.cs', 'AppHost.csproj', 'Program.cs']);
    });

    test('does not share a lifecycle lock between AppHosts in different directories', async () => {
        const started: string[] = [];
        const active = service.runWithAppHostLifecycleLock('/repo/First/AppHost.csproj', new vscode.CancellationTokenSource().token, async () => {
            started.push('first');
            await new Promise<void>(() => { });
        });

        await service.runWithAppHostLifecycleLock('/repo/Second/AppHost.csproj', new vscode.CancellationTokenSource().token, async () => {
            started.push('second');
        });

        assert.deepStrictEqual(started, ['first', 'second']);
        void active;
    });

    test('releases a lifecycle lock that an operation never settles so later work is not blocked forever', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const wedged = service.runWithAppHostLifecycleLock(
                '/repo/AppHost/AppHost.csproj',
                new vscode.CancellationTokenSource().token,
                () => new Promise<void>(() => { }));
            await Promise.resolve();

            // A caller already waiting still gives up on its own 10s budget.
            const queued = service.runWithAppHostLifecycleLock(
                '/repo/AppHost/AppHost.csproj',
                new vscode.CancellationTokenSource().token,
                async () => 'queued');
            const queuedRejection = assert.rejects(queued, AppHostLifecycleLockTimeoutError);
            await clock.tickAsync(appHostLifecycleLockWaitTimeoutMs);
            await queuedRejection;

            // Once the hold backstop fires, the AppHost is usable again instead of being
            // wedged for the lifetime of the window.
            await clock.tickAsync(appHostLifecycleLockMaxHoldMs);
            const recovered = service.runWithAppHostLifecycleLock(
                '/repo/AppHost/AppHost.csproj',
                new vscode.CancellationTokenSource().token,
                async () => 'recovered');
            await clock.tickAsync(appHostLifecycleLockWaitTimeoutMs);
            assert.strictEqual(await recovered, 'recovered');
            void wedged;
        }
        finally {
            clock.restore();
        }
    });

    test('matches an editor session whose program is the workspace folder through its resolved AppHost', () => {
        // `Aspire: Configure launch.json` writes `program: '${workspaceFolder}'`, so for
        // the standard configure-then-F5 flow the session path is a directory and can
        // never equal the AppHost file an agent names.
        const folderSession = {
            appHostPath: '/repo',
            resolvedAppHostPath: '/repo/AppHost/AppHost.csproj',
            operationKind: 'run' as const,
            startupCompleted: true,
            configuration: { noDebug: false },
            stopDebugging: async () => { },
        };
        service.setEditorSessionProvider(() => [folderSession]);

        assert.deepStrictEqual(service.getEditorOwnedRunSessions('/repo/AppHost/AppHost.csproj'), [folderSession]);
        assert.deepStrictEqual(service.getEditorOwnedRunSessions('/repo/AppHost/Program.cs'), [folderSession]);
        assert.deepStrictEqual(service.getEditorOwnedRunSessions('/repo/Other/AppHost.csproj'), []);
    });

    test('does not match a folder session that has no resolved AppHost', () => {
        // Without a resolved candidate the extension genuinely does not know which
        // AppHost under the folder is running, so it must not guess.
        const folderSession = {
            appHostPath: '/repo',
            resolvedAppHostPath: undefined,
            operationKind: 'run' as const,
            startupCompleted: true,
            configuration: { noDebug: false },
            stopDebugging: async () => { },
        };
        service.setEditorSessionProvider(() => [folderSession]);

        assert.deepStrictEqual(service.getEditorOwnedRunSessions('/repo/AppHost/AppHost.csproj'), []);
    });

    test('matches project and AppHost source identities without matching sibling projects', () => {
        assert.strictEqual(service.isSameAppHostIdentity('/repo/AppHost/AppHost.csproj', '/repo/AppHost/Program.cs'), true);        assert.strictEqual(service.isSameAppHostIdentity('/repo/AppHost/AppHost.csproj', '/repo/AppHost/apphost.cs'), true);
        assert.strictEqual(service.isSameAppHostIdentity('/repo/AppHost/First.csproj', '/repo/AppHost/Second.csproj'), false);
        assert.strictEqual(service.isSameAppHostIdentity('/repo/AppHost/apphost.ts', '/repo/AppHost/apphost.mts'), false);
    });

    test('returns only editor-owned run sessions for the requested AppHost identity', () => {
        const runSession = {
            appHostPath: '/repo/AppHost/Program.cs',
            operationKind: 'run' as const,
            resolvedAppHostPath: undefined,
            startupCompleted: true,
            configuration: { noDebug: false },
            stopDebugging: async () => { },
        };
        const publishSession = {
            appHostPath: '/repo/AppHost/AppHost.csproj',
            operationKind: 'publish' as const,
            resolvedAppHostPath: undefined,
            startupCompleted: true,
            configuration: { noDebug: true },
            stopDebugging: async () => { },
        };
        const testSession = {
            appHostPath: '/repo/AppHost/AppHost.csproj',
            operationKind: 'test' as const,
            resolvedAppHostPath: undefined,
            startupCompleted: true,
            configuration: { noDebug: true },
            stopDebugging: async () => { },
        };
        service.setEditorSessionProvider(() => [runSession, publishSession, testSession]);

        assert.deepStrictEqual(service.getEditorOwnedRunSessions('/repo/AppHost/AppHost.csproj'), [runSession]);
    });

    test('reads an authoritative running snapshot independent of tree visibility', async () => {
        const expected = [{ appHostPath: path.resolve('/repo/AppHost/AppHost.csproj') }];
        service.setRunningAppHostProvider(async (token: vscode.CancellationToken) => {
            assert.strictEqual(token.isCancellationRequested, false);
            return expected;
        });

        const actual = await service.getRunningAppHosts(new vscode.CancellationTokenSource().token);

        assert.deepStrictEqual(actual, expected);
    });

    test('launch clears launching state and throws when startDebugging returns false', async () => {
        // vscode.debug.startDebugging returns Promise<boolean> and resolves false when
        // the debug adapter rejects or no provider matches — no terminate event is
        // emitted in that case. Without explicit cleanup the tree item would be stuck
        // showing the "Starting..." spinner forever.
        startDebuggingStub.resolves(false);

        await assert.rejects(service.launch('/repo/AppHost.csproj', 'run', true), /did not start the Aspire run session/);

        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
    });

    test('launch reports error telemetry when startDebugging returns false', async () => {
        startDebuggingStub.resolves(false);
        const fake = new FakeTelemetryReporter();
        const restore = __setReporterForTests(fake as unknown as Parameters<typeof __setReporterForTests>[0]);
        try {
            await assert.rejects(service.launch('/repo/AppHost.csproj', 'run', true), /did not start the Aspire run session/);

            const appHostLaunchEvents = fake.events.filter(e => e.name === 'aspire/vscode/apphost/launch/result');
            assert.strictEqual(appHostLaunchEvents.length, 1);
            const event = appHostLaunchEvents[0];
            assert.strictEqual(event.name, 'aspire/vscode/apphost/launch/result');
            assert.strictEqual(event.properties?.outcome, 'error');
            assert.strictEqual(event.properties?.error_kind, 'StartDebuggingDeclined');
            assert.ok(typeof event.measurements?.duration_ms === 'number');
        }
        finally {
            restore();
            __resetCommonPropertiesForTests();
        }
    });

    test('launch cancels before starting debug session when CLI is unavailable', async () => {
        resolveCliPathStub.resolves({ cliPath: 'aspire', available: false, source: 'not-found' });
        const showErrorMessageStub = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const fake = new FakeTelemetryReporter();
        const restore = __setReporterForTests(fake as unknown as Parameters<typeof __setReporterForTests>[0]);
        try {
            await assert.rejects(service.launch('/repo/AppHost.csproj', 'run', true), vscode.CancellationError);

            assert.strictEqual(startDebuggingStub.called, false);
            assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
            const appHostLaunchEvents = fake.events.filter(e => e.name === 'aspire/vscode/apphost/launch/result');
            assert.strictEqual(appHostLaunchEvents.length, 1);
            const event = appHostLaunchEvents[0];
            assert.strictEqual(event.name, 'aspire/vscode/apphost/launch/result');
            assert.strictEqual(event.properties?.outcome, 'canceled');
            assert.strictEqual(event.properties?.error_kind, undefined);
            assert.ok(typeof event.measurements?.duration_ms === 'number');
        }
        finally {
            showErrorMessageStub.restore();
            restore();
            __resetCommonPropertiesForTests();
        }
    });

    test('launch clears launching state and rethrows when startDebugging throws', async () => {
        startDebuggingStub.rejects(new Error('boom'));

        await assert.rejects(service.launch('/repo/AppHost.csproj', 'run', true), /boom/);

        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
    });

    test('launch emits one bounded result telemetry event', async () => {
        const fake = new FakeTelemetryReporter();
        const restore = __setReporterForTests(fake as unknown as Parameters<typeof __setReporterForTests>[0]);
        try {
            await service.launch('/repo/AppHost.csproj', 'custom' as Parameters<AppHostLaunchService['launch']>[1], true);

            const appHostLaunchEvents = fake.events.filter(e => e.name === 'aspire/vscode/apphost/launch/result');
            assert.strictEqual(appHostLaunchEvents.length, 1);
            const event = appHostLaunchEvents[0];
            assert.strictEqual(event.name, 'aspire/vscode/apphost/launch/result');
            assert.strictEqual(event.properties?.command, 'other');
            assert.strictEqual(event.properties?.outcome, 'success');
            assert.strictEqual(event.properties?.mode, 'run');
            assert.strictEqual(event.properties?.apphost_language, 'csharp');
            assert.strictEqual(event.properties?.execution_suppressed, 'false');
            assert.ok(typeof event.measurements?.duration_ms === 'number');
        }
        finally {
            restore();
            __resetCommonPropertiesForTests();
        }
    });

    test('terminated run sessions include appHostPath and stop refresh semantics', () => {
        let terminationEvent: { appHostPath: string; command?: string; shouldRequestStopRefresh: boolean } | undefined;
        service.onDidTerminateAppHostDebugSession(event => {
            terminationEvent = event;
        });

        assert.ok(onDidTerminateDebugSessionCallback);
        onDidTerminateDebugSessionCallback({
            configuration: {
                type: 'aspire',
                program: '/repo/AppHost.csproj',
                command: 'run',
            },
        } as unknown as vscode.DebugSession);

        assert.deepStrictEqual(terminationEvent, {
            appHostPath: '/repo/AppHost.csproj',
            command: 'run',
            shouldRequestStopRefresh: true,
        });
    });

    test('terminated non-run sessions do not request stop refresh', () => {
        let terminationEvent: { appHostPath: string; command?: string; shouldRequestStopRefresh: boolean } | undefined;
        service.onDidTerminateAppHostDebugSession(event => {
            terminationEvent = event;
        });

        assert.ok(onDidTerminateDebugSessionCallback);
        onDidTerminateDebugSessionCallback({
            configuration: {
                type: 'aspire',
                program: '/repo/AppHost.csproj',
                command: 'publish',
            },
        } as unknown as vscode.DebugSession);

        assert.deepStrictEqual(terminationEvent, {
            appHostPath: '/repo/AppHost.csproj',
            command: 'publish',
            shouldRequestStopRefresh: false,
        });
    });

    test('terminated Aspire sessions default missing command to run and request stop refresh', () => {
        let terminationEvent: { appHostPath: string; command?: string; shouldRequestStopRefresh: boolean } | undefined;
        service.onDidTerminateAppHostDebugSession(event => {
            terminationEvent = event;
        });

        assert.ok(onDidTerminateDebugSessionCallback);
        onDidTerminateDebugSessionCallback({
            configuration: {
                type: 'aspire',
                program: '/repo/AppHost.csproj',
            },
        } as unknown as vscode.DebugSession);

        assert.deepStrictEqual(terminationEvent, {
            appHostPath: '/repo/AppHost.csproj',
            command: 'run',
            shouldRequestStopRefresh: true,
        });
    });

    test('terminated Aspire sessions drop invalid command values and do not request stop refresh', () => {
        let terminationEvent: { appHostPath: string; command?: string; shouldRequestStopRefresh: boolean } | undefined;
        service.onDidTerminateAppHostDebugSession(event => {
            terminationEvent = event;
        });

        assert.ok(onDidTerminateDebugSessionCallback);
        onDidTerminateDebugSessionCallback({
            configuration: {
                type: 'aspire',
                program: '/repo/AppHost.csproj',
                command: 'invalid',
            },
        } as unknown as vscode.DebugSession);

        assert.deepStrictEqual(terminationEvent, {
            appHostPath: '/repo/AppHost.csproj',
            command: undefined,
            shouldRequestStopRefresh: false,
        });
    });
});
