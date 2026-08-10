import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { BrowserDebugSessionTermination } from '../debugger/browserDebugSessionTermination';
import { browserDebuggerExtension } from '../debugger/languages/browser';
import { prepareDebugSession } from '../debugger/debuggerExtensions';
import { cleanupRun, registerRunCleanup } from '../debugger/runCleanupRegistry';
import { AspireResourceDebugSession, AspireResourceExtendedDebugConfiguration, BrowserLaunchConfiguration, SessionTerminatedNotification } from '../dcp/types';

suite('Browser Debugger Tests', () => {
    teardown(() => {
        cleanupRun('run-1');
        sinon.restore();
    });

    test('configures Chromium for an isolated browser that exits with the debug session', async () => {
        const configuration = await createBrowserConfiguration(
            { type: 'browser', url: 'https://localhost:5001', browser: 'chrome' },
            {
                runtimeArgs: ['--start-maximized', '--user-data-dir', '/workspace/profile'],
                runId: 'workspace-run',
                debugSessionId: 'workspace-dcp',
                resourceType: 'node'
            });

        assert.strictEqual(configuration.type, 'pwa-chrome');
        assert.strictEqual(configuration.request, 'launch');
        assert.strictEqual(configuration.url, 'https://localhost:5001');
        assert.strictEqual(configuration.userDataDir, true);
        assert.deepStrictEqual(configuration.runtimeArgs, [
            '--start-maximized',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-mode'
        ]);
        assert.strictEqual(configuration.runId, 'run-1');
        assert.strictEqual(configuration.debugSessionId, 'dcp-1');
        assert.strictEqual(configuration.resourceType, 'browser');
    });

    test('forces Firefox to terminate instead of reattaching to the launched browser', async () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((id: string) =>
            id === 'firefox-devtools.vscode-firefox-debug' ? ({ id } as vscode.Extension<unknown>) : undefined);
        const configuration = await createBrowserConfiguration(
            { type: 'browser', url: 'https://localhost:5001', browser: 'firefox' },
            {
                reAttach: true,
                runtimeArgs: ['--headless'],
                userDataDir: '/workspace/chrome-profile'
            });

        assert.strictEqual(configuration.type, 'firefox');
        assert.strictEqual(configuration.reAttach, false);
        assert.strictEqual(configuration.runtimeArgs, undefined);
        assert.strictEqual(configuration.userDataDir, undefined);
        assert.deepStrictEqual(configuration.pathMappings, []);
    });

    test('prompts to install the Firefox debugger when its adapter is missing', async () => {
        const getExtension = sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showErrorMessage = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);

        await assert.rejects(
            createBrowserConfiguration(
                { type: 'browser', url: 'https://localhost:5001', browser: 'firefox' },
                {}),
            /Firefox Debugger extension/);

        assert.strictEqual(getExtension.calledWith('firefox-devtools.vscode-firefox-debug'), true);
        assert.strictEqual(showErrorMessage.calledOnce, true);
        assert.match(showErrorMessage.firstCall.args[0], /Firefox Debugger extension/);
    });

    test('installs the Firefox debugger when selected from the missing-adapter prompt', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        sinon.stub(vscode.window, 'showErrorMessage').resolves('Install' as any);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();

        await assert.rejects(
            createBrowserConfiguration(
                { type: 'browser', url: 'https://localhost:5001', browser: 'firefox' },
                {}),
            /Firefox Debugger extension/);
        await Promise.resolve();
        await Promise.resolve();

        assert.strictEqual(executeCommand.calledOnceWithExactly(
            'workbench.extensions.installExtension',
            'firefox-devtools.vscode-firefox-debug'), true);
    });

    test('reports a natural root browser termination exactly once', () => {
        let terminateListener: ((session: vscode.DebugSession) => void) | undefined;
        sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(listener => {
            terminateListener = listener;
            return { dispose: () => { terminateListener = undefined; } };
        });
        const send = sinon.stub();
        const cleanup = sinon.stub();
        registerRunCleanup('run-1', cleanup);
        const session = createDebugSession('browser-root');
        new BrowserDebugSessionTermination(session, 'run-1', 'dcp-1', send);

        terminateListener!(createDebugSession('browser-child', session));
        assert.strictEqual(send.called, false);

        terminateListener!(session);

        assert.deepStrictEqual(send.firstCall.args, ['run-1', 'dcp-1']);
        assert.strictEqual(send.calledOnce, true);
        assert.strictEqual(cleanup.calledOnce, true);
        assert.strictEqual(terminateListener, undefined);
    });

    test('wires the started browser root session to DCP termination', async () => {
        let startListener: ((session: vscode.DebugSession) => void) | undefined;
        let terminateListener: ((session: vscode.DebugSession) => void) | undefined;
        sinon.stub(vscode.debug, 'onDidStartDebugSession').callsFake(listener => {
            startListener = listener;
            return { dispose: () => { startListener = undefined; } };
        });
        sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(listener => {
            terminateListener = listener;
            return { dispose: () => { terminateListener = undefined; } };
        });
        sinon.stub(vscode.debug, 'startDebugging').callsFake(async (_folder, configuration) => {
            startListener!(createDebugSession('browser-root', undefined, configuration as vscode.DebugConfiguration));
            return true;
        });
        sinon.stub(vscode.debug, 'stopDebugging').resolves();
        sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined);
        const sendNotification = sinon.stub();
        const dcpServer = {
            sendNotification,
            takeDebugSessionAggregateStats: sinon.stub().returns(undefined)
        };
        const parent = createDebugSession('aspire-parent', undefined, {
            type: 'aspire',
            name: 'Aspire',
            request: 'launch',
            program: '/workspace/apphost.cs'
        });
        const aspireSession = new AspireDebugSession(
            parent,
            {} as never,
            dcpServer as never,
            { isDebugConfigEnvironmentLoggingEnabled: () => false } as never,
            () => { });
        const configuration = await createBrowserConfiguration(
            { type: 'browser', url: 'https://localhost:5001' },
            {});

        const resourceSession = await aspireSession.startAndGetDebugSession(configuration);
        assert.ok(resourceSession);

        terminateListener!(resourceSession.session);
        terminateListener?.(resourceSession.session);

        const terminations = sendNotification.getCalls()
            .map(call => call.args[0])
            .filter((notification): notification is SessionTerminatedNotification => notification.notification_type === 'sessionTerminated');
        assert.deepStrictEqual(terminations, [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);

        aspireSession.dispose();
    });

    test('awaits one browser stop before reporting termination', async () => {
        const stop = deferred<void>();
        sinon.stub(vscode.debug, 'onDidTerminateDebugSession').returns({ dispose: () => { } });
        const stopDebugging = sinon.stub(vscode.debug, 'stopDebugging').returns(stop.promise);
        const send = sinon.stub();
        const termination = new BrowserDebugSessionTermination(createDebugSession('browser-root'), 'run-1', 'dcp-1', send);

        let resolved = false;
        const first = termination.stop().then(() => { resolved = true; });
        const second = termination.stop();
        await Promise.resolve();

        assert.strictEqual(stopDebugging.calledOnce, true);
        assert.strictEqual(resolved, false);
        assert.strictEqual(send.called, false);

        stop.resolve();
        await first;
        await second;

        assert.strictEqual(send.calledOnce, true);
    });

    test('keeps a failed browser stop retryable and does not report termination', async () => {
        let terminateListener: ((session: vscode.DebugSession) => void) | undefined;
        sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(listener => {
            terminateListener = listener;
            return { dispose: () => { terminateListener = undefined; } };
        });
        const stopDebugging = sinon.stub(vscode.debug, 'stopDebugging');
        stopDebugging.onFirstCall().rejects(new Error('stop failed'));
        stopDebugging.onSecondCall().resolves();
        const send = sinon.stub();
        const session = createDebugSession('browser-root');
        const termination = new BrowserDebugSessionTermination(session, 'run-1', 'dcp-1', send);

        await assert.rejects(termination.stop(), /stop failed/);
        assert.strictEqual(send.called, false);
        assert.ok(terminateListener);

        await termination.stop();

        assert.strictEqual(stopDebugging.callCount, 2);
        assert.strictEqual(send.calledOnce, true);
    });

    test('keeps natural termination armed after a disposal stop fails', async () => {
        let terminateListener: ((session: vscode.DebugSession) => void) | undefined;
        sinon.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(listener => {
            terminateListener = listener;
            return { dispose: () => { terminateListener = undefined; } };
        });
        sinon.stub(vscode.debug, 'stopDebugging').rejects(new Error('stop failed'));
        const send = sinon.stub();
        const cleanup = sinon.stub();
        registerRunCleanup('run-1', cleanup);
        const session = createDebugSession('browser-root');
        const termination = new BrowserDebugSessionTermination(session, 'run-1', 'dcp-1', send);

        termination.stopAndDisposeOnFailure();
        await Promise.resolve();
        await Promise.resolve();

        assert.ok(terminateListener);
        terminateListener(session);

        assert.strictEqual(send.calledOnceWithExactly('run-1', 'dcp-1'), true);
        assert.strictEqual(cleanup.calledOnce, true);
        assert.strictEqual(terminateListener, undefined);
    });

    test('returns undefined when a late browser stop succeeds after Aspire disposal', async () => {
        sinon.stub(vscode.debug, 'stopDebugging').resolves();
        const { result } = await startBrowserAfterAspireDisposal();

        assert.strictEqual(await result, undefined);
    });

    test('returns the late browser session for retry when its stop fails', async () => {
        sinon.stub(vscode.debug, 'stopDebugging').callsFake(debugSession =>
            debugSession?.id === 'browser-root' ? Promise.reject(new Error('stop failed')) : Promise.resolve());
        const { result, browserSession } = await startBrowserAfterAspireDisposal();

        assert.strictEqual((await result)?.session, browserSession);
    });

    test('times out when a late browser stop never settles after Aspire disposal', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        sinon.stub(vscode.debug, 'stopDebugging').callsFake(debugSession =>
            debugSession?.id === 'browser-root' ? new Promise<void>(() => { }) : Promise.resolve());
        const { result } = await startBrowserAfterAspireDisposal();

        await clock.tickAsync(10_000);

        assert.strictEqual(await result, undefined);
    });
});

