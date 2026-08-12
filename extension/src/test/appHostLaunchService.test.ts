import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireExtendedDebugConfiguration } from '../dcp/types';
import { AppHostLaunchService } from '../services/AppHostLaunchService';
import * as appHostLanguageModule from '../utils/appHostLanguage';
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
    const fixtureRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'apphost-launch-service');
    let service: AppHostLaunchService;
    let fixtureDirectories: string[];
    let startDebuggingStub: sinon.SinonStub;
    let classifyAppHostDirectoryStub: sinon.SinonStub;
    let resolveCliPathStub: sinon.SinonStub;
    let onDidTerminateDebugSessionStub: sinon.SinonStub;
    let onDidTerminateDebugSessionCallback: ((session: vscode.DebugSession) => void) | undefined;

    setup(() => {
        fixtureDirectories = [];
        fs.mkdirSync(fixtureRoot, { recursive: true });
        onDidTerminateDebugSessionStub = sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(callback => {
            onDidTerminateDebugSessionCallback = callback;
            return new vscode.Disposable(() => { });
        });
        service = new AppHostLaunchService();
        startDebuggingStub = sinon.stub(vscode.debug, 'startDebugging').resolves(true);
        classifyAppHostDirectoryStub = sinon.stub(appHostLanguageModule, 'classifyAppHostDirectory').resolves('csharp');
        resolveCliPathStub = sinon.stub(cliPathModule, 'resolveCliPath').resolves({ cliPath: 'aspire', available: true, source: 'path' });
    });

    teardown(() => {
        service.dispose();
        startDebuggingStub.restore();
        classifyAppHostDirectoryStub.restore();
        resolveCliPathStub.restore();
        onDidTerminateDebugSessionStub.restore();
        onDidTerminateDebugSessionCallback = undefined;
        for (const directory of fixtureDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
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
        assert.strictEqual(config.__aspireAppHostSelectionOrigin, 'user-selection');
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

    test('launch cancellation during telemetry classification does not start debugging', async () => {
        const telemetryStarted = createDeferred<void>();
        const releaseTelemetry = createDeferred<'csharp'>();
        const cancellationSource = new vscode.CancellationTokenSource();
        classifyAppHostDirectoryStub.callsFake(async () => {
            telemetryStarted.resolve();
            return releaseTelemetry.promise;
        });

        const launchPromise = service.launch(
            path.resolve(__dirname, '..'),
            'run',
            true,
            undefined,
            cancellationSource.token);
        await telemetryStarted.promise;
        cancellationSource.cancel();
        releaseTelemetry.resolve('csharp');

        await assert.rejects(launchPromise, vscode.CancellationError);
        assert.strictEqual(startDebuggingStub.called, false);
    });

    test('launch cancellation during the CLI gate does not start debugging', async () => {
        const cliProbeStarted = createDeferred<void>();
        const releaseCliProbe = createDeferred<{ cliPath: string; available: true; source: 'path' }>();
        const cancellationSource = new vscode.CancellationTokenSource();
        resolveCliPathStub.callsFake(async () => {
            cliProbeStarted.resolve();
            return releaseCliProbe.promise;
        });

        const launchPromise = service.launch(
            '/repo/AppHost.csproj',
            'run',
            true,
            undefined,
            cancellationSource.token);
        await cliProbeStarted.promise;
        cancellationSource.cancel();
        releaseCliProbe.resolve({ cliPath: 'aspire', available: true, source: 'path' });

        await assert.rejects(launchPromise, vscode.CancellationError);
        assert.strictEqual(startDebuggingStub.called, false);
    });

    test('symlink and real-path callers atomically claim one launch', async () => {
        const directory = createFixtureDirectory('identity');
        const realAppHostDirectory = path.join(directory, 'RealAppHost');
        const linkedAppHostDirectory = path.join(directory, 'LinkedAppHost');
        const realAppHostPath = path.join(realAppHostDirectory, 'AppHost.csproj');
        const linkedAppHostPath = path.join(linkedAppHostDirectory, 'AppHost.csproj');
        const firstDebugStart = createDeferred<void>();
        const releaseFirstDebugStart = createDeferred<void>();
        fs.mkdirSync(realAppHostDirectory, { recursive: true });
        fs.writeFileSync(realAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        createDirectoryLink(linkedAppHostDirectory, realAppHostDirectory);
        startDebuggingStub.onFirstCall().callsFake(async () => {
            firstDebugStart.resolve();
            await releaseFirstDebugStart.promise;
            return true;
        });
        startDebuggingStub.onSecondCall().resolves(true);

        const linkedLaunch = service.launch(linkedAppHostPath, 'run', true);
        await firstDebugStart.promise;
        const realLaunchAccepted = await service.launch(realAppHostPath, 'run', true);
        releaseFirstDebugStart.resolve();
        const linkedLaunchAccepted = await linkedLaunch;

        assert.strictEqual(startDebuggingStub.callCount, 1);
        assert.strictEqual(linkedLaunchAccepted, true);
        assert.strictEqual(realLaunchAccepted, false);
    });

    test('failed symlink launch releases the identity claim for a real-path retry', async () => {
        const directory = createFixtureDirectory('retry');
        const realAppHostDirectory = path.join(directory, 'RealAppHost');
        const linkedAppHostDirectory = path.join(directory, 'LinkedAppHost');
        const realAppHostPath = path.join(realAppHostDirectory, 'AppHost.csproj');
        const linkedAppHostPath = path.join(linkedAppHostDirectory, 'AppHost.csproj');
        fs.mkdirSync(realAppHostDirectory, { recursive: true });
        fs.writeFileSync(realAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        createDirectoryLink(linkedAppHostDirectory, realAppHostDirectory);
        startDebuggingStub.onFirstCall().resolves(false);
        startDebuggingStub.onSecondCall().resolves(true);

        await assert.rejects(
            service.launch(linkedAppHostPath, 'run', true),
            /did not start the Aspire run session/);
        const retryAccepted = await service.launch(realAppHostPath, 'run', true);

        assert.strictEqual(retryAccepted, true);
        assert.strictEqual(startDebuggingStub.callCount, 2);
    });

    test('termination from an older same-path session does not clear a newer claim', async () => {
        const appHostPath = '/repo/AppHost.csproj';
        const secondDebugStart = createDeferred<void>();
        const releaseSecondDebugStart = createDeferred<boolean>();
        startDebuggingStub.onFirstCall().resolves(true);
        startDebuggingStub.onSecondCall().callsFake(async () => {
            secondDebugStart.resolve();
            return releaseSecondDebugStart.promise;
        });

        await service.launch(appHostPath, 'run', true);
        const firstConfiguration = startDebuggingStub.firstCall.args[1] as AspireExtendedDebugConfiguration;
        service.updateRunningAppHosts([{ appHostPath, appHostPid: 1 }]);

        const secondLaunch = service.launch(appHostPath, 'run', true);
        await secondDebugStart.promise;
        assert.ok(onDidTerminateDebugSessionCallback);
        onDidTerminateDebugSessionCallback({
            configuration: firstConfiguration,
        } as unknown as vscode.DebugSession);

        const remainedLaunching = service.isLaunching(appHostPath);
        const thirdLaunchAccepted = await service.launch(appHostPath, 'run', true);
        releaseSecondDebugStart.resolve(true);
        await secondLaunch;

        assert.strictEqual(remainedLaunching, true);
        assert.strictEqual(thirdLaunchAccepted, false);
        assert.strictEqual(startDebuggingStub.callCount, 2);
    });

    test('release from an older same-path launch does not clear a newer claim', async () => {
        const appHostPath = '/repo/AppHost.csproj';
        const firstDebugStart = createDeferred<void>();
        const releaseFirstDebugStart = createDeferred<boolean>();
        const secondDebugStart = createDeferred<void>();
        const releaseSecondDebugStart = createDeferred<boolean>();
        startDebuggingStub.onFirstCall().callsFake(async () => {
            firstDebugStart.resolve();
            return releaseFirstDebugStart.promise;
        });
        startDebuggingStub.onSecondCall().callsFake(async () => {
            secondDebugStart.resolve();
            return releaseSecondDebugStart.promise;
        });

        const firstLaunch = service.launch(appHostPath, 'run', true);
        await firstDebugStart.promise;
        service.updateRunningAppHosts([{ appHostPath, appHostPid: 1 }]);

        const secondLaunch = service.launch(appHostPath, 'run', true);
        await secondDebugStart.promise;
        releaseFirstDebugStart.resolve(false);
        await assert.rejects(firstLaunch, /did not start the Aspire run session/);

        const remainedLaunching = service.isLaunching(appHostPath);
        const thirdLaunchAccepted = await service.launch(appHostPath, 'run', true);
        releaseSecondDebugStart.resolve(true);
        await secondLaunch;

        assert.strictEqual(remainedLaunching, true);
        assert.strictEqual(thirdLaunchAccepted, false);
        assert.strictEqual(startDebuggingStub.callCount, 2);
    });

    test('a new running AppHost removes the path from launching state', async () => {
        await service.launch('/repo/AppHost.csproj', 'run', true);
        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), true);

        service.updateRunningAppHosts([{ appHostPath: '/repo/AppHost.csproj', appHostPid: 1 }]);

        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
    });

    test('a new running AppHost fires onDidChangeLaunchingState event', async () => {
        await service.launch('/repo/AppHost.csproj', 'run', true);

        let fired = false;
        service.onDidChangeLaunchingState(() => { fired = true; });
        service.updateRunningAppHosts([{ appHostPath: '/repo/AppHost.csproj', appHostPid: 1 }]);

        assert.strictEqual(fired, true);
    });

    test('a new running AppHost does not fire event when path was not launching', () => {
        let fired = false;
        service.onDidChangeLaunchingState(() => { fired = true; });

        service.updateRunningAppHosts([{ appHostPath: '/repo/nonexistent.csproj', appHostPid: 1 }]);

        assert.strictEqual(fired, false);
    });

    test('a new running AppHost matches project paths to source files in the same directory', async () => {
        await service.launch('/repo/AppHost/AppHost.csproj', 'run', true);

        service.updateRunningAppHosts([{ appHostPath: '/repo/AppHost/Program.cs', appHostPid: 1 }]);

        assert.strictEqual(service.isLaunching('/repo/AppHost/AppHost.csproj'), false);
    });

    test('a new running AppHost does not clear unrelated paths in the same directory', async () => {
        await service.launch('/repo/AppHost/First.csproj', 'run', true);
        await service.launch('/repo/AppHost/Second.csproj', 'run', true);

        service.updateRunningAppHosts([{ appHostPath: '/repo/AppHost/Program.cs', appHostPid: 1 }]);

        assert.strictEqual(service.isLaunching('/repo/AppHost/First.csproj'), true);
        assert.strictEqual(service.isLaunching('/repo/AppHost/Second.csproj'), true);
    });

    test('multiple paths can be tracked independently', async () => {
        await service.launch('/repo/AppHost1.csproj', 'run', true);
        await service.launch('/repo/AppHost2.csproj', 'run', true);

        assert.strictEqual(service.isLaunching('/repo/AppHost1.csproj'), true);
        assert.strictEqual(service.isLaunching('/repo/AppHost2.csproj'), true);

        service.updateRunningAppHosts([{ appHostPath: '/repo/AppHost1.csproj', appHostPid: 1 }]);

        assert.strictEqual(service.isLaunching('/repo/AppHost1.csproj'), false);
        assert.strictEqual(service.isLaunching('/repo/AppHost2.csproj'), true);
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

    test('terminated owning run session clears its claim and includes stop refresh semantics', async () => {
        let terminationEvent: { appHostPath: string; command?: string; shouldRequestStopRefresh: boolean } | undefined;
        service.onDidTerminateAppHostDebugSession(event => {
            terminationEvent = event;
        });

        await service.launch('/repo/AppHost.csproj', 'run', true);
        const configuration = startDebuggingStub.firstCall.args[1] as AspireExtendedDebugConfiguration;
        assert.ok(onDidTerminateDebugSessionCallback);
        onDidTerminateDebugSessionCallback({
            configuration,
        } as unknown as vscode.DebugSession);

        assert.strictEqual(service.isLaunching('/repo/AppHost.csproj'), false);
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

    function createDeferred<T>(): {
        readonly promise: Promise<T>;
        readonly resolve: (value?: T) => void;
    } {
        let resolvePromise: (value: T) => void = () => { };
        const promise = new Promise<T>(resolve => {
            resolvePromise = resolve;
        });
        return {
            promise,
            resolve: value => resolvePromise(value as T),
        };
    }

    function createFixtureDirectory(prefix: string): string {
        const directory = fs.mkdtempSync(path.join(fixtureRoot, `${prefix}-`));
        fixtureDirectories.push(directory);
        return directory;
    }

    function createDirectoryLink(linkPath: string, targetPath: string): void {
        fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
});
