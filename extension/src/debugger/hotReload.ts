import * as vscode from 'vscode';
import { isCsDevKitInstalled } from '../capabilities';
import { extensionLogOutputChannel } from '../utils/logging';
import { enableHotReloadLabel, hotReloadActiveNotice, hotReloadActiveNoticeSaveDisabled, hotReloadDisabledNotice, hotReloadEnabledConfirmation, hotReloadEnableFailed, showHotReloadOutputLabel } from '../loc/strings';
import { clearNotificationShown, hasNotificationBeenShown, markNotificationShown } from '../utils/notificationSuppression';

const hotReloadConfigurationSection = 'csharp.experimental.debug';
const hotReloadConfigurationName = 'hotReload';
const hotReloadOnSaveConfigurationSection = 'csharp.debug';
const hotReloadOnSaveConfigurationName = 'hotReloadOnSave';

const hotReloadDisabledNoticeName = 'hotReload.disabledNoticeV1';
const hotReloadActiveNoticeName = 'hotReload.activeNoticeV1';
const showHotReloadPanelCommand = 'csdevkit.debug.showHotReloadPanel';

export interface HotReloadDiagnostics {
    devKitInstalled: boolean;
    workspaceTrusted: boolean;
    settingContributed: boolean;
    settingEnabled: boolean;
    reloadOnSaveEnabled: boolean;
}

export function isHotReloadSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration(hotReloadConfigurationSection).get<boolean>(hotReloadConfigurationName) === true;
}

function isHotReloadSettingContributed(): boolean {
    return vscode.workspace
        .getConfiguration(hotReloadConfigurationSection)
        .inspect<boolean>(hotReloadConfigurationName)?.defaultValue !== undefined;
}

export function isHotReloadOnSaveEnabled(): boolean {
    return vscode.workspace.getConfiguration(hotReloadOnSaveConfigurationSection).get<boolean>(hotReloadOnSaveConfigurationName) !== false;
}

export function getHotReloadDiagnostics(): HotReloadDiagnostics {
    return {
        devKitInstalled: isCsDevKitInstalled(),
        workspaceTrusted: vscode.workspace.isTrusted,
        settingContributed: isHotReloadSettingContributed(),
        settingEnabled: isHotReloadSettingEnabled(),
        reloadOnSaveEnabled: isHotReloadOnSaveEnabled()
    };
}

function isHotReloadExpected(diagnostics: HotReloadDiagnostics): boolean {
    return diagnostics.devKitInstalled
        && diagnostics.workspaceTrusted
        && diagnostics.settingContributed
        && diagnostics.settingEnabled;
}

/**
 * Writes the per-launch Hot Reload state to the output channel.
 *
 * `resourceIdentifier` has to distinguish one launch from another, not just name a project: several
 * resources launch at once and their diagnostics interleave in a single channel.
 */
export function logHotReloadDiagnostics(resourceIdentifier: string, diagnostics: HotReloadDiagnostics, isDebugSession: boolean): void {
    if (!diagnostics.devKitInstalled) {
        return;
    }

    extensionLogOutputChannel.info(
        `Hot Reload state for ${resourceIdentifier}: workspaceTrusted=${diagnostics.workspaceTrusted}, ` +
        `settingContributed=${diagnostics.settingContributed}, ` +
        `csharp.experimental.debug.hotReload=${diagnostics.settingEnabled}, ` +
        `csharp.debug.hotReloadOnSave=${diagnostics.reloadOnSaveEnabled}`);

    if (!diagnostics.workspaceTrusted) {
        extensionLogOutputChannel.info(
            'The workspace is not trusted, so C# Dev Kit activates in limited mode and Hot Reload is unavailable.');
    }

    if (!diagnostics.settingContributed) {
        extensionLogOutputChannel.info(
            `'${hotReloadConfigurationSection}.${hotReloadConfigurationName}' is not contributed by any installed extension, so Hot Reload cannot be reported.`);
    }

    if (diagnostics.workspaceTrusted && diagnostics.settingContributed && !diagnostics.settingEnabled) {
        extensionLogOutputChannel.info(
            "Hot Reload is disabled because 'csharp.experimental.debug.hotReload' is not enabled in user settings.");
    }

    // Reported before the prerequisite gate below so a run-only resource still says so. Otherwise the
    // per-resource output would stop at "Hot Reload is disabled because ...", implying that flipping the
    // setting is enough to cover a resource that is not being debugged at all.
    if (!isDebugSession) {
        extensionLogOutputChannel.info(
            `${resourceIdentifier} is running without a debugger, so Hot Reload does not apply to it.`);
        return;
    }

    if (!isHotReloadExpected(diagnostics)) {
        return;
    }

    const gesture = diagnostics.reloadOnSaveEnabled
        ? "Saving a file asks Dev Kit to apply the edit ('csharp.debug.hotReloadOnSave'); the toolbar button applies pending edits"
        : "'csharp.debug.hotReloadOnSave' is off, so saving does not apply edits; the toolbar button applies pending edits";

    // Reported as configured rather than covered: this runs before vscode.debug.startDebugging, so the
    // settings only establish what is expected. Whether Hot Reload actually attaches depends on the
    // launch succeeding and on the target debugger engine supporting applying changes, and only Dev Kit
    // can answer that.
    //
    // The channel really is named '.NET Hot Reload', not 'C# Hot Reload'. Dev Kit's hot reload logger
    // creates it as `vscode.window.createOutputChannel(".NET Hot Reload", { log: true })`, and the
    // 'csdevkit.debug.showHotReloadPanel' command reveals that same channel. 'C# Hot Reload' is the
    // wording of the 'csharp.experimental.debug.hotReload' setting description, not a channel name.
    extensionLogOutputChannel.info(
        `Hot Reload is configured for ${resourceIdentifier} and can apply once C# Dev Kit starts the session, where the debug engine supports it. ${gesture} across .NET resources at once. ` +
        "Dev Kit reports what it actually applied in the '.NET Hot Reload' output channel.");
}

