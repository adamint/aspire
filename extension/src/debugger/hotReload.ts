import * as vscode from 'vscode';
import { isCsDevKitInstalled } from '../capabilities';
import { extensionLogOutputChannel } from '../utils/logging';
import { dontShowAgainLabel, enableHotReloadLabel, hotReloadActiveNotice, hotReloadActiveNoticeSaveDisabled, hotReloadAvailablePrompt, hotReloadEnableFailed, hotReloadEnabled, showHotReloadOutputLabel } from '../loc/strings';
import { hotReloadPromptSuppressedKey, hotReloadSessionNoticeShownKey } from '../utils/hotReloadNotificationState';


// C# Dev Kit reads the master Hot Reload gate as
// `workspace.getConfiguration('csharp.experimental.debug').get('hotReload')`, so the section and
// name are split the same way here to stay consistent with how the setting is actually resolved.
// The setting is declared with `"scope": "machine"`, which means VS Code silently ignores it when
// it is placed in workspace settings — it only takes effect from user/machine settings.
const hotReloadConfigurationSection = 'csharp.experimental.debug';
const hotReloadConfigurationName = 'hotReload';

// Dev Kit applies an edit on save only when this is on. It defaults to true and is also
// machine-scoped. It is read because every message this file shows would otherwise assert that
// saving applies changes, which is simply false for a user who turned it off.
const hotReloadOnSaveConfigurationSection = 'csharp.debug';
const hotReloadOnSaveConfigurationName = 'hotReloadOnSave';

/**
 * Describes why Hot Reload is or is not expected to be available for .NET resources, so the state is
 * discoverable from the Aspire log instead of the user only seeing a missing toolbar button.
 */
export interface HotReloadDiagnostics {
    devKitInstalled: boolean;
    /**
     * Hot Reload cannot work in an untrusted workspace, so there is no point telling the user how to
     * turn it on there.
     *
     * Read from VS Code rather than from Dev Kit's `isLimitedActivation` export, even though Dev Kit
     * does export it. Dev Kit derives that flag from exactly this value — its activation returns
     * `{ isLimitedActivation: true }` and nothing else when `!vscode.workspace.isTrusted` — so the
     * two are equivalent, but the export is only readable once Dev Kit has finished activating.
     * Reading trust directly keeps this check correct when a resource launches before Dev Kit has
     * activated, which is otherwise a silent no-op on a cold start.
     */
    workspaceTrusted: boolean;
    settingEnabled: boolean;
    /** Whether saving a file asks Dev Kit to apply the edit, or only the toolbar button does. */
    reloadOnSaveEnabled: boolean;
}

/**
 * Returns whether the user has opted into C# Dev Kit's experimental Hot Reload gate.
 */
export function isHotReloadSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration(hotReloadConfigurationSection).get<boolean>(hotReloadConfigurationName) === true;
}

/**
 * Returns whether the Hot Reload gate is a setting that some installed extension actually
 * contributes.
 *
 * `get()` cannot answer this: an unknown configuration key reads back as `undefined`, which is
 * indistinguishable from a contributed setting the user has not set. `inspect()` reports a
 * `defaultValue` only for a key that some installed extension declares, so this separates "Dev Kit
 * ships this gate and it is off" from "no installed extension has ever heard of this key".
 *
 * The distinction matters because the gate is explicitly `experimental`, and experimental settings
 * get renamed. Without this check, a rename would make Aspire offer to enable Hot Reload, write a
 * key nothing reads into the user's settings, and report success — a promise it cannot keep.
 */
function isHotReloadSettingContributed(): boolean {
    return vscode.workspace
        .getConfiguration(hotReloadConfigurationSection)
        .inspect<boolean>(hotReloadConfigurationName)?.defaultValue !== undefined;
}

function isHotReloadSettingContributedWithDiagnostic(): boolean {
    const contributed = isHotReloadSettingContributed();
    if (!contributed && !hotReloadSettingMissingLoggedThisWindow) {
        hotReloadSettingMissingLoggedThisWindow = true;
        extensionLogOutputChannel.info(
            `'${hotReloadConfigurationSection}.${hotReloadConfigurationName}' is not contributed by any installed extension, so Hot Reload cannot be offered.`);
    }

    return contributed;
}

/**
 * Returns whether Dev Kit applies Hot Reload edits on save. Defaults to true in Dev Kit.
 */
export function isHotReloadOnSaveEnabled(): boolean {
    return vscode.workspace.getConfiguration(hotReloadOnSaveConfigurationSection).get<boolean>(hotReloadOnSaveConfigurationName) !== false;
}

