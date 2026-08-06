import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { announceHotReloadForSessionIfNeeded, applyDevKitHotReloadSupport, initializeHotReloadPromptState, isHotReloadSettingEnabled, logHotReloadDiagnostics, logResolvedHotReloadState, promptToEnableHotReloadIfNeeded, tryGetDevKitBrokeredServicePipeName } from '../debugger/hotReload';
import { hotReloadPromptSuppressedKey, hotReloadSessionNoticeShownKey } from '../utils/hotReloadNotificationState';
import { createTestMemento } from './common';
import { hotReloadActiveNotice, hotReloadAvailablePrompt, hotReloadEnabled } from '../loc/strings';
import { AspireResourceExtendedDebugConfiguration } from '../dcp/types';
import { extensionLogOutputChannel } from '../utils/logging';

suite('Hot Reload Tests', () => {
    teardown(() => sinon.restore());

    function createDebugConfig(overrides: Partial<AspireResourceExtendedDebugConfiguration> = {}): AspireResourceExtendedDebugConfiguration {
        return {
            type: 'coreclr',
            request: 'launch',
            name: 'Debug api',
            program: '/workspace/api/bin/Debug/net10.0/api.dll',
            noDebug: false,
            runId: '1',
            debugSessionId: '1',
            ...overrides
        };
    }

    /**
     * Stubs extension lookup so only C# Dev Kit resolves, with a caller-controlled exports shape and
     * activation state. Anything else (including the C# extension) resolves to undefined.
     */
    function stubDevKit(options: { active?: boolean; exports?: unknown } = {}): void {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
            if (extensionId !== 'ms-dotnettools.csdevkit') {
                return undefined;
            }

            return {
                id: extensionId,
                isActive: options.active ?? true,
                exports: options.exports
            } as unknown as vscode.Extension<unknown>;
        });
    }

    function stubNoExtensions(): void {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
    }

    test('does not modify the debug configuration when C# Dev Kit is not installed', async () => {
        stubNoExtensions();

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, false);
        assert.strictEqual(diagnostics.devKitActive, false);
        assert.strictEqual(diagnostics.devKitServerLoaded, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('leaves the rest of the debug configuration untouched without C# Dev Kit', async () => {
        stubNoExtensions();

        const debugConfig = createDebugConfig();
        const before = JSON.stringify(debugConfig);

        await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(JSON.stringify(debugConfig), before);
    });

    test('does not activate C# Dev Kit when it has not activated itself', async () => {
        stubDevKit({
            active: false,
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'pipe-should-not-be-read'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('does not inject a pipe name before the C# Dev Kit server process has loaded', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => false,
                getBrokeredServiceServerPipeName: async () => 'pipe-should-not-be-read'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('injects the brokered service pipe name when C# Dev Kit is ready', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, 'devkit-broker-pipe');
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, true);
        assert.strictEqual(diagnostics.pipeNameInjected, true);
    });

    test('does not inject a pipe name for a no-debug session', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig({ noDebug: true });
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('preserves an existing brokered service pipe name', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig({ brokeredServicePipeName: 'already-set-pipe' });
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, 'already-set-pipe');
        assert.strictEqual(diagnostics.pipeNameInjected, true);
    });

    test('ignores an empty pipe name', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => ''
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('does not fail the launch when C# Dev Kit throws while resolving the pipe name', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => { throw new Error('broker unavailable'); }
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('tolerates an unexpected C# Dev Kit exports shape', async () => {
        stubDevKit({ exports: { somethingElse: true } });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('reports limited activation when C# Dev Kit activated for an untrusted workspace', async () => {
        // In limited activation Dev Kit returns ONLY this flag: no service broker, no pipe name.
        stubDevKit({ exports: { isLimitedActivation: true } });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitLimitedActivation, true);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('does not report limited activation for a fully activated C# Dev Kit', async () => {
        stubDevKit({
            exports: {
                isLimitedActivation: false,
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(diagnostics.devKitLimitedActivation, false);
        assert.strictEqual(diagnostics.pipeNameInjected, true);
    });

    test('tolerates undefined C# Dev Kit exports', async () => {
        stubDevKit({ exports: undefined });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('returns no pipe name when C# Dev Kit is not installed', async () => {
        stubNoExtensions();

        assert.strictEqual(await tryGetDevKitBrokeredServicePipeName(), undefined);
    });

    test('reads the hot reload setting from the csharp.experimental.debug section', () => {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns({
            get: (name: string) => name === 'hotReload' ? true : undefined
        } as unknown as vscode.WorkspaceConfiguration);

        assert.strictEqual(isHotReloadSettingEnabled(), true);
    });

    test('treats an unset hot reload setting as disabled', () => {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns({
            get: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        assert.strictEqual(isHotReloadSettingEnabled(), false);
    });

    test('explains why Hot Reload is unavailable when the setting is off', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            devKitActive: true,
            devKitLimitedActivation: false,
            devKitServerLoaded: true,
            settingEnabled: false,
            pipeNameInjected: true
        });

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        // The machine-scope caveat is the whole point of the message: users otherwise put the
        // setting in workspace settings, where VS Code silently ignores it.
        assert.ok(logged.includes('csharp.experimental.debug.hotReload=false'), logged);
        assert.ok(logged.includes('machine-scoped'), logged);
    });

    test('says nothing at all when C# Dev Kit is not installed', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: false,
            devKitActive: false,
            devKitLimitedActivation: false,
            devKitServerLoaded: false,
            settingEnabled: false,
            pipeNameInjected: false
        });

        assert.strictEqual(info.called, false, 'running .NET resources without Dev Kit is fully supported and must not be reported as a problem');
    });

    suite('launch path is bounded', () => {
        test('gives up on a wedged C# Dev Kit instead of stalling the resource launch', async () => {
            // This bound is the only thing between a wedged Dev Kit and a resource that never
            // launches: createDebugSessionConfigurationCallback is awaited BEFORE the debug session
            // is created, so an unbounded await here hangs the resource indefinitely.
            const clock = sinon.useFakeTimers();
            try {
                stubDevKit({
                    exports: {
                        hasServerProcessLoaded: () => true,
                        getBrokeredServiceServerPipeName: () => new Promise<string>(() => { /* never settles */ })
                    }
                });

                const pending = tryGetDevKitBrokeredServicePipeName();
                await clock.tickAsync(5000);

                assert.strictEqual(await pending, undefined);
            }
            finally {
                clock.restore();
            }
        });

        test('does not leave a pending timer behind on the fast path', async () => {
            const clock = sinon.useFakeTimers();
            try {
                stubDevKit({
                    exports: {
                        hasServerProcessLoaded: () => true,
                        getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
                    }
                });

                assert.strictEqual(await tryGetDevKitBrokeredServicePipeName(), 'devkit-broker-pipe');
                // A leaked timeout keeps the event loop busy and, under a fake clock, is directly
                // observable as a still-scheduled timer.
                assert.strictEqual(clock.countTimers(), 0, 'the timeout timer must be cleared once the pipe name resolves');
            }
            finally {
                clock.restore();
            }
        });
    });

    suite('resolved state logging', () => {
        function createSession(type: string): vscode.DebugSession {
            return { type, name: `session-${type}` } as vscode.DebugSession;
        }

        test('ignores debug sessions that are not coreclr', () => {
            stubDevKit();
            const info = sinon.stub(extensionLogOutputChannel, 'info');

            // This runs inside the DAP tracker attached to every Aspire debug session, so a Node or
            // Python resource must not produce .NET diagnostics.
            logResolvedHotReloadState(createSession('pwa-node'), { brokeredServicePipeName: 'pipe' });

            assert.strictEqual(info.called, false);
        });

        test('says nothing when C# Dev Kit is not installed', () => {
            stubNoExtensions();
            const info = sinon.stub(extensionLogOutputChannel, 'info');

            logResolvedHotReloadState(createSession('coreclr'), {});

            assert.strictEqual(info.called, false);
        });

        test('never logs the pipe name itself', () => {
            stubDevKit();
            const info = sinon.stub(extensionLogOutputChannel, 'info');

            logResolvedHotReloadState(createSession('coreclr'), { brokeredServicePipeName: 'secret-pipe-value' });

            const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
            assert.ok(logged.includes('present'), `expected the pipe to be reported as present, got: ${logged}`);
            assert.strictEqual(logged.includes('secret-pipe-value'), false, 'the pipe name addresses a live endpoint and must never be logged');
        });

        test('reports a missing pipe for malformed launch arguments', () => {
            stubDevKit();
            const info = sinon.stub(extensionLogOutputChannel, 'info');

            // The arguments come off the wire, so nothing about their shape is guaranteed. A throw
            // here would escape into VS Code's DAP tracker for every Aspire debug session, and a
            // silent early return would make the diagnostic useless.
            const malformed = [undefined, null, 'a string', 42, [], { brokeredServicePipeName: 17 }, { brokeredServicePipeName: '' }];
            for (const launchArguments of malformed) {
                info.resetHistory();
                logResolvedHotReloadState(createSession('coreclr'), launchArguments);

                const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
                assert.ok(logged.includes('absent'), `expected '${JSON.stringify(launchArguments)}' to be reported as absent, got: ${logged}`);
            }
        });
    });

    suite('active session notice', () => {
        const activeDiagnostics = {
            devKitInstalled: true,
            devKitActive: true,
            devKitLimitedActivation: false,
            devKitServerLoaded: true,
            settingEnabled: true,
            pipeNameInjected: true
        };

        // The notice body is fire-and-forget so it cannot block the launch path, so let the
        // microtask queue drain before asserting.
        const flush = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };

        test('tells the user Hot Reload is active and how it is triggered', async () => {
            initializeHotReloadPromptState(createTestMemento());
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            await flush();

            assert.strictEqual(notification.callCount, 1);
            assert.strictEqual(notification.firstCall.args[0], hotReloadActiveNotice);
        });

        test('makes no claim that depends on how many resources have launched', () => {
            // Regression guard. An earlier version counted the resources seen so far and announced
            // "1 .NET resource(s)" for a three-resource app, because Aspire launches resources as
            // independent requests spread over seconds rather than all at once. Any count or list
            // in this string is wrong for whichever resources had not started yet.
            assert.strictEqual(/\d/.test(hotReloadActiveNotice), false, hotReloadActiveNotice);
        });

        test('is raised once per launch burst, not once per resource', async () => {
            initializeHotReloadPromptState(createTestMemento());
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            // Concurrent launches: the guard has to be set before the first await, or a five-project
            // app produces five identical notices.
            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            await flush();

            assert.strictEqual(notification.callCount, 1);
        });

        test('is shown once ever, not once per window', async () => {
            const memento = createTestMemento();
            await memento.update(hotReloadSessionNoticeShownKey, true);
            initializeHotReloadPromptState(memento);
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            await flush();

            assert.strictEqual(notification.called, false);
        });

        test('records that it was shown so a later window stays quiet', async () => {
            const memento = createTestMemento();
            initializeHotReloadPromptState(memento);
            sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            await flush();

            assert.strictEqual(memento.get<boolean>(hotReloadSessionNoticeShownKey, false), true);
        });

        test('opens the Dev Kit Hot Reload output when the user asks for it', async () => {
            initializeHotReloadPromptState(createTestMemento());
            sinon.stub(vscode.window, 'showInformationMessage').resolves('Show Hot Reload Output' as unknown as vscode.MessageItem);
            const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            await flush();

            assert.strictEqual(executeCommand.calledWith('csdevkit.debug.showHotReloadPanel'), true);
        });

        test('survives Dev Kit not having the Hot Reload panel command', async () => {
            initializeHotReloadPromptState(createTestMemento());
            sinon.stub(vscode.window, 'showInformationMessage').resolves('Show Hot Reload Output' as unknown as vscode.MessageItem);
            sinon.stub(vscode.commands, 'executeCommand').rejects(new Error('command not found'));

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
            await flush();
        });

        test('stays silent when Hot Reload is off, since the enable prompt covers that case', async () => {
            initializeHotReloadPromptState(createTestMemento());
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, settingEnabled: false }, true);
            await flush();

            assert.strictEqual(notification.called, false);
        });

        test('stays silent for a non-debug session and without a usable Dev Kit', async () => {
            initializeHotReloadPromptState(createTestMemento());
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, false);
            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, devKitInstalled: false }, true);
            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, devKitActive: false }, true);
            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, devKitLimitedActivation: true }, true);
            await flush();

            assert.strictEqual(notification.called, false);
        });

        test('does not notify per reload, because Dev Kit exposes no reload result', async () => {
            initializeHotReloadPromptState(createTestMemento());
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            // Stands in for a developer saving repeatedly during a session. Hot Reload runs on every
            // save ('csharp.debug.hotReloadOnSave' defaults to true), so anything that notified per
            // reload would be unusable.
            for (let i = 0; i < 25; i++) {
                announceHotReloadForSessionIfNeeded(activeDiagnostics, true);
                await flush();
            }

            assert.strictEqual(notification.callCount, 1);
        });
    });

    suite('enable prompt', () => {
        const enabledDiagnostics = {
            devKitInstalled: true,
            devKitActive: true,
            devKitLimitedActivation: false,
            devKitServerLoaded: true,
            settingEnabled: false,
            pipeNameInjected: true
        };

        function stubPrompt(selection: string | undefined): sinon.SinonStub {
            return sinon.stub(vscode.window, 'showInformationMessage').resolves(selection as unknown as vscode.MessageItem);
        }

        test('offers to enable Hot Reload when Dev Kit is present but the setting is off', async () => {
            initializeHotReloadPromptState(createTestMemento());
            const prompt = stubPrompt('Enable Hot Reload');
            const update = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: () => false, update } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true);

            assert.strictEqual(enabled, true);
            // Two messages are shown: the offer, then the confirmation that it takes effect on the
            // next session. Assert on the offer specifically rather than the call count.
            assert.strictEqual(prompt.firstCall.args[0], hotReloadAvailablePrompt);
            assert.strictEqual(prompt.lastCall.args[0], hotReloadEnabled);
            // The setting is machine-scoped, so a workspace-scoped write would be silently discarded.
            assert.deepStrictEqual(update.firstCall.args, ['hotReload', true, vscode.ConfigurationTarget.Global]);
        });

        test('only prompts once even when several project resources launch together', async () => {
            initializeHotReloadPromptState(createTestMemento());

            // Genuinely concurrent, with a prompt that does not settle until every caller has
            // entered the function. An Aspire app launches its resources in parallel, so awaiting
            // the calls one at a time would pass even if the "already prompted" guard were placed
            // after the first await, which is exactly the bug worth catching.
            let resolvePrompt: ((value: string | undefined) => void) | undefined;
            const pending = new Promise<string | undefined>(resolve => { resolvePrompt = resolve; });
            const prompt = sinon.stub(vscode.window, 'showInformationMessage').returns(pending as unknown as Thenable<vscode.MessageItem | undefined>);

            const inFlight = Promise.all([
                promptToEnableHotReloadIfNeeded(enabledDiagnostics, true),
                promptToEnableHotReloadIfNeeded(enabledDiagnostics, true),
                promptToEnableHotReloadIfNeeded(enabledDiagnostics, true)
            ]);

            assert.strictEqual(prompt.callCount, 1, 'a second concurrent resource must not raise its own notification');

            resolvePrompt?.(undefined);
            assert.deepStrictEqual(await inFlight, [false, false, false]);
            assert.strictEqual(prompt.callCount, 1);
        });

        test('does not offer Hot Reload for a resource whose debugger was disabled', async () => {
            // The `dotnet run` and file-based-executable fallbacks force noDebug while the caller's
            // requested mode stays "debug". Hot Reload is applied by the debugger, so prompting
            // there would spend the single one-time offer on a resource that cannot use it.
            initializeHotReloadPromptState(createTestMemento());
            const prompt = stubPrompt('Enable Hot Reload');

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, false);

            assert.strictEqual(enabled, false);
            assert.strictEqual(prompt.called, false);
        });

        test('still confirms the setting was enabled when persisting the dismissal fails', async () => {
            // The memento write is bookkeeping. Losing it must not skip the confirmation telling the
            // user to restart, because the setting itself was written successfully.
            const failingMemento = createTestMemento();
            sinon.stub(failingMemento, 'update').rejects(new Error('storage is full'));
            initializeHotReloadPromptState(failingMemento);
            const prompt = stubPrompt('Enable Hot Reload');
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                update: async () => undefined
            } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true);

            assert.strictEqual(enabled, true);
            assert.strictEqual(prompt.lastCall.args[0], hotReloadEnabled);
        });

        test('stops offering after the user dismisses it permanently', async () => {
            const memento = createTestMemento();
            initializeHotReloadPromptState(memento);
            stubPrompt("Don't Show Again");

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true);

            assert.strictEqual(enabled, false);
            assert.strictEqual(memento.get(hotReloadPromptSuppressedKey), true);
        });

        test('does not prompt again in a later window once suppressed', async () => {
            const memento = createTestMemento();
            await memento.update(hotReloadPromptSuppressedKey, true);
            initializeHotReloadPromptState(memento);
            const prompt = stubPrompt('Enable Hot Reload');

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true);

            assert.strictEqual(enabled, false);
            assert.strictEqual(prompt.called, false);
        });

        test('stays silent for cases where enabling the setting would not help', async () => {
            const cases: { name: string; diagnostics: typeof enabledDiagnostics; isDebug: boolean }[] = [
                { name: 'Dev Kit not installed', diagnostics: { ...enabledDiagnostics, devKitInstalled: false, devKitActive: false }, isDebug: true },
                { name: 'Dev Kit not active', diagnostics: { ...enabledDiagnostics, devKitActive: false }, isDebug: true },
                { name: 'untrusted workspace', diagnostics: { ...enabledDiagnostics, devKitLimitedActivation: true }, isDebug: true },
                { name: 'setting already enabled', diagnostics: { ...enabledDiagnostics, settingEnabled: true }, isDebug: true },
                { name: 'run without debugging', diagnostics: enabledDiagnostics, isDebug: false }
            ];

            for (const testCase of cases) {
                sinon.restore();
                initializeHotReloadPromptState(createTestMemento());
                const prompt = stubPrompt('Enable Hot Reload');

                const enabled = await promptToEnableHotReloadIfNeeded(testCase.diagnostics, testCase.isDebug);

                assert.strictEqual(enabled, false, testCase.name);
                assert.strictEqual(prompt.called, false, testCase.name);
            }
        });

        test('reports failure instead of claiming success when the setting cannot be written', async () => {
            initializeHotReloadPromptState(createTestMemento());
            stubPrompt('Enable Hot Reload');
            const error = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                update: sinon.stub().rejects(new Error('settings are read-only'))
            } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true);

            assert.strictEqual(enabled, false);
            assert.strictEqual(error.calledOnce, true);
        });
    });
});
