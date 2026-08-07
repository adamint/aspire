import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { browserDebuggerExtension } from '../debugger/languages/browser';
import { prepareDebugSession } from '../debugger/debuggerExtensions';
import { cleanupRun } from '../debugger/runCleanupRegistry';
import { BrowserLaunchConfiguration } from '../dcp/types';
import { extensionLogOutputChannel } from '../utils/logging';
import {
    configureBrowserDebugSession,
    createDebugSession,
    createResourceDebugConfig,
    DebugSessionHarness
} from './helpers/debugSessionHarness';

const browserProfileRoot = path.join(os.tmpdir(), 'aspire-vscode-browser-debug');
const expectedRmOptions = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };

suite('Browser Debugger Tests', () => {
    teardown(() => {
        cleanupRun('run-1');
        sinon.restore();
    });

    test('configures js-debug browser launch with isolated profile and clean-exit flags', async () => {
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        const launchConfig: BrowserLaunchConfiguration = {
            type: 'browser',
            mode: 'Debug',
            url: 'https://localhost:5001',
            web_root: '/workspace/app',
            browser: 'chrome'
        };
        const debugConfig = createResourceDebugConfig();

        await configureBrowserDebugSession(launchConfig, debugConfig);

        assert.strictEqual(debugConfig.type, 'pwa-chrome');
        assert.strictEqual(debugConfig.request, 'launch');
        assert.strictEqual(debugConfig.url, 'https://localhost:5001');
        assert.strictEqual(debugConfig.webRoot, '/workspace/app');
        assert.strictEqual(debugConfig.sourceMaps, true);
        assert.deepStrictEqual(debugConfig.resolveSourceMapLocations, ['**', '!**/node_modules/**']);
        assert.deepStrictEqual(debugConfig.runtimeArgs, [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-mode'
        ]);
        assert.strictEqual(debugConfig.userDataDir, path.join(browserProfileRoot, 'run-1'));
        assert.strictEqual(debugConfig.debugSessionId, 'dcp-1');
        assert.deepStrictEqual(debugConfig.sessionTermination, { kind: 'debugSessionEnd', dcpId: 'dcp-1' });
        assert.strictEqual(debugConfig.program, undefined);
        assert.strictEqual(debugConfig.args, undefined);
        assert.strictEqual(debugConfig.cwd, undefined);

        cleanupRun('run-1');
        assert.strictEqual(rmStub.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);
    });

    test('defaults to Edge and preserves user runtime args', async () => {
        const launchConfig: BrowserLaunchConfiguration = {
            type: 'browser',
            url: 'https://localhost:5001'
        };
        const debugConfig = createResourceDebugConfig();
        debugConfig.runtimeArgs = ['--custom-flag', '--no-first-run'];

        await configureBrowserDebugSession(launchConfig, debugConfig);

        assert.strictEqual(debugConfig.type, 'pwa-msedge');
        assert.deepStrictEqual(debugConfig.runtimeArgs, [
            '--custom-flag',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-mode'
        ]);
    });

    test('uses the registered cleanup run id for the browser profile directory', async () => {
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        const debugConfig = createResourceDebugConfig({ runId: 'custom-run-id' });

        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        assert.strictEqual(debugConfig.userDataDir, path.join(browserProfileRoot, 'custom-run-id'));

        cleanupRun('run-1');
        assert.strictEqual(rmStub.called, false);

        cleanupRun('custom-run-id');
        assert.strictEqual(rmStub.calledOnceWithExactly(path.join(browserProfileRoot, 'custom-run-id'), expectedRmOptions), true);
    });

    // Path containment. The profile directory is deleted recursively when the run ends, so a run id
    // that escapes the profile root would aim `fs.rm(..., { recursive: true })` at a directory Aspire
    // does not own. `..` is the dangerous case: `.` and `-` are legal in a run id and survive
    // character sanitizing untouched, so `path.join(tmpdir, 'aspire-vscode-browser-debug', '..')`
    // resolves to the OS temp directory itself and the cleanup would recursively delete all of it.
    const escapingRunIds: { runId: string; description: string }[] = [
        { runId: '..', description: 'parent directory traversal' },
        { runId: '.', description: 'the profile root itself' },
        { runId: '', description: 'an empty run id' },
        { runId: '../..', description: 'repeated parent traversal' },
        { runId: '.././..', description: 'mixed traversal and current-directory segments' },
        { runId: path.join(os.tmpdir(), 'elsewhere'), description: 'an absolute path inside the temp directory' },
        { runId: '/etc/passwd', description: 'an absolute POSIX path' },
        { runId: 'C:\\Windows\\System32', description: 'an absolute Windows path' },
        { runId: '..\\..\\elsewhere', description: 'Windows separator traversal' },
        { runId: 'a/../../../b', description: 'embedded separator traversal' }
    ];

    for (const { runId, description } of escapingRunIds) {
        test(`keeps the browser profile directory inside the profile root for ${description}`, async () => {
            const rmStub = sinon.stub(fs.promises, 'rm').resolves();
            const warnStub = sinon.stub(extensionLogOutputChannel, 'warn');
            const debugConfig = createResourceDebugConfig({ runId });

            await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

            const userDataDir = debugConfig.userDataDir as string | undefined;
            if (userDataDir === undefined) {
                assert.ok(
                    warnStub.getCalls().some(call => /without an isolated profile/.test(call.args[0])),
                    'Expected the rejected profile directory to be logged');
            }
            else {
                // Character sanitizing may already have collapsed the value into one safe segment (for
                // example separators became '-'), so a directory is still derived. What has to hold is
                // that it is a direct child of the profile root, never the root itself or above it.
                assert.strictEqual(
                    path.dirname(userDataDir),
                    browserProfileRoot,
                    `Expected '${userDataDir}' to be a direct child of the profile root`);
            }

            cleanupRun(runId);

            for (const call of rmStub.getCalls()) {
                const deleted = call.args[0] as string;
                assert.strictEqual(
                    path.dirname(deleted),
                    browserProfileRoot,
                    `Expected the recursive delete of '${deleted}' to stay inside '${browserProfileRoot}'`);
            }
        });
    }

    test('ignores workspace debugger settings that try to take over Aspire-owned configuration fields', async () => {
        // `prepareDebugSession` merges the workspace `debuggers.<type>` block into the generated
        // configuration before the resource extension runs. Without an allow-list a workspace could
        // set `runId: '..'` and steer the recursive profile-directory delete at the OS temp directory.
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        const prepared = await prepareDebugSession(
            {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire',
                program: '/workspace/apphost.cs',
                debuggers: {
                    browser: {
                        runId: '..',
                        debugSessionId: 'workspace-supplied-dcp-id',
                        sessionTermination: { kind: 'debugAdapterExit' },
                        isApphost: true,
                        args: ['--user-supplied']
                    } as never
                }
            },
            { type: 'browser', url: 'https://localhost:5001' } as BrowserLaunchConfiguration,
            [],
            [],
            { debug: true, runId: 'run-1', debugSessionId: 'dcp-1', isApphost: false, debugSession: {} as AspireDebugSession },
            browserDebuggerExtension);

        const configuration = prepared.debugConfiguration;
        assert.strictEqual(configuration.runId, 'run-1');
        assert.strictEqual(configuration.debugSessionId, 'dcp-1');
        assert.strictEqual(configuration.isApphost, false);
        assert.deepStrictEqual(configuration.sessionTermination, { kind: 'debugSessionEnd', dcpId: 'dcp-1' });
        assert.strictEqual(configuration.userDataDir, path.join(browserProfileRoot, 'run-1'));

        cleanupRun('run-1');
        assert.strictEqual(rmStub.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);
    });

    test('maps Firefox to the VS Code Firefox debug adapter', async () => {
        // The `firefox` adapter is only available when the firefox-devtools.vscode-firefox-debug
        // extension is installed, so stub it as present for this happy-path assertion.
        sinon.stub(vscode.extensions, 'getExtension').callsFake((id: string) =>
            id === 'firefox-devtools.vscode-firefox-debug' ? ({ id } as vscode.Extension<unknown>) : undefined);
        const debugConfig = createResourceDebugConfig();

        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001', browser: 'firefox' }, debugConfig);

        assert.strictEqual(debugConfig.type, 'firefox');
    });

    test('prompts to install the Firefox debugger and fails when the adapter is missing', async () => {
        const getExtensionStub = sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showErrorStub = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined as any);
        const debugConfig = createResourceDebugConfig();

        await assert.rejects(
            configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001', browser: 'firefox' }, debugConfig),
            /Firefox Debugger extension/);

        assert.ok(getExtensionStub.calledWith('firefox-devtools.vscode-firefox-debug'));
        assert.strictEqual(showErrorStub.calledOnce, true);
        assert.match(showErrorStub.firstCall.args[0], /Firefox Debugger extension/);
    });

    test('installs the Firefox debugger when the user accepts the install prompt', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        sinon.stub(vscode.window, 'showErrorMessage').resolves('Install' as any);
        const executeCommandStub = sinon.stub(vscode.commands, 'executeCommand').resolves();
        const debugConfig = createResourceDebugConfig();

        await assert.rejects(
            configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001', browser: 'firefox' }, debugConfig),
            /Firefox Debugger extension/);

        // The prompt is fire-and-forget, so let the resolved showErrorMessage promise settle.
        await Promise.resolve();
        await Promise.resolve();

        assert.ok(executeCommandStub.calledOnceWithExactly('workbench.extensions.installExtension', 'firefox-devtools.vscode-firefox-debug'));
    });

    test('logs the missing URL reason when browser launch configuration is incomplete', async () => {
        const infoStub = sinon.stub(extensionLogOutputChannel, 'info');
        const launchConfig: BrowserLaunchConfiguration = {
            type: 'browser'
        };

        await assert.rejects(configureBrowserDebugSession(launchConfig, createResourceDebugConfig()));

        assert.strictEqual(infoStub.calledOnce, true);
        assert.match(infoStub.firstCall.args[0], /Browser launch configuration did not include a URL/);
    });

    test('sends sessionTerminated and cleans up when the root browser debug session terminates', async () => {
        const harness = new DebugSessionHarness();
        const debugConfig = createResourceDebugConfig();
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        harness.terminateSession(resourceDebugSession.session);

        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);
        assert.strictEqual(harness.rm.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);

        harness.dispose();
    });

    test('waits for stopped browser debug session before cleaning profile directory', async () => {
        const harness = new DebugSessionHarness({ stopDebugging: 'deferred' });
        const debugConfig = createResourceDebugConfig();
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        const stop = Promise.resolve(resourceDebugSession.stopSession());
        await Promise.resolve();

        assert.strictEqual(harness.rm.called, false);

        harness.finishStopDebugging();
        await stop;

        assert.strictEqual(harness.rm.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);

        harness.dispose();
    });

    test('stopSession is awaitable and single-shot for a DCP-requested browser stop', async () => {
        // This is the shape a DCP `DELETE /run_session` drives (microsoft/aspire#19125 schedules the
        // debugger teardown after acknowledging the delete). Three things must hold together:
        //   1. stopSession() resolves only after VS Code finished stopping the browser session, so the
        //      caller can sequence teardown rather than fire-and-forget.
        //   2. exactly one `sessionTerminated` reaches DCP, with no `exit_code` (a requested stop is
        //      not a program exit).
        //   3. repeated stops are memoized, so DCP-requested stop plus extension disposal cannot
        //      terminate the run twice.
        const harness = new DebugSessionHarness({ stopDebugging: 'deferred' });
        const debugConfig = createResourceDebugConfig();
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        let stopResolved = false;
        const firstStop = Promise.resolve(resourceDebugSession.stopSession()).then(() => { stopResolved = true; });
        const secondStop = resourceDebugSession.stopSession();
        await Promise.resolve();

        assert.strictEqual(harness.stopDebugging.callCount, 1, 'Expected the browser session to be stopped once');
        assert.strictEqual(stopResolved, false, 'Expected stopSession to stay pending until VS Code finished stopping');
        assert.strictEqual(harness.sendNotification.called, false, 'Expected no termination before the stop completed');

        harness.finishStopDebugging();
        await firstStop;
        await secondStop;

        assert.strictEqual(stopResolved, true);
        assert.strictEqual(harness.stopDebugging.callCount, 1, 'Expected the second stop to reuse the in-flight stop');
        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);
        assert.strictEqual(harness.rm.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);

        harness.dispose();
        assert.strictEqual(harness.sessionTerminatedNotifications().length, 1, 'Expected disposal after a requested stop to stay single-shot');
    });

    test('stopSession is awaitable and single-shot for a non-browser resource session', async () => {
        // Only browser runs use the `debugSessionEnd` strategy; the AppHost and every normal resource
        // session go through this same stop path with `debugAdapterExit`. It has to make the same
        // ordering promise, because AspireDebugSession.stopDebugging() stops the AppHost first and only
        // then the Aspire parent — a stop that resolved early would let VS Code's parent session
        // cascade race the AppHost registry refresh.
        const harness = new DebugSessionHarness({ stopDebugging: 'deferred', startedSessionId: 'resource-session-id' });
        const debugConfig = createResourceDebugConfig({ type: 'coreclr', name: 'apiservice' });

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        let stopResolved = false;
        const firstStop = Promise.resolve(resourceDebugSession.stopSession()).then(() => { stopResolved = true; });
        const secondStop = resourceDebugSession.stopSession();
        await Promise.resolve();

        assert.strictEqual(harness.stopDebugging.callCount, 1, 'Expected the resource session to be stopped once');
        assert.strictEqual(stopResolved, false, 'Expected stopSession to stay pending until VS Code finished stopping');

        harness.finishStopDebugging();
        await firstStop;
        await secondStop;

        assert.strictEqual(stopResolved, true);
        assert.strictEqual(harness.stopDebugging.callCount, 1, 'Expected the second stop to reuse the in-flight stop');
        // `debugAdapterExit` runs report termination from the debug adapter's onExit, not from here.
        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), []);

        harness.dispose();
    });

    test('stopSession rejects when VS Code fails to stop a non-browser resource session', async () => {
        // The failure has to reach the caller instead of being logged and dropped. stopDebugging()
        // reports AppHost stop failures to its caller, and a swallowed rejection there would let
        // teardown proceed as though the session had stopped.
        const harness = new DebugSessionHarness({ stopDebugging: 'deferred', startedSessionId: 'resource-session-id' });
        const debugConfig = createResourceDebugConfig({ type: 'coreclr', name: 'apiservice' });

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        const stop = Promise.resolve(resourceDebugSession.stopSession());
        await Promise.resolve();

        harness.failStopDebugging(new Error('VS Code failed to stop the session'));

        await assert.rejects(() => stop, /VS Code failed to stop the session/);
        assert.strictEqual(harness.stopDebugging.callCount, 1);

        harness.dispose();
    });

    test('sends sessionTerminated when browser debug session starts after Aspire session disposal', async () => {
        const harness = new DebugSessionHarness({ autoStartSession: false });
        const debugConfig = createResourceDebugConfig();
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        const resourceDebugSessionPromise = harness.aspireDebugSession.startAndGetDebugSession(debugConfig);
        await Promise.resolve();
        harness.aspireDebugSession.dispose();

        harness.startSession(createDebugSession('browser-session-id', debugConfig));

        const resourceDebugSession = await resourceDebugSessionPromise;

        assert.strictEqual(resourceDebugSession, undefined);
        assert.strictEqual(harness.stopDebugging.calledWith(sinon.match.has('id', 'browser-session-id')), true);
        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);
        assert.strictEqual(harness.rm.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);
    });

    test('does not send sessionTerminated for a browser child session from another parent', async () => {
        const harness = new DebugSessionHarness();
        const otherParentDebugSession = createDebugSession('other-browser-session-id', {
            type: 'pwa-msedge',
            request: 'launch',
            name: 'Browser: https://localhost:5001',
        });
        const debugConfig = createResourceDebugConfig({
            debugSessionId: null,
            sessionTermination: { kind: 'debugSessionEnd', dcpId: 'dcp-1' }
        });

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        harness.terminateSession(createDebugSession('same-name-different-parent-session-id', {
            type: 'pwa-msedge',
            request: 'launch',
            name: 'Browser: https://localhost:5001',
        }, otherParentDebugSession));

        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), []);

        harness.dispose();
    });

    test('does not send sessionTerminated for a transient browser child target', async () => {
        const harness = new DebugSessionHarness();
        const debugConfig = createResourceDebugConfig({
            debugSessionId: null,
            sessionTermination: { kind: 'debugSessionEnd', dcpId: 'dcp-1' }
        });

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        harness.terminateSession(createDebugSession('js-debug-child-session-id', {
            type: 'pwa-msedge',
            request: 'launch',
            name: 'Page title from browser target',
        }, resourceDebugSession.session));

        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), []);

        harness.terminateSession(resourceDebugSession.session);

        assert.strictEqual(harness.sessionTerminatedNotifications().length, 1);

        harness.dispose();
    });

    test('waits for browser debug shutdown before cleaning up a session that starts after disposal', async () => {
        const harness = new DebugSessionHarness({ stopDebugging: 'deferred' });
        harness.onBeforeSessionStarted = () => harness.aspireDebugSession.dispose();
        const debugConfig = createResourceDebugConfig();
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        let resolved = false;
        const resourceDebugSessionPromise = harness.aspireDebugSession.startAndGetDebugSession(debugConfig).then(result => {
            resolved = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();

        assert.strictEqual(resolved, false);
        assert.strictEqual(harness.sendNotification.called, false);
        assert.strictEqual(harness.rm.called, false);

        harness.finishStopDebugging();
        const resourceDebugSession = await resourceDebugSessionPromise;

        assert.strictEqual(resourceDebugSession, undefined);
        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);
        assert.strictEqual(harness.rm.calledOnceWithExactly(path.join(browserProfileRoot, 'run-1'), expectedRmOptions), true);
    });

    test('openDashboard debugFirefox launches the Firefox debug configuration', async () => {
        // The dashboard Firefox launch path is distinct from resource-based browser debugging:
        // it builds its own debug configuration in AspireDebugSession.launchDebugBrowser rather
        // than going through browserDebuggerExtension. Stub the Firefox extension as installed so
        // we exercise the happy path instead of the install prompt/fallback.
        sinon.stub(vscode.extensions, 'getExtension').callsFake((id: string) =>
            id === 'firefox-devtools.vscode-firefox-debug' ? ({ id } as vscode.Extension<unknown>) : undefined);
        const harness = new DebugSessionHarness({ autoStartSession: false });
        const openExternalStub = sinon.stub(vscode.env, 'openExternal').resolves(true);

        await harness.aspireDebugSession.openDashboard('https://localhost:5001', 'debugFirefox');

        assert.strictEqual(harness.startDebugging.calledOnce, true);
        assert.strictEqual(openExternalStub.called, false);
        const launchedConfig = harness.startDebugging.firstCall.args[1] as vscode.DebugConfiguration;
        assert.strictEqual(launchedConfig.type, 'firefox');
        assert.strictEqual(launchedConfig.request, 'launch');
        assert.strictEqual(launchedConfig.url, 'https://localhost:5001');
        assert.deepStrictEqual(launchedConfig.pathMappings, []);
        assert.strictEqual(typeof launchedConfig.webRoot, 'string');
        assert.ok((launchedConfig.webRoot as string).length > 0);

        harness.dispose();
    });

    test('openDashboard debugFirefox prompts to install and falls back to the external browser when the adapter is missing', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showErrorStub = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined as any);
        const harness = new DebugSessionHarness({ autoStartSession: false });
        const openExternalStub = sinon.stub(vscode.env, 'openExternal').resolves(true);

        await harness.aspireDebugSession.openDashboard('https://localhost:5001', 'debugFirefox');

        assert.strictEqual(harness.startDebugging.called, false);
        assert.strictEqual(showErrorStub.calledOnce, true);
        assert.match(showErrorStub.firstCall.args[0], /Firefox Debugger extension/);
        assert.strictEqual(openExternalStub.calledOnce, true);

        harness.dispose();
    });
});