/**
 * Reads whether Hot Reload can work for .NET resources in this window.
 *
 * Hot Reload itself is entirely implemented by C# Dev Kit and vsdbg: Dev Kit produces Roslyn
 * Edit-and-Continue deltas and hands them to vsdbg over its own brokered service connection, and the
 * C# extension wires that connection up during `coreclr` configuration resolution. Aspire launches
 * `coreclr` sessions like any other client, so it inherits that machinery for free and has nothing
 * to configure. The one thing Aspire can usefully do is notice that the feature is switched off and
 * say so, which is what these diagnostics drive.
 *
 * This deliberately does not read Dev Kit's exports or call `activate()` on it. Forcing activation
 * from the resource launch path would add startup cost for a purely optional enhancement, and
 * waiting for it would make the whole feature depend on whether Dev Kit happened to finish
 * activating before the first resource launched.
 */
export function getHotReloadDiagnostics(): HotReloadDiagnostics {
    return {
        devKitInstalled: isCsDevKitInstalled(),
        workspaceTrusted: vscode.workspace.isTrusted,
        settingEnabled: isHotReloadSettingEnabled(),
        reloadOnSaveEnabled: isHotReloadOnSaveEnabled()
    };
}

const maxTrackedHotReloadLaunches = 64;

interface HotReloadLaunchState {
    diagnostics: HotReloadDiagnostics;
    messageShown: boolean;
}

const hotReloadLaunchStates = new Map<string, HotReloadLaunchState>();

function getOrCreateHotReloadLaunchState(launchId: string, diagnostics: HotReloadDiagnostics): HotReloadLaunchState {
    const existing = hotReloadLaunchStates.get(launchId);
    if (existing) {
        return existing;
    }

    // Aspire debug-session ids are unique per launch, but the extension can stay active for many
    // runs. Bound the snapshots so a long-lived window cannot accumulate state forever. Evicting
    // the oldest of 64 launches still leaves ample room for concurrently running Aspire apps.
    if (hotReloadLaunchStates.size >= maxTrackedHotReloadLaunches) {
        const oldestLaunchId = hotReloadLaunchStates.keys().next().value;
        if (oldestLaunchId !== undefined) {
            hotReloadLaunchStates.delete(oldestLaunchId);
        }
    }

    const state: HotReloadLaunchState = {
        diagnostics: { ...diagnostics },
        messageShown: false
    };
    hotReloadLaunchStates.set(launchId, state);

    return state;
}

/**
 * Captures Hot Reload state on the first resource observed for an Aspire launch.
 *
 * Machine settings are global and can change while two Aspire apps are starting concurrently. A
 * launch that began with Hot Reload disabled must not switch to active halfway through its sibling
 * resources merely because another launch's prompt changed the setting.
 */
export function getHotReloadDiagnosticsForLaunch(launchId: string): HotReloadDiagnostics {
    return getOrCreateHotReloadLaunchState(launchId, getHotReloadDiagnostics()).diagnostics;
}

/**
 * Whether Hot Reload is expected to apply to .NET project resources in this window.
 */
function isHotReloadExpected(diagnostics: HotReloadDiagnostics): boolean {
    return diagnostics.devKitInstalled
        && diagnostics.workspaceTrusted
        && diagnostics.settingEnabled
        && isHotReloadSettingContributedWithDiagnostic();
}

/**
 * Writes the resolved Hot Reload state to the Aspire log.
 */
