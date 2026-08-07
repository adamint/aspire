import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { announceHotReloadForSessionIfNeeded, getHotReloadDiagnostics, initializeHotReloadPromptState, isHotReloadOnSaveEnabled, isHotReloadSettingEnabled, logHotReloadDiagnostics, promptToEnableHotReloadIfNeeded } from '../debugger/hotReload';
import { hotReloadPromptSuppressedKey, hotReloadSessionNoticeShownKey } from '../utils/hotReloadNotificationState';
import { createTestMemento } from './common';
import { hotReloadActiveNotice, hotReloadActiveNoticeSaveDisabled, hotReloadAvailablePrompt, hotReloadEnabled, showHotReloadOutputLabel } from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';

suite('Hot Reload Tests', () => {
    teardown(() => sinon.restore());

    /**
     * Stubs extension lookup so only C# Dev Kit resolves. Anything else (including the C#
     * extension) resolves to undefined.
     */
    function stubDevKit(options: { active?: boolean; exports?: unknown; activate?: () => void } = {}): void {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
            if (extensionId !== 'ms-dotnettools.csdevkit') {
                return undefined;
            }

            return {
                id: extensionId,
                isActive: options.active ?? true,
                exports: options.exports,
                activate: options.activate
            } as unknown as vscode.Extension<unknown>;
        });
    }

    function stubNoExtensions(): void {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
    }

    /**
     * `vscode.workspace.isTrusted` is a plain property, so it is replaced rather than stubbed.
     */
    function stubWorkspaceTrust(trusted: boolean): void {
        const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
        Object.defineProperty(vscode.workspace, 'isTrusted', { value: trusted, configurable: true });
        restoreTrust = () => {
            if (descriptor) {
                Object.defineProperty(vscode.workspace, 'isTrusted', descriptor);
            }
        };
    }

    let restoreTrust: (() => void) | undefined;
    teardown(() => { restoreTrust?.(); restoreTrust = undefined; });

    test('reports Hot Reload as unavailable when C# Dev Kit is not installed', () => {
        stubNoExtensions();

        const diagnostics = getHotReloadDiagnostics();

        assert.strictEqual(diagnostics.devKitInstalled, false);
    });

    test('does not activate C# Dev Kit when it has not activated itself', () => {
        // Activating Dev Kit from the resource launch path would add startup cost for a purely
        // optional enhancement.
        const activate = sinon.spy();
        stubDevKit({ active: false, activate });

        const diagnostics = getHotReloadDiagnostics();

        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(activate.called, false, 'Dev Kit must never be activated from the resource launch path');
    });

    test('does not depend on C# Dev Kit having activated', () => {
        // Regression guard. Availability used to be gated on `extension.isActive` and on Dev Kit's
        // `isLimitedActivation` export, which are only readable once Dev Kit finishes activating.
        // Resources can launch before that, so a cold start silently produced no prompt and no
        // notice. Workspace trust carries the same information and is always readable.
        stubDevKit({ active: false, exports: undefined });
        stubWorkspaceTrust(true);

        const diagnostics = getHotReloadDiagnostics();

        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.workspaceTrusted, true);
    });

    test('never reaches into C# Dev Kit private services to set up Hot Reload', () => {
        // Hot Reload is wired up entirely by Dev Kit and the C# extension. Aspire reads state and
        // nothing more, so no brokered service call may appear on the launch path. Calling into
        // Dev Kit's service broker would couple Aspire to an unversioned internal contract.
        const getBrokeredServiceServerPipeName = sinon.spy();
        const hasServerProcessLoaded = sinon.spy();
        const ensureInitialized = sinon.spy();
        stubDevKit({ exports: { getBrokeredServiceServerPipeName, hasServerProcessLoaded, ensureInitialized, serviceBroker: {} } });

        getHotReloadDiagnostics();

        assert.strictEqual(getBrokeredServiceServerPipeName.called, false);
        assert.strictEqual(hasServerProcessLoaded.called, false);
        assert.strictEqual(ensureInitialized.called, false);
    });

    test('treats an untrusted workspace as unable to hot reload', () => {
        // Dev Kit activates in limited mode for an untrusted workspace, returning only
        // `{ isLimitedActivation: true }` and no service broker, so Hot Reload cannot work.
        stubDevKit();
        stubWorkspaceTrust(false);

        assert.strictEqual(getHotReloadDiagnostics().workspaceTrusted, false);
    });

    test('reads whether Dev Kit applies edits on save', () => {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.debug').returns({
            get: (name: string) => name === 'hotReloadOnSave' ? false : undefined
        } as unknown as vscode.WorkspaceConfiguration);
        getConfiguration.withArgs('csharp.experimental.debug').returns({
            get: () => true
        } as unknown as vscode.WorkspaceConfiguration);

        assert.strictEqual(isHotReloadOnSaveEnabled(), false);
    });

    test('treats an unset hotReloadOnSave as enabled, matching the Dev Kit default', () => {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.debug').returns({
            get: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        assert.strictEqual(isHotReloadOnSaveEnabled(), true);
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
            workspaceTrusted: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true
        }, true);

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        // The machine-scope caveat is the whole point of the message: users otherwise put the
        // setting in workspace settings, where VS Code silently ignores it.
        assert.ok(logged.includes('csharp.experimental.debug.hotReload=false'), logged);
        assert.ok(logged.includes('machine-scoped'), logged);
    });

    test('names the resource Hot Reload covers when the setting is on', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true
        }, true);

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        assert.ok(logged.includes('Hot Reload covers api'), logged);
        // Saving is the primary gesture and is on by default; the toolbar button is the fallback.
        assert.ok(logged.includes('hotReloadOnSave'), logged);
    });

    test('does not claim to cover the resource when Hot Reload cannot run', () => {
        // Regression guard. The "Hot Reload covers <resource>" line used to be written whenever the
        // setting was on, so an untrusted workspace produced a log that both reported the blocker
        // and then contradicted it.
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: false,
            settingEnabled: true,
            reloadOnSaveEnabled: true
        }, true);

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        assert.strictEqual(logged.includes('Hot Reload covers'), false, logged);
    });

    test('does not claim to cover a resource that is running without a debugger', () => {
        // Hot Reload is applied by the debugger, so `noDebug` resources are never covered however the
        // settings are configured. Claiming otherwise sends the user hunting for a reload that cannot
        // happen.
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true
        }, false);

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        assert.strictEqual(logged.includes('Hot Reload covers'), false, logged);
        assert.ok(logged.includes('without a debugger'), logged);
    });

    test('says that saving does not apply edits when hotReloadOnSave is off', () => {
        // The gesture is read rather than assumed. Telling a user who turned the setting off that
        // saving applies their edit sends them looking for a reload that never happened.
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingEnabled: true,
            reloadOnSaveEnabled: false
        }, true);

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        assert.ok(logged.includes('Hot Reload covers api'), logged);
        assert.ok(logged.includes('saving does not apply edits'), logged);
    });

    test('reports an untrusted workspace instead of blaming the setting', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: false,
            settingEnabled: true,
            reloadOnSaveEnabled: true
        }, true);

        const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
        assert.ok(logged.includes('limited mode'), logged);
        assert.ok(logged.includes('trusted'), logged);
    });

    test('says nothing at all when C# Dev Kit is not installed', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: false,
            workspaceTrusted: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true
        }, true);

        assert.strictEqual(info.called, false, 'running .NET resources without Dev Kit is fully supported and must not be reported as a problem');
    });

    suite('persisted state', () => {
        // These keys outlive the extension version that wrote them. A rename silently un-suppresses
        // the prompt for every user who already dismissed it, and re-shows the notice to everyone,
        // so the literals are pinned rather than left to be refactored by accident.
        test('pins the memento keys, because renaming one re-prompts every existing user', () => {
            assert.strictEqual(hotReloadPromptSuppressedKey, 'aspire.hotReload.enablePrompt.v1');
            assert.strictEqual(hotReloadSessionNoticeShownKey, 'aspire.hotReload.sessionNotice.v1');
        });

        test('still opens the Hot Reload output when recording that it was shown fails', async () => {
            // The memento write is bookkeeping and happens before the selection is acted on. Losing
            // it must not swallow the button the user actually pressed.
            const failingMemento = createTestMemento();
            sinon.stub(failingMemento, 'update').rejects(new Error('storage is full'));
            initializeHotReloadPromptState({ globalState: failingMemento });
            sinon.stub(vscode.window, 'showInformationMessage').resolves(showHotReloadOutputLabel as unknown as vscode.MessageItem);
            const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();

            announceHotReloadForSessionIfNeeded({
                devKitInstalled: true,
                workspaceTrusted: true,
                settingEnabled: true,
                reloadOnSaveEnabled: true
            }, true, 'launch-1');
            await new Promise(resolve => setTimeout(resolve, 5));

            assert.strictEqual(executeCommand.calledOnceWith('csdevkit.debug.showHotReloadPanel'), true);
        });

        test('writes only to the store it was given', async () => {
            // The store is supplied by activation, which passes `context.globalState`: the setting
            // being offered is machine-scoped, so a workspace-scoped record would re-offer a global
            // setting the user already declined every time they opened another Aspire repo. This
            // pins the half that is reachable from here - nothing writes to any other store behind
            // the caller's back.
            const supplied = createTestMemento();
            const other = createTestMemento();

            initializeHotReloadPromptState({ globalState: supplied });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded({
                devKitInstalled: true,
                workspaceTrusted: true,
                settingEnabled: true,
                reloadOnSaveEnabled: true
            }, true, 'launch-1');
            await new Promise(resolve => setTimeout(resolve, 5));

            assert.strictEqual(notification.called, true);
            assert.strictEqual(supplied.get(hotReloadSessionNoticeShownKey), true);
            assert.strictEqual(other.get(hotReloadSessionNoticeShownKey), undefined);
        });
    });

    suite('active session notice', () => {
        const activeDiagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true
        };

        // The notice body is fire-and-forget so it cannot block the launch path, so let the
        // microtask queue drain before asserting.
        const flush = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };

        test('tells the user Hot Reload is active and how it is triggered', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.callCount, 1);
            assert.strictEqual(notification.firstCall.args[0], hotReloadActiveNotice);
        });

        test('does not tell the user saving applies edits when hotReloadOnSave is off', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, reloadOnSaveEnabled: false }, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.firstCall.args[0], hotReloadActiveNoticeSaveDisabled);
        });

        test('stays quiet in a launch where the user was just offered the setting', async () => {
            // The prompt and the notice describe mutually exclusive states. Resources launch over
            // several seconds, so a resource arriving after the user accepted the prompt reads the
            // new setting value; without this guard it would announce "Hot Reload is enabled"
            // immediately after the prompt said to start debugging again for it to take effect.
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves('Enable Hot Reload' as unknown as vscode.MessageItem);
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                inspect: () => ({ key: 'hotReload', defaultValue: false }),
                update: sinon.stub().resolves()
            } as unknown as vscode.WorkspaceConfiguration);

            await promptToEnableHotReloadIfNeeded({ ...activeDiagnostics, settingEnabled: false }, true, 'launch-1');
            const callsAfterPrompt = notification.callCount;

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.callCount, callsAfterPrompt, 'the notice must not follow the enable prompt in the same launch');
        });

        test('speaks for the next launch after the user enabled the setting', async () => {
            // The other half of the exclusion above, and the case that matters most: the prompt tells
            // the user to start debugging again, so the launch they start next is exactly when the
            // notice should explain what Hot Reload now covers. Suppressing it for the whole window
            // would mean the user does as they were told and is met with silence.
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves('Enable Hot Reload' as unknown as vscode.MessageItem);
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                inspect: () => ({ key: 'hotReload', defaultValue: false }),
                update: sinon.stub().resolves()
            } as unknown as vscode.WorkspaceConfiguration);

            await promptToEnableHotReloadIfNeeded({ ...activeDiagnostics, settingEnabled: false }, true, 'launch-1');
            const callsAfterPrompt = notification.callCount;

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-2');
            await flush();

            assert.strictEqual(notification.callCount, callsAfterPrompt + 1, 'the notice must be shown for the launch started after the prompt');
            assert.strictEqual(notification.lastCall.args[0], hotReloadActiveNotice);
        });

        test('is recorded as shown only once the user has actually been shown it', async () => {
            // The memento is the one-time-ever record. Writing it before the notification resolves
            // burns it for a notice the user may never see - Do Not Disturb, or a window closed
            // while the app is still launching.
            const memento = createTestMemento();
            initializeHotReloadPromptState({ globalState: memento });
            let resolveNotice: ((value: string | undefined) => void) | undefined;
            sinon.stub(vscode.window, 'showInformationMessage')
                .returns(new Promise<string | undefined>(resolve => { resolveNotice = resolve; }) as unknown as Thenable<vscode.MessageItem | undefined>);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(memento.get(hotReloadSessionNoticeShownKey), undefined, 'nothing may be persisted while the notice is still pending');

            resolveNotice?.(undefined);
            await flush();

            assert.strictEqual(memento.get(hotReloadSessionNoticeShownKey), true);
        });

        test('does not leave an unhandled rejection when the notification itself fails', async () => {
            // The body is fire-and-forget, so a rejection escaping it has no owner and surfaces as an
            // extension error on a path the user never asked for.
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            sinon.stub(vscode.window, 'showInformationMessage').rejects(new Error('notifications are unavailable'));
            const warn = sinon.stub(extensionLogOutputChannel, 'warn');

            const unhandled: unknown[] = [];
            const capture = (reason: unknown) => unhandled.push(reason);
            process.on('unhandledRejection', capture);
            try {
                announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
                await flush();
                await flush();
            }
            finally {
                process.off('unhandledRejection', capture);
            }

            assert.deepStrictEqual(unhandled, []);
            assert.strictEqual(warn.called, true, 'the failure belongs in the log, not in the user\'s face');
        });

        test('makes no claim that depends on how many resources have launched', () => {
            // Regression guard. An earlier version counted the resources seen so far and announced
            // "1 .NET resource(s)" for a three-resource app, because Aspire launches resources as
            // independent requests spread over seconds rather than all at once. Any count or list
            // in this string is wrong for whichever resources had not started yet.
            assert.strictEqual(/\d/.test(hotReloadActiveNotice), false, hotReloadActiveNotice);
        });

        test('is raised once per launch burst, not once per resource', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            // Concurrent launches: the guard has to be set before the first await, or a five-project
            // app produces five identical notices.
            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.callCount, 1);
        });

        test('is shown once ever, not once per window', async () => {
            const memento = createTestMemento();
            await memento.update(hotReloadSessionNoticeShownKey, true);
            initializeHotReloadPromptState({ globalState: memento });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.called, false);
        });

        test('records that it was shown so a later window stays quiet', async () => {
            const memento = createTestMemento();
            initializeHotReloadPromptState({ globalState: memento });
            sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(memento.get<boolean>(hotReloadSessionNoticeShownKey, false), true);
        });

        test('opens the Dev Kit Hot Reload output when the user asks for it', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            sinon.stub(vscode.window, 'showInformationMessage').resolves('Show Hot Reload Output' as unknown as vscode.MessageItem);
            const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();

            assert.strictEqual(executeCommand.calledWith('csdevkit.debug.showHotReloadPanel'), true);
        });

        test('survives Dev Kit not having the Hot Reload panel command', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            sinon.stub(vscode.window, 'showInformationMessage').resolves('Show Hot Reload Output' as unknown as vscode.MessageItem);
            sinon.stub(vscode.commands, 'executeCommand').rejects(new Error('command not found'));

            announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
            await flush();
        });

        test('stays silent when Hot Reload is off, since the enable prompt covers that case', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, settingEnabled: false }, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.called, false);
        });

        test('stays silent for a non-debug session and without a usable Dev Kit', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            announceHotReloadForSessionIfNeeded(activeDiagnostics, false, 'launch-1');
            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, devKitInstalled: false }, true, 'launch-1');
            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, workspaceTrusted: false }, true, 'launch-1');
            announceHotReloadForSessionIfNeeded({ ...activeDiagnostics, settingEnabled: false }, true, 'launch-1');
            await flush();

            assert.strictEqual(notification.called, false);
        });

        test('does not notify per reload, because Dev Kit exposes no reload result', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

            // Stands in for a developer saving repeatedly during a session. Hot Reload runs on every
            // save ('csharp.debug.hotReloadOnSave' defaults to true), so anything that notified per
            // reload would be unusable.
            for (let i = 0; i < 25; i++) {
                announceHotReloadForSessionIfNeeded(activeDiagnostics, true, 'launch-1');
                await flush();
            }

            assert.strictEqual(notification.callCount, 1);
        });
    });

    suite('enable prompt', () => {
        const enabledDiagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true
        };

        function stubPrompt(selection: string | undefined): sinon.SinonStub {
            return sinon.stub(vscode.window, 'showInformationMessage').resolves(selection as unknown as vscode.MessageItem);
        }

        /**
         * Models an installed Dev Kit that contributes the gate with the gate turned off. The
         * `inspect` result is what separates "Dev Kit ships this and it is off" from "no installed
         * extension declares this key", and the prompt refuses to offer the latter.
         */
        function stubContributedSettingOff(): sinon.SinonStub {
            const update = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                inspect: () => ({ key: 'hotReload', defaultValue: false }),
                update
            } as unknown as vscode.WorkspaceConfiguration);

            return update;
        }

        test('does not offer to enable a setting no installed extension declares', async () => {
            // The gate is explicitly experimental, and experimental settings get renamed. Offering it
            // after a rename would write a key nothing reads into the user's settings and then report
            // success - a promise Aspire cannot keep.
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const prompt = stubPrompt('Enable Hot Reload');
            const update = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => undefined,
                inspect: () => undefined,
                update
            } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            assert.strictEqual(enabled, false);
            assert.strictEqual(prompt.called, false);
            assert.strictEqual(update.called, false, 'a key nothing declares must never be written');
        });

        test('names the setting in the log when the user dismisses the offer for good', async () => {
            // The dismissal is global and there is no reset command, so the log has to be the escape
            // hatch for a user who clicked it by accident.
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            stubContributedSettingOff();
            stubPrompt("Don't Show Again");
            const info = sinon.stub(extensionLogOutputChannel, 'info');

            await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            const logged = info.getCalls().map(call => String(call.args[0])).join('\n');
            assert.ok(logged.includes('csharp.experimental.debug.hotReload'), logged);
        });

        test('offers to enable Hot Reload when Dev Kit is present but the setting is off', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const prompt = stubPrompt('Enable Hot Reload');
            const update = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: () => false, inspect: () => ({ key: 'hotReload', defaultValue: false }), update } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            assert.strictEqual(enabled, true);
            // Two messages are shown: the offer, then the confirmation that it takes effect on the
            // next session. Assert on the offer specifically rather than the call count.
            assert.strictEqual(prompt.firstCall.args[0], hotReloadAvailablePrompt);
            assert.strictEqual(prompt.lastCall.args[0], hotReloadEnabled);
            // The setting is machine-scoped, so a workspace-scoped write would be silently discarded.
            assert.deepStrictEqual(update.firstCall.args, ['hotReload', true, vscode.ConfigurationTarget.Global]);
        });

        test('only prompts once even when several project resources launch together', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            stubContributedSettingOff();

            // Genuinely concurrent, with a prompt that does not settle until every caller has
            // entered the function. An Aspire app launches its resources in parallel, so awaiting
            // the calls one at a time would pass even if the "already prompted" guard were placed
            // after the first await, which is exactly the bug worth catching.
            let resolvePrompt: ((value: string | undefined) => void) | undefined;
            const pending = new Promise<string | undefined>(resolve => { resolvePrompt = resolve; });
            const prompt = sinon.stub(vscode.window, 'showInformationMessage').returns(pending as unknown as Thenable<vscode.MessageItem | undefined>);

            const inFlight = Promise.all([
                promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1'),
                promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1'),
                promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1')
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
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            const prompt = stubPrompt('Enable Hot Reload');

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, false, 'launch-1');

            assert.strictEqual(enabled, false);
            assert.strictEqual(prompt.called, false);
        });

        test('still confirms the setting was enabled when persisting the dismissal fails', async () => {
            // The memento write is bookkeeping. Losing it must not skip the confirmation telling the
            // user to restart, because the setting itself was written successfully.
            const failingMemento = createTestMemento();
            sinon.stub(failingMemento, 'update').rejects(new Error('storage is full'));
            initializeHotReloadPromptState({ globalState: failingMemento });
            const prompt = stubPrompt('Enable Hot Reload');
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                inspect: () => ({ key: 'hotReload', defaultValue: false }),
                update: async () => undefined
            } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            assert.strictEqual(enabled, true);
            assert.strictEqual(prompt.lastCall.args[0], hotReloadEnabled);
        });

        test('stops offering after the user dismisses it permanently', async () => {
            const memento = createTestMemento();
            initializeHotReloadPromptState({ globalState: memento });
            stubContributedSettingOff();
            stubPrompt("Don't Show Again");

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            assert.strictEqual(enabled, false);
            assert.strictEqual(memento.get(hotReloadPromptSuppressedKey), true);
        });

        test('does not prompt again in a later window once suppressed', async () => {
            const memento = createTestMemento();
            await memento.update(hotReloadPromptSuppressedKey, true);
            initializeHotReloadPromptState({ globalState: memento });
            const prompt = stubPrompt('Enable Hot Reload');

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            assert.strictEqual(enabled, false);
            assert.strictEqual(prompt.called, false);
        });

        test('stays silent for cases where enabling the setting would not help', async () => {
            const cases: { name: string; diagnostics: typeof enabledDiagnostics; isDebug: boolean }[] = [
                { name: 'Dev Kit not installed', diagnostics: { ...enabledDiagnostics, devKitInstalled: false }, isDebug: true },
                { name: 'untrusted workspace', diagnostics: { ...enabledDiagnostics, workspaceTrusted: false }, isDebug: true },
                { name: 'setting already enabled', diagnostics: { ...enabledDiagnostics, settingEnabled: true }, isDebug: true },
                { name: 'run without debugging', diagnostics: enabledDiagnostics, isDebug: false }
            ];

            for (const testCase of cases) {
                sinon.restore();
                initializeHotReloadPromptState({ globalState: createTestMemento() });
                const prompt = stubPrompt('Enable Hot Reload');

                const enabled = await promptToEnableHotReloadIfNeeded(testCase.diagnostics, testCase.isDebug, 'launch-1');

                assert.strictEqual(enabled, false, testCase.name);
                assert.strictEqual(prompt.called, false, testCase.name);
            }
        });

        test('reports failure instead of claiming success when the setting cannot be written', async () => {
            initializeHotReloadPromptState({ globalState: createTestMemento() });
            stubPrompt('Enable Hot Reload');
            const error = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => false,
                inspect: () => ({ key: 'hotReload', defaultValue: false }),
                update: sinon.stub().rejects(new Error('settings are read-only'))
            } as unknown as vscode.WorkspaceConfiguration);

            const enabled = await promptToEnableHotReloadIfNeeded(enabledDiagnostics, true, 'launch-1');

            assert.strictEqual(enabled, false);
            assert.strictEqual(error.calledOnce, true);
        });
    });
});
