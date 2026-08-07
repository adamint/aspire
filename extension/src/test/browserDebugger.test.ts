import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { browserDebuggerExtension } from '../debugger/languages/browser';
import { nodeDebuggerExtension } from '../debugger/languages/node';
import { prepareDebugSession } from '../debugger/debuggerExtensions';
import { cleanupRun } from '../debugger/runCleanupRegistry';
import { BrowserLaunchConfiguration, ExecutableLaunchConfiguration } from '../dcp/types';
import { extensionLogOutputChannel } from '../utils/logging';
import {
    stubBrowserProfileFs,
    stubbedMkdtempSuffix,
    configureBrowserDebugSession,
    createDebugSession,
    createResourceDebugConfig,
    DebugSessionHarness
} from './helpers/debugSessionHarness';

const browserProfileRoot = path.join(os.tmpdir(), 'aspire-vscode-browser-debug');
const expectedRmOptions = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };

/**
 * The profile directory `stubBrowserProfileFs` produces for a run id. The leaf carries a generated
 * suffix because the real code creates it with `mkdtemp` rather than deriving a guessable name.
 */
function profileDirFor(runId: string): string {
    return path.join(browserProfileRoot, `${runId}-${stubbedMkdtempSuffix}`);
}

suite('Browser Debugger Tests', () => {
    setup(() => {
        // Installed for every test so none of them can create real directories under the shared OS
        // temp directory. Tests that assert on the calls request the same stubs back.
        stubBrowserProfileFs();
    });

    teardown(() => {
        cleanupRun('run-1');
        sinon.restore();
    });

    test('configures js-debug browser launch with isolated profile and clean-exit flags', async () => {
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        stubBrowserProfileFs();
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
        assert.strictEqual(debugConfig.userDataDir, profileDirFor('run-1'));
        assert.strictEqual(debugConfig.debugSessionId, 'dcp-1');
        // The signal is declared by the integration, not written by the callback, so assert it at
        // its source. js-debug is server-hosted and tears down child target sessions on its own, so
        // the root debug session ending is the only reliable run lifetime signal for browsers.
        assert.strictEqual(browserDebuggerExtension.terminationSignal, 'debug-session-end');
        assert.strictEqual(debugConfig.program, undefined);
        assert.strictEqual(debugConfig.args, undefined);
        assert.strictEqual(debugConfig.cwd, undefined);

        cleanupRun('run-1');
        assert.strictEqual(rmStub.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);
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

        assert.strictEqual(debugConfig.userDataDir, profileDirFor('custom-run-id'));

        cleanupRun('run-1');
        assert.strictEqual(rmStub.called, false);

        cleanupRun('custom-run-id');
        assert.strictEqual(rmStub.calledOnceWithExactly(profileDirFor('custom-run-id'), expectedRmOptions), true);
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
            stubBrowserProfileFs();
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

    // Directory creation, not path derivation, is what makes the profile directory safe. os.tmpdir()
    // is shared and world-writable on Linux, so another local process can create
    // `aspire-vscode-browser-debug` first. The browser follows userDataDir when it writes, so a
    // hostile root would redirect profile data - cookies and tokens for the app being debugged -
    // into a directory that process controls. No amount of string validation detects that.
    test('refuses a browser profile root that is not a real directory', async () => {
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        const warnStub = sinon.stub(extensionLogOutputChannel, 'warn');
        const profileFs = stubBrowserProfileFs();
        // A symlink planted at the profile root: lstat reports the link itself, not its target.
        profileFs.lstat.resolves({ isDirectory: () => false, uid: process.getuid?.() ?? 0 } as never);
        const debugConfig = createResourceDebugConfig();

        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        assert.strictEqual(debugConfig.userDataDir, undefined, 'Expected no profile directory to be handed to the browser');
        assert.strictEqual(profileFs.mkdtemp.called, false, 'Expected no directory to be created under an untrusted root');
        assert.ok(warnStub.getCalls().some(call => /not a real directory/.test(call.args[0])));

        cleanupRun('run-1');
        assert.strictEqual(rmStub.called, false, 'Expected nothing to be deleted when the root was refused');
    });

    test('refuses a browser profile root owned by another user', async () => {
        if (typeof process.getuid !== 'function') {
            return; // POSIX-only ownership model; %TEMP% is per-user on Windows.
        }

        const warnStub = sinon.stub(extensionLogOutputChannel, 'warn');
        const profileFs = stubBrowserProfileFs();
        profileFs.lstat.resolves({ isDirectory: () => true, uid: process.getuid() + 1 } as never);
        const debugConfig = createResourceDebugConfig();

        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        assert.strictEqual(debugConfig.userDataDir, undefined);
        assert.strictEqual(profileFs.mkdtemp.called, false);
        assert.ok(warnStub.getCalls().some(call => /owned by another user/.test(call.args[0])));
    });

    test('creates the browser profile directory atomically instead of using a guessable path', async () => {
        // A deterministic child path can be pre-created as a symlink by another local process and
        // then followed. mkdtemp fails rather than following an existing entry, so creation itself
        // is the race protection.
        const profileFs = stubBrowserProfileFs();
        const debugConfig = createResourceDebugConfig({ runId: 'run-1' });

        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        assert.strictEqual(profileFs.mkdtemp.calledOnce, true);
        assert.strictEqual(profileFs.mkdtemp.firstCall.args[0], path.join(browserProfileRoot, 'run-1-'));
        // The directory handed to the browser is the one mkdtemp actually created, not the prefix.
        assert.strictEqual(debugConfig.userDataDir, profileDirFor('run-1'));
        assert.strictEqual(profileFs.mkdir.calledOnce, true);
        assert.deepStrictEqual(profileFs.mkdir.firstCall.args[1], { recursive: true, mode: 0o700 });
    });

    test('refuses a created profile directory that resolves outside the profile root', async () => {
        // Defense in depth behind mkdtemp: whatever produced the final path, a recursive delete must
        // never be aimed outside the tree Aspire owns.
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        const warnStub = sinon.stub(extensionLogOutputChannel, 'warn');
        const profileFs = stubBrowserProfileFs();
        profileFs.mkdtemp.resolves(path.join(os.tmpdir(), 'somewhere-else'));
        const debugConfig = createResourceDebugConfig();

        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        assert.strictEqual(debugConfig.userDataDir, undefined);
        assert.ok(warnStub.getCalls().some(call => /outside/.test(call.args[0])));

        cleanupRun('run-1');
        assert.strictEqual(rmStub.called, false);
    });

    test('ignores workspace debugger settings that try to take over Aspire-owned configuration fields', async () => {
        // `prepareDebugSession` merges the workspace `debuggers.<type>` block into the generated
        // configuration. Every field on the configuration is therefore workspace-writable unless it
        // is re-applied afterwards, and several of them are not user knobs:
        //   - `runId` derives a directory that is later deleted recursively, so `'..'` would aim
        //     that delete at the OS temp directory.
        //   - `debugSessionId` becomes `dcp_id` on DCP wire notifications.
        //   - `terminationSignal` decides who reports the run terminating.
        const rmStub = sinon.stub(fs.promises, 'rm').resolves();
        stubBrowserProfileFs();
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
                        terminationSignal: 'adapter-exit',
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
        assert.strictEqual(configuration.terminationSignal, 'debug-session-end');
        assert.strictEqual(configuration.userDataDir, profileDirFor('run-1'));

        cleanupRun('run-1');
        assert.strictEqual(rmStub.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);
    });

    test('ignores a workspace attempt to rewire the termination signal of a non-browser resource', async () => {
        // The browser extension overwrites several fields itself, which can mask an override. Node
        // touches none of them, so this is the case that proves the guarantee comes from
        // prepareDebugSession rather than from a language callback happening to win the race.
        // A workspace that could set `terminationSignal: 'debug-session-end'` here would silence
        // adapterTracker's onExit notification and leave every node run alive forever in DCP.
        const prepared = await prepareDebugSession(
            {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire',
                program: '/workspace/apphost.cs',
                debuggers: {
                    node: {
                        terminationSignal: 'debug-session-end',
                        runId: '../../etc',
                        debugSessionId: 'workspace-supplied-dcp-id'
                    } as never
                }
            },
            { type: 'node', program: '/workspace/app/index.js' } as unknown as ExecutableLaunchConfiguration,
            [],
            [],
            { debug: true, runId: 'node-run', debugSessionId: 'node-dcp', isApphost: false, debugSession: {} as AspireDebugSession },
            nodeDebuggerExtension);

        assert.strictEqual(prepared.debugConfiguration.terminationSignal, 'adapter-exit');
        assert.strictEqual(prepared.debugConfiguration.runId, 'node-run');
        assert.strictEqual(prepared.debugConfiguration.debugSessionId, 'node-dcp');
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
        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);

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

        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);

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
        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);

        harness.dispose();
        assert.strictEqual(harness.sessionTerminatedNotifications().length, 1, 'Expected disposal after a requested stop to stay single-shot');
    });

    test('stopSession is awaitable and single-shot for a non-browser resource session', async () => {
        // Only browser runs use the `debug-session-end` signal; the AppHost and every normal resource
        // session go through this same stop path with `adapter-exit`. It has to make the same
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
        // `adapter-exit` runs report termination from the debug adapter's onExit, not from here.
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
        // A rejected stop means VS Code never confirmed the session ended, so the run must not be
        // reported as terminated. Claiming termination here would mark the resource stopped in the
        // dashboard while its process is still running.
        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), []);

        harness.dispose();
    });

    test('does not delete the browser profile or report termination when the stop fails', async () => {
        // The browser is potentially still running after a failed stop, and its profile directory is
        // its live working state. Deleting it would corrupt a running browser, so cleanup has to wait
        // for a stop that actually succeeded (or for the session to end on its own).
        const harness = new DebugSessionHarness({ stopDebugging: 'deferred' });
        const debugConfig = createResourceDebugConfig();
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        const stop = Promise.resolve(resourceDebugSession.stopSession());
        await Promise.resolve();
        harness.failStopDebugging(new Error('VS Code failed to stop the session'));

        await assert.rejects(() => stop, /VS Code failed to stop the session/);
        assert.strictEqual(harness.rm.called, false, 'Expected the profile directory to survive a failed stop');
        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), []);

        // The termination listener has to survive the failure, otherwise a session that later ends
        // for real would never terminate the run in DCP.
        harness.terminateSession(resourceDebugSession.session);

        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);
        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);

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
        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);
    });

    test('does not send sessionTerminated for a browser child session from another parent', async () => {
        const harness = new DebugSessionHarness();
        const otherParentDebugSession = createDebugSession('other-browser-session-id', {
            type: 'pwa-msedge',
            request: 'launch',
            name: 'Browser: https://localhost:5001',
        });
        const debugConfig = createResourceDebugConfig({
            terminationSignal: 'debug-session-end'
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
            terminationSignal: 'debug-session-end'
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

        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), [{
            notification_type: 'sessionTerminated',
            session_id: 'run-1',
            dcp_id: 'dcp-1'
        }]);

        harness.dispose();
    });

    test('skips the termination notification when the run has no DCP session id', async () => {
        // `debugSessionId` is typed nullable and every other DCP notification path in
        // AspireDebugSession skips with a warning when it is missing rather than inventing an id
        // (see trackAlreadyStartedResourceSession). Termination has to agree: a notification
        // addressed to no run is not deliverable, and guessing an id would target another run.
        const harness = new DebugSessionHarness();
        const debugConfig = createResourceDebugConfig({ debugSessionId: null });
        // Configure through the real browser path so the profile-directory cleanup is registered
        // and the assertion below proves cleanup is independent of the notification.
        await configureBrowserDebugSession({ type: 'browser', url: 'https://localhost:5001' }, debugConfig);

        const resourceDebugSession = await harness.aspireDebugSession.startAndGetDebugSession(debugConfig);

        assert.ok(resourceDebugSession);
        harness.terminateSession(resourceDebugSession.session);

        assert.deepStrictEqual(harness.sessionTerminatedNotifications(), []);
        // Cleanup still has to run, otherwise the browser profile directory leaks.
        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);

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
        assert.strictEqual(harness.rm.calledOnceWithExactly(profileDirFor('run-1'), expectedRmOptions), true);
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
