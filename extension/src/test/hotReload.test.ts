import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getHotReloadDiagnostics, initializeHotReloadNotificationState, isHotReloadOnSaveEnabled, isHotReloadSettingEnabled, logHotReloadDiagnostics, showHotReloadNotificationIfNeeded } from '../debugger/hotReload';
import { createHotReloadTestConfiguration, createTestMemento } from './common';
import { dontShowAgainLabel, enableHotReloadLabel, hotReloadActiveNotice, hotReloadActiveNoticeSaveDisabled, hotReloadDisabledNotice, hotReloadEnabledConfirmation, hotReloadEnableFailed, hotReloadOutputUnavailable, showHotReloadOutputLabel } from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';
import { getNotificationSuppressionKey, isNotificationSuppressed } from '../utils/notificationSuppression';

suite('Hot Reload Tests', () => {
    teardown(() => sinon.restore());

    function stubDevKit(): void {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
            if (extensionId !== 'ms-dotnettools.csdevkit') {
                return undefined;
            }

            return { id: extensionId, isActive: false } as unknown as vscode.Extension<unknown>;
        });
    }

    function stubNoExtensions(): void {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
    }

    function stubHotReloadSettings(options: { enabled?: boolean; onSave?: boolean; contributed?: boolean } = {}): sinon.SinonStub {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns(createHotReloadTestConfiguration({
            get: (name: string) => name === 'hotReload' ? options.enabled : undefined,
        }, { contributed: options.contributed }));
        getConfiguration.withArgs('csharp.debug').returns({
            get: (name: string) => name === 'hotReloadOnSave' ? options.onSave : undefined,
        } as vscode.WorkspaceConfiguration);
        getConfiguration.returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);
        return getConfiguration;
    }

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
        stubWorkspaceTrust(true);
        stubHotReloadSettings({ enabled: true, contributed: true });

        const diagnostics = getHotReloadDiagnostics();

        assert.strictEqual(diagnostics.devKitInstalled, false);
    });

    test('reports when Dev Kit no longer contributes the experimental setting', () => {
        stubDevKit();
        stubWorkspaceTrust(true);
        stubHotReloadSettings({ enabled: false, contributed: false });

        const diagnostics = getHotReloadDiagnostics();

        assert.strictEqual(diagnostics.settingContributed, false);
        assert.strictEqual(diagnostics.settingEnabled, false);
    });

    test('reads the effective Hot Reload settings without activating C# Dev Kit', () => {
        stubDevKit();
        stubWorkspaceTrust(true);
        stubHotReloadSettings({ enabled: true, onSave: false, contributed: true });

        assert.strictEqual(isHotReloadSettingEnabled(), true);
        assert.strictEqual(isHotReloadOnSaveEnabled(), false);
        assert.deepStrictEqual(getHotReloadDiagnostics(), {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: false,
        });
    });

    test('logs per-resource state without claiming Hot Reload covers run-only sessions', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        }, false);

        assert.deepStrictEqual(info.getCalls().map(call => String(call.args[0])), [
            'Hot Reload state for api: workspaceTrusted=true, settingContributed=true, '
            + 'csharp.experimental.debug.hotReload=true, csharp.debug.hotReloadOnSave=true',
            'api is running without a debugger, so Hot Reload does not apply to it.'
        ]);
    });

    test('still reports a run-only resource when the Hot Reload setting is off', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, false);

        // The disabled reason on its own would imply that enabling the setting is enough to cover this
        // resource, which it is not while the resource runs without a debugger.
        assert.deepStrictEqual(info.getCalls().map(call => String(call.args[0])), [
            'Hot Reload state for api: workspaceTrusted=true, settingContributed=true, '
            + 'csharp.experimental.debug.hotReload=false, csharp.debug.hotReloadOnSave=true',
            "Hot Reload is disabled because 'csharp.experimental.debug.hotReload' is not enabled in user settings.",
            'api is running without a debugger, so Hot Reload does not apply to it.'
        ]);
    });

    test('reports Hot Reload as configured rather than already applied', () => {
        const info = sinon.stub(extensionLogOutputChannel, 'info');

        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        }, true);

        // This runs before the debug session is created, so the log may only state what is expected.
        assert.deepStrictEqual(info.getCalls().map(call => String(call.args[0])), [
            'Hot Reload state for api: workspaceTrusted=true, settingContributed=true, '
            + 'csharp.experimental.debug.hotReload=true, csharp.debug.hotReloadOnSave=true',
            'Hot Reload is configured for api and can apply once C# Dev Kit starts the session, where the debug engine supports it. '
            + "Saving a file asks Dev Kit to apply the edit ('csharp.debug.hotReloadOnSave'); the toolbar button applies pending edits "
            + "across .NET resources at once. Dev Kit reports what it actually applied in the '.NET Hot Reload' output channel."
        ]);
    });

    test('does not show a misleading disabled notification when the Dev Kit setting is absent', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: false,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);

        assert.strictEqual(notification.called, false);
    });

    test('offers to enable Hot Reload globally when disabled', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const update = sinon.stub().resolves();
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns(createHotReloadTestConfiguration({ update }, { contributed: true }));
        getConfiguration.returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(enableHotReloadLabel as unknown as vscode.MessageItem);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);

        assert.deepStrictEqual(notification.firstCall.args, [hotReloadDisabledNotice, enableHotReloadLabel]);
        assert.strictEqual(update.calledOnceWithExactly('hotReload', true, vscode.ConfigurationTarget.Global), true);
    });

    test('announces active Hot Reload and opens the Dev Kit output when requested', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        sinon.stub(vscode.window, 'showInformationMessage').resolves(showHotReloadOutputLabel as unknown as vscode.MessageItem);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        }, true);

        assert.strictEqual(executeCommand.calledOnceWithExactly('csdevkit.debug.showHotReloadPanel'), true);
    });

    test('uses the save-disabled active notice when Dev Kit will not apply edits on save', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: false,
        }, true);

        assert.strictEqual(notification.firstCall.args[0], hotReloadActiveNoticeSaveDisabled);
    });

    test('can show the active notice after the disabled notice in the same window', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        }, true);

        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [
            hotReloadDisabledNotice,
            hotReloadActiveNotice
        ]);
    });

    test('shows each notice at most once per user, not once per window', async () => {
        const globalState = createTestMemento();
        initializeHotReloadNotificationState({ globalState });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        const diagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        };

        await showHotReloadNotificationIfNeeded(diagnostics, true);

        // Same stored state, fresh window: only the persisted flag can suppress the second presentation.
        initializeHotReloadNotificationState({ globalState });
        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [hotReloadActiveNotice]);
    });

    test('confirms that Hot Reload was enabled after the prompt writes the setting', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const update = sinon.stub().resolves();
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns(createHotReloadTestConfiguration({ update }, { contributed: true }));
        getConfiguration.returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);
        const notification = sinon.stub(vscode.window, 'showInformationMessage');
        notification.onFirstCall().resolves(enableHotReloadLabel as unknown as vscode.MessageItem);
        notification.resolves(undefined);

        await showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);

        assert.strictEqual(update.calledOnceWithExactly('hotReload', true, vscode.ConfigurationTarget.Global), true);
        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [
            hotReloadDisabledNotice,
            hotReloadEnabledConfirmation
        ]);
    });

    test('offers the notice again when enabling Hot Reload fails', async () => {
        const globalState = createTestMemento();
        initializeHotReloadNotificationState({ globalState });
        const update = sinon.stub().rejects(new Error('settings file is read-only'));
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns(createHotReloadTestConfiguration({ update }, { contributed: true }));
        getConfiguration.returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);
        const errorNotification = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const notification = sinon.stub(vscode.window, 'showInformationMessage');
        notification.onFirstCall().resolves(enableHotReloadLabel as unknown as vscode.MessageItem);
        notification.resolves(undefined);
        const diagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        };

        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(errorNotification.getCalls().map(call => call.args[0]), [hotReloadEnableFailed]);

        // The user asked for Hot Reload and did not get it, so the single offer this notice gets must
        // not have been consumed. Presenting again in this window proves both the in-window guard and
        // the persisted record were released, since either one alone would still suppress it.
        await showHotReloadNotificationIfNeeded(diagnostics, true);

        // That second presentation did consume the offer, so a later window gets nothing.
        initializeHotReloadNotificationState({ globalState });
        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [
            hotReloadDisabledNotice,
            hotReloadDisabledNotice
        ]);
    });

    test('retires the notice by dismissal alone, without offering or writing a suppression flag', async () => {
        const globalState = createTestMemento();
        initializeHotReloadNotificationState({ globalState });
        // Dismissal, not an action: this is the gesture that has to retire a once-per-user notice.
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        const diagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        };

        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(notification.firstCall.args, [hotReloadDisabledNotice, enableHotReloadLabel]);
        assert.strictEqual(notification.firstCall.args.includes(dontShowAgainLabel), false);
        assert.strictEqual(isNotificationSuppressed(globalState, 'hotReload.disabledNoticeV1'), false);

        // A fresh window: dismissal alone already retired the notice, which is what makes the
        // suppression action redundant rather than merely unused.
        initializeHotReloadNotificationState({ globalState });
        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [hotReloadDisabledNotice]);
        assert.strictEqual(getNotificationSuppressionKey('resourceCommandArguments.secretWarning'), 'resourceCommandArguments.secretWarningSuppressed');
    });

    // The two tests below deliberately let the production code reach the real VS Code APIs instead of
    // stubbing them. They are the most of this flow that can be automated: the notice is gated on C#
    // Dev Kit being installed and on `csharp.experimental.debug.hotReload` being a contributed setting,
    // and neither the Extension Host test instance nor the vscode-extension-tester E2E instance
    // (extension/scripts/run-e2e.js installs only the Aspire VSIX and runs extester --offline) has the
    // ms-dotnettools extensions that supply them, so no harness here can make the toast appear for a
    // UI driver to click. What is reachable is what happens after a click, so that is what these cover.

    test('the active notices claim a setting rather than coverage of every resource', () => {
        // This notice is presented before vscode.debug.startDebugging, from a probe that can only read the
        // global setting: it does not know whether the debug engine will support applying changes, and
        // sibling resources launched with noDebug are excluded from Hot Reload outright. Claiming the app's
        // .NET project resources are covered would therefore be a promise the extension cannot keep, and
        // even for a resource it does debug the notice can only say Hot Reload may apply.
        for (const notice of [hotReloadActiveNotice, hotReloadActiveNoticeSaveDisabled]) {
            assert.ok(
                notice.includes('is turned on in C# Dev Kit') && notice.includes('can apply to the .NET resources you debug'),
                `Notice must scope its claim to the setting and to debugged resources: ${notice}`);
            assert.ok(
                notice.includes('where Dev Kit supports it'),
                `Notice must not present Hot Reload as unconditional: ${notice}`);
            // Dev Kit's hot reload logger creates its channel as
            // `vscode.window.createOutputChannel(".NET Hot Reload", { log: true })`, and that is the channel
            // 'csdevkit.debug.showHotReloadPanel' reveals. 'C# Hot Reload' is only how the
            // 'csharp.experimental.debug.hotReload' setting describes itself, so pointing users at that name
            // would send them looking for a channel that does not exist.
            assert.ok(
                notice.includes('.NET Hot Reload output'),
                `Notice must name the output channel Dev Kit actually creates: ${notice}`);
        }
    });

    test('recovers when VS Code itself refuses to write the Hot Reload setting', async () => {
        const globalState = createTestMemento();
        initializeHotReloadNotificationState({ globalState });

        // Captured before the stub replaces getConfiguration so that `update` below is the real VS Code
        // write, not a test double. It rejects because the setting is only registered by the C# extension,
        // which is exactly the shape of the production failure: Dev Kit disabled or uninstalled while the
        // toast is still up leaves the extension holding an action it can no longer perform.
        const realConfiguration = vscode.workspace.getConfiguration('csharp.experimental.debug');
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns(createHotReloadTestConfiguration({
            get: (name: string) => name === 'hotReload' ? false : undefined,
            update: (section: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null) => realConfiguration.update(section, value, target),
        }, { contributed: true }));
        getConfiguration.returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);

        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(enableHotReloadLabel as unknown as vscode.MessageItem);
        const errorMessage = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const warn = sinon.stub(extensionLogOutputChannel, 'warn');

        const diagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        };

        await showHotReloadNotificationIfNeeded(diagnostics, true);

        // The update above is the real vscode.WorkspaceConfiguration.update, so this warning exists only if VS
        // Code itself rejected the write. What is asserted is the extension's own prefix rather than the text
        // VS Code produced: the rejection message is not part of any API contract and would make this test fail
        // on a wording change that leaves the recovery being tested untouched.
        assert.strictEqual(
            warn.getCalls().some(call => String(call.args[0]).startsWith('Failed to enable Hot Reload: ')),
            true,
            `Expected a real configuration rejection, got: ${JSON.stringify(warn.getCalls().map(call => call.args[0]))}`);
        assert.deepStrictEqual(errorMessage.getCalls().map(call => call.args[0]), [hotReloadEnableFailed]);

        initializeHotReloadNotificationState({ globalState });
        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [hotReloadDisabledNotice, hotReloadDisabledNotice]);
    });

    test('recovers when the Dev Kit Hot Reload output command is not registered', async () => {
        const globalState = createTestMemento();
        initializeHotReloadNotificationState({ globalState });

        // executeCommand is intentionally not stubbed: 'csdevkit.debug.showHotReloadPanel' belongs to Dev
        // Kit, so the real command registry rejects it here the same way it would for a user whose Dev Kit
        // is present but too old to contribute the panel.
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(showHotReloadOutputLabel as unknown as vscode.MessageItem);
        const errorNotification = sinon.stub(vscode.window, 'showErrorMessage');
        const warn = sinon.stub(extensionLogOutputChannel, 'warn');

        const diagnostics = {
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        };

        await showHotReloadNotificationIfNeeded(diagnostics, true);

        // executeCommand is the real one, so this warning exists only if the command registry rejected. The
        // extension's own prefix is asserted rather than VS Code's message for the same reason as above.
        assert.strictEqual(
            warn.getCalls().some(call => String(call.args[0]).startsWith('Failed to show the Hot Reload output: ')),
            true,
            `Expected the real command registry to reject, got: ${JSON.stringify(warn.getCalls().map(call => call.args[0]))}`);

        // The button the user clicked did nothing, so the log alone is not an answer: the failure has to reach
        // the user who asked for the output.
        assert.deepStrictEqual(errorNotification.getCalls().map(call => call.args[0]), [hotReloadOutputUnavailable]);

        initializeHotReloadNotificationState({ globalState });
        await showHotReloadNotificationIfNeeded(diagnostics, true);

        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [hotReloadActiveNotice, hotReloadActiveNotice]);
    });

});
