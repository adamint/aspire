import * as vscode from 'vscode';
import { isCsDevKitInstalled } from '../capabilities';
import { extensionLogOutputChannel } from '../utils/logging';
import { dontShowAgainLabel, enableHotReloadLabel, hotReloadActiveNotice, hotReloadAvailablePrompt, hotReloadEnableFailed, hotReloadEnabled, showHotReloadOutputLabel } from '../loc/strings';
import { hotReloadPromptSuppressedKey, hotReloadSessionNoticeShownKey } from '../utils/hotReloadNotificationState';

const csDevKitExtensionId = 'ms-dotnettools.csdevkit';

// C# Dev Kit reads the master Hot Reload gate as
// `workspace.getConfiguration('csharp.experimental.debug').get('hotReload')`, so the section and
// name are split the same way here to stay consistent with how the setting is actually resolved.
// The setting is declared with `"scope": "machine"`, which means VS Code silently ignores it when
// it is placed in workspace settings — it only takes effect from user/machine settings.
const hotReloadConfigurationSection = 'csharp.experimental.debug';
const hotReloadConfigurationName = 'hotReload';

/**
 * The only part of C# Dev Kit's exported API this extension reads.
 *
 * Declared locally instead of importing from Dev Kit because Dev Kit is an OPTIONAL dependency:
 * .NET debugging only requires the C# extension (`ms-dotnettools.csharp`), which is what contributes
 * the `coreclr` debug adapter. Dev Kit is additionally entitlement-gated, so it can never be a
 * baseline requirement for running Aspire .NET resources.
 *
 * Mirrors `CSharpDevKitExports` in dotnet/vscode-csharp:
 * https://github.com/dotnet/vscode-csharp/blob/main/src/csharpDevKitExports.ts
 */
interface CSharpDevKitExports {
    /**
     * True when Dev Kit activated in "limited" mode, which it does for an untrusted workspace. In
     * that mode Hot Reload cannot work at all until the workspace is trusted, so there is no point
     * telling the user how to turn it on.
     */
    isLimitedActivation?: boolean;
}

/**
 * Describes why Hot Reload is or is not expected to be available for .NET resources, so the state is
 * discoverable from the Aspire log instead of the user only seeing a missing toolbar button.
 */
export interface HotReloadDiagnostics {
    devKitInstalled: boolean;
    devKitActive: boolean;
    /** True when Dev Kit activated in limited mode, which it does for an untrusted workspace. */
    devKitLimitedActivation: boolean;
    settingEnabled: boolean;
}

/**
 * Returns whether the user has opted into C# Dev Kit's experimental Hot Reload gate.
 */
export function isHotReloadSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration(hotReloadConfigurationSection).get<boolean>(hotReloadConfigurationName) === true;
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
 * This deliberately does not call `activate()` on Dev Kit. Forcing activation from the resource
 * launch path would add startup cost for a purely optional enhancement.
 */
export function getHotReloadDiagnostics(): HotReloadDiagnostics {
    const devKit = vscode.extensions.getExtension<CSharpDevKitExports>(csDevKitExtensionId);

    return {
        devKitInstalled: isCsDevKitInstalled(),
        devKitActive: devKit?.isActive === true,
        devKitLimitedActivation: devKit?.isActive === true && devKit.exports?.isLimitedActivation === true,
        settingEnabled: isHotReloadSettingEnabled()
    };
}

/**
 * Writes the resolved Hot Reload state to the Aspire log.
 */
export function logHotReloadDiagnostics(resourceName: string, diagnostics: HotReloadDiagnostics): void {
    if (!diagnostics.devKitInstalled) {
        // Nothing actionable to report: Hot Reload requires C# Dev Kit, and running .NET resources
        // without it is a fully supported configuration.
        return;
    }

    extensionLogOutputChannel.info(
        `Hot Reload state for ${resourceName}: devKitActive=${diagnostics.devKitActive}, ` +
        `devKitLimitedActivation=${diagnostics.devKitLimitedActivation}, ` +
        `csharp.experimental.debug.hotReload=${diagnostics.settingEnabled}`);

    if (diagnostics.devKitLimitedActivation) {
        extensionLogOutputChannel.info(
            'C# Dev Kit activated in limited mode, which it does for an untrusted workspace. ' +
            'Hot Reload is unavailable until the workspace is trusted.');
    }

    if (!diagnostics.settingEnabled) {
        extensionLogOutputChannel.info(
            "Hot Reload is disabled because 'csharp.experimental.debug.hotReload' is not enabled. " +
            'This setting is machine-scoped, so it must be set in user settings; workspace settings are ignored.');
    }
    else {
        // Logged for every resource, not once, so the answer to "was this project covered?" is in
        // the channel even for a user who dismissed the one-time notice or joined mid-session.
        extensionLogOutputChannel.info(
            `Hot Reload covers ${resourceName}. Saving a file applies the change to the running resource ` +
            "('csharp.debug.hotReloadOnSave', on by default); the toolbar button applies pending changes to all " +
            ".NET resources at once. Results appear in the '.NET Hot Reload' output channel.");
    }
}

/**
 * Memento used to remember that the user dismissed the Hot Reload prompt.
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
 * Supplies the storage used to suppress the Hot Reload prompt once the user dismisses it.
 */
export function initializeHotReloadPromptState(memento: vscode.Memento | undefined): void {
    hotReloadPromptState = memento;
    hotReloadPromptShownThisWindow = false;
    hotReloadNoticeShownThisWindow = false;
}

