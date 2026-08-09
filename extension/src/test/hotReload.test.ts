import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getHotReloadDiagnostics, initializeHotReloadNotificationState, isHotReloadOnSaveEnabled, isHotReloadSettingEnabled, logHotReloadDiagnostics, showHotReloadNotificationIfNeeded } from '../debugger/hotReload';
import { createHotReloadTestConfiguration, createTestMemento } from './common';
import { dontShowAgainLabel, enableHotReloadLabel, hotReloadActiveNotice, hotReloadActiveNoticeSaveDisabled, hotReloadDisabledNotice, hotReloadEnabledConfirmation, showHotReloadOutputLabel } from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';
import { getNotificationSuppressionKey, isNotificationSuppressed, showInformationMessageWithDontShowAgain } from '../utils/notificationSuppression';

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
            'Hot Reload is configured for api and applies once C# Dev Kit starts the session. '
            + "Saving a file asks Dev Kit to apply the edit ('csharp.debug.hotReloadOnSave'); the toolbar button applies pending edits "
            + "across .NET resources at once. Dev Kit reports what it actually applied in the '.NET Hot Reload' output channel."
        ]);
    });

    test('does not show a misleading disabled notification when the Dev Kit setting is absent', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: false,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);
        await settleNotifications();

        assert.strictEqual(notification.called, false);
    });

    test('offers to enable Hot Reload globally when disabled', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const update = sinon.stub().resolves();
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns(createHotReloadTestConfiguration({ update }, { contributed: true }));
        getConfiguration.returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(enableHotReloadLabel as unknown as vscode.MessageItem);

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);
        await settleNotifications();

        assert.deepStrictEqual(notification.firstCall.args, [hotReloadDisabledNotice, enableHotReloadLabel, dontShowAgainLabel]);
        assert.strictEqual(update.calledOnceWithExactly('hotReload', true, vscode.ConfigurationTarget.Global), true);
    });

    test('announces active Hot Reload and opens the Dev Kit output when requested', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        sinon.stub(vscode.window, 'showInformationMessage').resolves(showHotReloadOutputLabel as unknown as vscode.MessageItem);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        }, true);
        await settleNotifications();

        assert.strictEqual(executeCommand.calledOnceWithExactly('csdevkit.debug.showHotReloadPanel'), true);
    });

    test('uses the save-disabled active notice when Dev Kit will not apply edits on save', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: false,
        }, true);
        await settleNotifications();

        assert.strictEqual(notification.firstCall.args[0], hotReloadActiveNoticeSaveDisabled);
    });

    test('can show the active notice after the disabled notice in the same window', async () => {
        initializeHotReloadNotificationState({ globalState: createTestMemento() });
        const notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);
        await settleNotifications();

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: true,
            reloadOnSaveEnabled: true,
        }, true);
        await settleNotifications();

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

        showHotReloadNotificationIfNeeded(diagnostics, true);
        await settleNotifications();

        // Same stored state, fresh window: only the persisted flag can suppress the second presentation.
        initializeHotReloadNotificationState({ globalState });
        showHotReloadNotificationIfNeeded(diagnostics, true);
        await settleNotifications();

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

        showHotReloadNotificationIfNeeded({
            devKitInstalled: true,
            workspaceTrusted: true,
            settingContributed: true,
            settingEnabled: false,
            reloadOnSaveEnabled: true,
        }, true);
        await settleNotifications();

        assert.strictEqual(update.calledOnceWithExactly('hotReload', true, vscode.ConfigurationTarget.Global), true);
        assert.deepStrictEqual(notification.getCalls().map(call => call.args[0]), [
            hotReloadDisabledNotice,
            hotReloadEnabledConfirmation
        ]);
    });

    test('uses shared suppression keys and the shared Dont Show Again action', async () => {
        const memento = createTestMemento();
        const notification = sinon.stub().resolves(dontShowAgainLabel);

        const selection = await showInformationMessageWithDontShowAgain({
            memento,
            notificationName: 'hotReload.disabledNoticeV1',
            message: 'message',
            items: ['Action'],
            showInformationMessage: notification
        });

        assert.strictEqual(selection, dontShowAgainLabel);
        assert.strictEqual(getNotificationSuppressionKey('resourceCommandArguments.secretWarning'), 'resourceCommandArguments.secretWarningSuppressed');
        assert.strictEqual(isNotificationSuppressed(memento, 'hotReload.disabledNoticeV1'), true);
        assert.deepStrictEqual(notification.firstCall.args, ['message', 'Action', dontShowAgainLabel]);
    });

    async function settleNotifications(): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
});