let hotReloadNotificationState: vscode.Memento | undefined;
let hotReloadNotificationStateMissingLogged = false;
const hotReloadNotificationsShownThisWindow = new Set<string>();

export function initializeHotReloadNotificationState(context: { globalState: vscode.Memento } | undefined): void {
    hotReloadNotificationState = context?.globalState;
    hotReloadNotificationStateMissingLogged = false;
    hotReloadNotificationsShownThisWindow.clear();
}

/**
 * Presents the Hot Reload notice for a resource that is about to be debugged, if one is due.
 *
 * The returned promise settles when the notice has been answered and acted on. Production launches
 * discard it - a notification stays up until the user interacts with it, and this runs before the
 * debug session is created - but returning it is what lets tests wait for the work instead of
 * guessing at a delay, and a guessed delay is a race as soon as the work touches a real VS Code API.
 */
export function showHotReloadNotificationIfNeeded(diagnostics: HotReloadDiagnostics, isDebugSession: boolean): Promise<void> {
    if (!isDebugSession) {
        return Promise.resolve();
    }

    const notice = getHotReloadNotice(diagnostics);
    if (!notice
        || hotReloadNotificationsShownThisWindow.has(notice.name)
        || hasNotificationBeenShown(hotReloadNotificationState, notice.name)) {
        return Promise.resolve();
    }

    // The in-window set is the synchronous guard: several resources launch at once, and the persisted
    // flag below is only readable after its await resolves, so it cannot deduplicate that burst.
    hotReloadNotificationsShownThisWindow.add(notice.name);

    if (hotReloadNotificationState === undefined && !hotReloadNotificationStateMissingLogged) {
        hotReloadNotificationStateMissingLogged = true;
        extensionLogOutputChannel.warn('Hot Reload notification state was never initialized; a dismissal will not persist across windows.');
    }

    return (async () => {
        try {
            // Recorded before the notification is presented rather than after it is answered. Each notice
            // is offered at most once per user, and a window that closes while the notification is still
            // up has already used that one chance.
            await markNotificationShown(hotReloadNotificationState, notice.name);

            // No "Don't show again" action here. The record above already limits each notice to one
            // presentation per user, so that button would promise a choice the user does not have:
            // dismissing the toast suppresses the notice just as permanently as clicking it. It would
            // also cost a slot in a toast that VS Code collapses into an overflow menu, pushing the
            // action the notice exists for out of sight.
            const selection = await vscode.window.showInformationMessage(notice.message, ...notice.actions);

            if (selection === showHotReloadOutputLabel) {
                await vscode.commands.executeCommand(showHotReloadPanelCommand);
            }

            if (selection === enableHotReloadLabel) {
                try {
                    await vscode.workspace
                        .getConfiguration(hotReloadConfigurationSection)
                        .update(hotReloadConfigurationName, true, vscode.ConfigurationTarget.Global);

                    // The resource this prompt came from has already launched with the old setting, and the
                    // prompt is fire-and-forget, so without this a single-resource app gives no sign that the
                    // setting took effect or that another debug start is needed to use it.
                    void vscode.window.showInformationMessage(hotReloadEnabledConfirmation);
                }
                catch (err) {
                    extensionLogOutputChannel.warn(`Failed to enable Hot Reload: ${err instanceof Error ? err.message : String(err)}`);

                    // The user asked for Hot Reload and got nothing. Reporting the failure and releasing the
                    // shown record is what makes that recoverable: this notice is offered at most once per
                    // user, so leaving the record in place would spend that one offer on a write that failed.
                    void vscode.window.showErrorMessage(hotReloadEnableFailed);
                    await releaseNotificationOffer(notice.name);
                }
            }
        }
        catch (err) {
            extensionLogOutputChannel.warn(`Hot Reload notification failed: ${err instanceof Error ? err.message : String(err)}`);

            // The notice is recorded as shown before it is presented, so an attempt that never reached the
            // user must give that record back rather than silently consuming the single offer.
            await releaseNotificationOffer(notice.name);
        }
    })();
}

async function releaseNotificationOffer(notificationName: string): Promise<void> {
    hotReloadNotificationsShownThisWindow.delete(notificationName);

    try {
        await clearNotificationShown(hotReloadNotificationState, notificationName);
    }
    catch (err) {
        // Best effort: the storage write that recorded the notice as shown is the same one being undone
        // here, so if it is failing there is nothing further this code can do about it.
        extensionLogOutputChannel.warn(`Failed to reset Hot Reload notification state: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function getHotReloadNotice(diagnostics: HotReloadDiagnostics): { name: string; message: string; actions: string[] } | undefined {
    if (!diagnostics.devKitInstalled || !diagnostics.workspaceTrusted || !diagnostics.settingContributed) {
        return undefined;
    }

    if (!diagnostics.settingEnabled) {
        return { name: hotReloadDisabledNoticeName, message: hotReloadDisabledNotice, actions: [enableHotReloadLabel] };
    }

    const message = diagnostics.reloadOnSaveEnabled ? hotReloadActiveNotice : hotReloadActiveNoticeSaveDisabled;
    return { name: hotReloadActiveNoticeName, message, actions: [showHotReloadOutputLabel] };
}