/**
 * True once the "Hot Reload is active" notice has been raised in this window.
 */
let hotReloadNoticeShownThisWindow = false;


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
 * - Dev Kit must be installed and active. Hot Reload does not exist in the base C# extension, so
 *   prompting a C#-extension-only user would advertise a feature they cannot get.
 * - Dev Kit must not be in limited activation, which it uses for an untrusted workspace. In that
 *   mode it exposes no service broker at all and the setting would change nothing.
 * - The session must be debugging. Hot Reload is applied by the debugger, so a "run" session can
 *   never use it.
 */
export async function promptToEnableHotReloadIfNeeded(diagnostics: HotReloadDiagnostics, isDebugSession: boolean): Promise<boolean> {
    if (!isDebugSession || diagnostics.settingEnabled) {
        return false;
    }

    if (!diagnostics.devKitInstalled || !diagnostics.devKitActive || diagnostics.devKitLimitedActivation) {
        return false;
    }

    if (hotReloadPromptShownThisWindow || hotReloadPromptState?.get<boolean>(hotReloadPromptSuppressedKey, false) === true) {
        return false;
    }

    if (hotReloadPromptState === undefined) {
        // Not fatal — the prompt still works — but "Don't show again" cannot be honored across
        // windows, so say so rather than letting the user re-dismiss it forever with no explanation.
        extensionLogOutputChannel.warn('Hot Reload prompt state was never initialized; a dismissal will not persist across windows.');
    }

    hotReloadPromptShownThisWindow = true;

    const selection = await vscode.window.showInformationMessage(hotReloadAvailablePrompt, enableHotReloadLabel, dontShowAgainLabel);

    if (selection === dontShowAgainLabel) {
        await suppressHotReloadPrompt();
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
        vscode.window.showErrorMessage(hotReloadEnableFailed(message));
        return false;
    }

    await suppressHotReloadPrompt();
    extensionLogOutputChannel.info(`Enabled '${hotReloadConfigurationSection}.${hotReloadConfigurationName}' in user settings at the user's request.`);

    // Dev Kit reads the gate when it starts a hot reload session, so the resource that is already
    // launching will not pick it up. Say so rather than letting the user hunt for a button that is
    // not there yet.
    vscode.window.showInformationMessage(hotReloadEnabled);

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
 * The notice also says that saving applies changes, which is the part users are most likely to miss.
 * `csharp.debug.hotReloadOnSave` defaults to `true`, so the button is a manual fallback rather than
 * the primary gesture, and an edit is usually already applied by the time someone goes looking for a
 * button to press.
 *
 * Deliberately NOT a per-reload notification. Two independent reasons:
 * 1. Dev Kit exports only `{ serviceBroker, ensureInitialized, getBrokeredServiceServerPipeName,
 *    hasServerProcessLoaded, serverProcessLoaded }`. Its `reportHotReloadResult` and
 *    `onHotReloadAvailabilityChanged` are internal, so this extension cannot observe the outcome of
 *    a reload and any result we reported would be invented.
 * 2. With reload-on-save enabled the operation runs on every save, and a notification per save is
 *    unusable. Dev Kit already reports results in a way suited to that frequency: a status bar item
 *    and the '.NET Hot Reload' output channel, with detail controlled by
 *    `csharp.debug.hotReloadVerbosity`.
 */
export function announceHotReloadForSessionIfNeeded(diagnostics: HotReloadDiagnostics, isDebugSession: boolean): void {
    if (!isDebugSession || !diagnostics.settingEnabled) {
        return;
    }

    if (!diagnostics.devKitInstalled || !diagnostics.devKitActive || diagnostics.devKitLimitedActivation) {
        return;
    }

    if (hotReloadNoticeShownThisWindow || hotReloadPromptState?.get<boolean>(hotReloadSessionNoticeShownKey, false) === true) {
        return;
    }

    // Set before the first await so that concurrently launching resources cannot each raise a
    // notice, exactly as the enable prompt does.
    hotReloadNoticeShownThisWindow = true;

    // Deliberately carries no resource count or list. Resources launch as independent requests
    // spread over seconds, so anything counted at notice time reports whichever subset had arrived
    // and is wrong for the rest — an earlier version of this said "1 .NET resource" for a
    // three-resource app. The claim made here is true regardless of launch timing, and the
    // per-resource lines written by `logHotReloadDiagnostics` name each project as it starts.
    void (async () => {
        try {
            await hotReloadPromptState?.update(hotReloadSessionNoticeShownKey, true);
        }
        catch (err) {
            extensionLogOutputChannel.warn(`Failed to persist the Hot Reload notice state: ${err instanceof Error ? err.message : String(err)}`);
        }

        const selection = await vscode.window.showInformationMessage(hotReloadActiveNotice, showHotReloadOutputLabel);
        if (selection !== showHotReloadOutputLabel) {
            return;
        }

        try {
            await vscode.commands.executeCommand(showHotReloadPanelCommand);
        }
        catch (err) {
            // The command is contributed by Dev Kit and is not part of any contract with this
            // extension, so treat it as advisory rather than surfacing a failure to the user.
            extensionLogOutputChannel.warn(`Could not run '${showHotReloadPanelCommand}': ${err instanceof Error ? err.message : String(err)}`);
        }
    })();
}