export function logHotReloadDiagnostics(resourceName: string, diagnostics: HotReloadDiagnostics, isDebugSession: boolean): void {
    if (!diagnostics.devKitInstalled) {
        // Nothing actionable to report: Hot Reload requires C# Dev Kit, and running .NET resources
        // without it is a fully supported configuration.
        return;
    }

    extensionLogOutputChannel.info(
        `Hot Reload state for ${resourceName}: workspaceTrusted=${diagnostics.workspaceTrusted}, ` +
        `csharp.experimental.debug.hotReload=${diagnostics.settingEnabled}, ` +
        `csharp.debug.hotReloadOnSave=${diagnostics.reloadOnSaveEnabled}`);

    if (!diagnostics.workspaceTrusted) {
        extensionLogOutputChannel.info(
            'The workspace is not trusted, so C# Dev Kit activates in limited mode and Hot Reload is unavailable.');
    }

    if (diagnostics.workspaceTrusted && !diagnostics.settingEnabled) {
        extensionLogOutputChannel.info(
            "Hot Reload is disabled because 'csharp.experimental.debug.hotReload' is not enabled. " +
            'This setting is machine-scoped, so it must be set in user settings; workspace settings are ignored.');
    }

    if (!isHotReloadExpected(diagnostics)) {
        return;
    }

    if (!isDebugSession) {
        // Hot Reload is applied by the debugger, so a resource started without one is never covered
        // however the settings are configured. Saying "Hot Reload covers <resource>" here would send
        // the user looking for a reload that cannot happen.
        extensionLogOutputChannel.info(
            `${resourceName} is running without a debugger, so Hot Reload does not apply to it.`);
        return;
    }

    // Logged for every resource, not once, so the answer to "was this project covered?" is in
    // the channel even for a user who dismissed the one-time notice or joined mid-session.
    const gesture = diagnostics.reloadOnSaveEnabled
        ? "Saving a file asks Dev Kit to apply the edit ('csharp.debug.hotReloadOnSave'); the toolbar button applies pending edits"
        : "'csharp.debug.hotReloadOnSave' is off, so saving does not apply edits; the toolbar button applies pending edits";

    extensionLogOutputChannel.info(
        `Hot Reload covers ${resourceName}. ${gesture} across .NET resources at once. ` +
        "Dev Kit reports what it actually applied in the '.NET Hot Reload' output channel.");
}

/**
 * Memento that remembers that the user dismissed the Hot Reload prompt.
 *
 * Held at module scope, and initialized from `activate`, because the resource launch path that
 * discovers the disabled state has no access to the extension context.
 */
let hotReloadPromptState: vscode.Memento | undefined;

/**
 * True once the prompt has been shown in this window.
 *
 * An Aspire app commonly launches several .NET project resources at once, and every one of them
 * takes the same code path. Without this, starting a five-project app would show five identical
 * notifications.
 */
let hotReloadPromptShownThisWindow = false;

/**
 * True once the "Hot Reload is active" notice has been raised in this window.
 */
let hotReloadNoticeShownThisWindow = false;

/**
 * True once this window has reported that Dev Kit no longer contributes the experimental gate.
 *
 * Every .NET resource reads this state independently. Keep the diagnostic useful without repeating
 * it for every sibling when Dev Kit renames or removes the setting.
 */
let hotReloadSettingMissingLoggedThisWindow = false;

/**
 * Supplies the extension context whose storage suppresses the Hot Reload prompt once dismissed.
 *
 * Takes the context rather than a memento so that the global-versus-workspace choice lives here,
 * where it is covered by tests. It has to be global: the setting being offered is machine-scoped, so
 * a workspace-scoped dismissal would re-offer a setting the user already declined every time they
 * opened another Aspire repo.
 */
export function initializeHotReloadPromptState(context: { globalState: vscode.Memento } | undefined): void {
    hotReloadPromptState = context?.globalState;
    hotReloadPromptShownThisWindow = false;
    hotReloadNoticeShownThisWindow = false;
    hotReloadSettingMissingLoggedThisWindow = false;
    hotReloadLaunchStates.clear();
}


/**
 * Records that the prompt should not be shown again in future windows.
 *
 * Failures are contained: this is bookkeeping, and letting a rejected memento write propagate would
 * skip the user-visible confirmation that the setting was actually applied. The worst outcome of a
 * failed write is that the offer is made again on a later run.
 */