async function createBrowserConfiguration(
    launchConfiguration: BrowserLaunchConfiguration,
    workspaceSettings: Record<string, unknown>): Promise<AspireResourceExtendedDebugConfiguration> {
    const configuration = await prepareDebugSession(
        {
            type: 'aspire',
            request: 'launch',
            name: 'Aspire',
            program: '/workspace/apphost.cs',
            debuggers: { browser: workspaceSettings as never }
        },
        launchConfiguration,
        [],
        [],
        {
            debug: true,
            runId: 'run-1',
            debugSessionId: 'dcp-1',
            isApphost: false,
            debugSession: {} as AspireDebugSession
        },
        browserDebuggerExtension);

    return configuration.debugConfiguration;
}

function createDebugSession(id: string, parentSession?: vscode.DebugSession, configuration?: vscode.DebugConfiguration): vscode.DebugSession {
    return {
        id,
        type: configuration?.type ?? 'pwa-msedge',
        name: configuration?.name ?? 'Browser',
        parentSession,
        workspaceFolder: undefined,
        configuration: configuration ?? {
            type: 'pwa-msedge',
            name: 'Browser',
            request: 'launch',
            runId: 'run-1',
            debugSessionId: 'dcp-1',
            resourceType: 'browser'
        },
        customRequest: sinon.stub(),
        getDebugProtocolBreakpoint: sinon.stub()
    };
}