async function suppressHotReloadPrompt(): Promise<void> {
    try {
        await hotReloadPromptState?.update(hotReloadPromptSuppressedKey, true);
    }
    catch (err) {
        extensionLogOutputChannel.warn(`Failed to persist the Hot Reload prompt dismissal: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Offers to turn on C# Dev Kit's Hot Reload gate when a .NET resource launches with Dev Kit present
 * but the feature switched off.
 *
 * This is the difference between Hot Reload silently never working and being one click away. The
 * toolbar button is contributed by Dev Kit and gated only on the `hotReloadEnabled` context key,
 * which is driven by `csharp.experimental.debug.hotReload`. That setting shipped defaulting to
 * `false` (it defaults to `true` in newer Dev Kit builds), so on many installations no Aspire session
 * will ever offer Hot Reload and there is nothing in the UI explaining why.
 *
 * Only prompts when acting on it would actually help, so users who cannot use Hot Reload are never
 * interrupted:
 * - Dev Kit must be installed. Hot Reload does not exist in the base C# extension, so prompting a
 *   C#-extension-only user would advertise a feature they cannot get.
 * - The workspace must be trusted. Dev Kit activates in limited mode otherwise, exposing no service
 *   broker at all, so enabling the setting would change nothing.
 * - The session must be debugging. Hot Reload is applied by the debugger, so a "run" session can
 *   never use it.
 */
export async function promptToEnableHotReloadIfNeeded(diagnostics: HotReloadDiagnostics, isDebugSession: boolean, launchId: string): Promise<boolean> {
    const launchState = getOrCreateHotReloadLaunchState(launchId, diagnostics);
    diagnostics = launchState.diagnostics;

    if (!isDebugSession || diagnostics.settingEnabled) {
        return false;
    }

    if (!diagnostics.devKitInstalled || !diagnostics.workspaceTrusted) {
        return false;
    }

    if (hotReloadPromptShownThisWindow || hotReloadPromptState?.get<boolean>(hotReloadPromptSuppressedKey, false) === true) {
        return false;
    }

    // The notice already spoke for this launch. Offering to turn on a setting the user was just told
    // is on would contradict it, which can happen when the value changes mid-launch via Settings Sync
    // or a profile switch while an Aspire app is still starting its resources.
    if (launchState.messageShown) {
        return false;
    }

    if (!isHotReloadSettingContributedWithDiagnostic()) {
        // Dev Kit no longer declares the gate this offer would write, so accepting it would put a
        // dead key in the user's settings and report success.
        return false;
    }

    if (hotReloadPromptState === undefined) {
        // Not fatal — the prompt still works — but "Don't show again" cannot be honored across
        // windows, so say so rather than letting the user re-dismiss it forever with no explanation.
        extensionLogOutputChannel.warn('Hot Reload prompt state was never initialized; a dismissal will not persist across windows.');
    }

    // Both flags are set before the first await. Aspire launches resources as independent requests
    // spread over seconds, so a five-project app would otherwise raise five identical prompts.
    hotReloadPromptShownThisWindow = true;
    launchState.messageShown = true;

    const selection = await vscode.window.showInformationMessage(hotReloadAvailablePrompt, enableHotReloadLabel, dontShowAgainLabel);

    if (selection === dontShowAgainLabel) {
        await suppressHotReloadPrompt();
        // Named so the log is a genuine escape hatch. The dismissal is global and there is no reset
        // command, so without this a user who clicked it by accident has nothing to search for.
        extensionLogOutputChannel.info(
            `Hot Reload will not be offered again. To turn it on later, set '${hotReloadConfigurationSection}.${hotReloadConfigurationName}' to true in user settings.`);
        return false;
    }

    if (selection !== enableHotReloadLabel) {
        // Dismissed without choosing. Leave the suppression flag alone so the offer can be made
        // again on a later run, but do not ask again in this window.
        return false;
    }

    try {
        // MUST be written at Global scope. The setting is declared `"scope": "machine"`, so VS Code
        // silently discards a workspace-scoped write and the user would see the prompt succeed while
        // Hot Reload stayed off.
        await vscode.workspace
            .getConfiguration(hotReloadConfigurationSection)
            .update(hotReloadConfigurationName, true, vscode.ConfigurationTarget.Global);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        extensionLogOutputChannel.error(`Failed to enable '${hotReloadConfigurationSection}.${hotReloadConfigurationName}': ${message}`);
        // Not awaited: the caller is on the resource launch path and this notification stays up until
        // the user dismisses it. Rejections are swallowed rather than left floating, because an
        // unhandled rejection from an advisory message would surface as an extension error.
        void Promise.resolve(vscode.window.showErrorMessage(hotReloadEnableFailed(message))).catch(() => { });
        return false;
    }

    await suppressHotReloadPrompt();
    extensionLogOutputChannel.info(`Enabled '${hotReloadConfigurationSection}.${hotReloadConfigurationName}' in user settings at the user's request.`);

    // Dev Kit reads the gate when it starts a hot reload session, so the resource that is already
    // launching will not pick it up. Say so rather than letting the user hunt for a button that is
    // not there yet. Not awaited, for the same reason as the error message above.
    void Promise.resolve(vscode.window.showInformationMessage(hotReloadEnabled)).catch(() => { });

    return true;
}

/**
 * Command contributed by C# Dev Kit that reveals the '.NET Hot Reload' output channel, which is
 * where Dev Kit reports what it did with each edit.
 */
const showHotReloadPanelCommand = 'csdevkit.debug.showHotReloadPanel';

/**
 * Tells the user, once, that Hot Reload is live for this Aspire app and what it covers.
 *
 * This exists because Hot Reload working is not the same as the user knowing it worked. Everything
 * about the interaction is owned by Dev Kit and none of it is expressed in Aspire's terms: the
 * toolbar button is gated on the global `hotReloadEnabled` context key with no session-type check,
 * so it also appears while the Aspire parent session is selected, and pressing it calls
 * `applyChanges()` on a single global client service — it applies across every registered .NET
 * resource rather than the selected one. Nothing states that, so the reasonable reading of the
 * button is that it targets whatever is selected.
 *
 * The notice also covers the save gesture, which is the part users are most likely to miss.
 * `csharp.debug.hotReloadOnSave` defaults to `true`, so the button is a manual fallback rather than
 * the primary gesture, and an edit is usually already applied by the time someone goes looking for a
 * button to press. That setting is read rather than assumed, because a user who turned it off would
 * otherwise be told that saving applies edits when it does not.
 *
 * Deliberately NOT a per-reload notification. Two independent reasons:
 * 1. Dev Kit's activation returns `{ isLimitedActivation, serviceBroker, components,
 *    getBrokeredServiceServerPipeName, hasServerProcessLoaded, serverProcessLoaded, ... }`. Its
 *    `reportHotReloadResult` and `onHotReloadAvailabilityChanged` are internal, so this extension
 *    cannot observe the outcome of a reload and any result we reported would be invented.
 * 2. With reload-on-save enabled the operation runs on every save, and a notification per save is
 *    unusable. Dev Kit already reports results in a way suited to that frequency: a status bar item
 *    and the '.NET Hot Reload' output channel, with detail controlled by
 *    `csharp.debug.hotReloadVerbosity`.
 */
export function announceHotReloadForSessionIfNeeded(diagnostics: HotReloadDiagnostics, isDebugSession: boolean, launchId: string): void {
    const launchState = getOrCreateHotReloadLaunchState(launchId, diagnostics);
    diagnostics = launchState.diagnostics;

    if (!isDebugSession || !isHotReloadExpected(diagnostics)) {
        return;
    }

    // The enable prompt and this notice describe mutually exclusive states, so at most one of them
    // may speak for a launch. A resource that arrives after the user accepted the prompt reads the new
    // setting value, and without this it would announce that Hot Reload is on immediately after the
    // prompt said to start debugging again for it to take effect.
    //
    // Scoped to the launch, not the window: the next launch is precisely when the user, having just
    // enabled the setting and restarted debugging as they were told to, should learn what it covers.
    if (launchState.messageShown) {
        return;
    }

    if (hotReloadNoticeShownThisWindow || hotReloadPromptState?.get<boolean>(hotReloadSessionNoticeShownKey, false) === true) {
        return;
    }

    // Set before the first await so that concurrently launching resources cannot each raise a
    // notice, exactly as the enable prompt does.
    hotReloadNoticeShownThisWindow = true;
    launchState.messageShown = true;

    // Deliberately carries no resource count or list. Resources launch as independent requests
    // spread over seconds, so anything counted at notice time reports whichever subset had arrived
    // rather than the final app. The claim made here is true regardless of launch timing, and the
    // per-resource lines written by `logHotReloadDiagnostics` name each project as it starts.
    const notice = diagnostics.reloadOnSaveEnabled ? hotReloadActiveNotice : hotReloadActiveNoticeSaveDisabled;

    // The whole body is inside the try, not just the awaits that are expected to fail: this is
    // fire-and-forget, so any rejection reaching the IIFE boundary would surface as an unhandled
    // promise rejection with no owner to report it.
    void (async () => {
        try {
            const selection = await vscode.window.showInformationMessage(notice, showHotReloadOutputLabel);

            if (selection === showHotReloadOutputLabel) {
                try {
                    await vscode.commands.executeCommand(showHotReloadPanelCommand);
                }
                catch (err) {
                    // The user explicitly asked for this action, so do not burn the once-ever notice
                    // when Dev Kit could not activate or execute its contributed command.
                    extensionLogOutputChannel.warn(`Could not open the C# Dev Kit Hot Reload output: ${err instanceof Error ? err.message : String(err)}`);
                    return;
                }
            }

            // A dismissal means the notice was delivered and intentionally remains once-ever. A
            // clicked action is recorded only after it succeeds, so command activation failures can
            // offer the action again in a later window. `hotReloadNoticeShownThisWindow` above still
            // stops concurrently launching resources from stacking notices while this is pending.
            try {
                await hotReloadPromptState?.update(hotReloadSessionNoticeShownKey, true);
            }
            catch (err) {
                extensionLogOutputChannel.warn(`Hot Reload notice could not be recorded as shown: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        catch (err) {
            // The notification itself is advisory and fire-and-forget. Keep its failure out of the
            // resource launch path and avoid an unhandled rejection.
            extensionLogOutputChannel.warn(`Hot Reload notice failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    })();
}