async function startBrowserAfterAspireDisposal(): Promise<{
    result: Promise<AspireResourceDebugSession | undefined>;
    browserSession: vscode.DebugSession;
}> {
    let startListener: ((session: vscode.DebugSession) => void) | undefined;
    sinon.stub(vscode.debug, 'onDidStartDebugSession').callsFake(listener => {
        startListener = listener;
        return { dispose: () => { startListener = undefined; } };
    });
    sinon.stub(vscode.debug, 'onDidTerminateDebugSession').returns({ dispose: () => { } });
    sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined);
    const start = deferred<boolean>();
    sinon.stub(vscode.debug, 'startDebugging').returns(start.promise);
    const parent = createDebugSession('aspire-parent', undefined, {
        type: 'aspire',
        name: 'Aspire',
        request: 'launch',
        program: '/workspace/apphost.cs'
    });
    const aspireSession = new AspireDebugSession(
        parent,
        {} as never,
        {
            sendNotification: sinon.stub(),
            takeDebugSessionAggregateStats: sinon.stub().returns(undefined)
        } as never,
        { isDebugConfigEnvironmentLoggingEnabled: () => false } as never,
        () => { });
    const configuration = await createBrowserConfiguration(
        { type: 'browser', url: 'https://localhost:5001' },
        {});
    const browserSession = createDebugSession('browser-root', undefined, configuration);

    const result = aspireSession.startAndGetDebugSession(configuration);
    await Promise.resolve();
    aspireSession.dispose();
    startListener!(browserSession);
    start.resolve(true);
    await Promise.resolve();

    return { result, browserSession };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(promiseResolve => {
        resolve = promiseResolve;
    });

    return { promise, resolve };
}
