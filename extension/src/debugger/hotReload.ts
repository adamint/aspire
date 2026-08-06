import * as vscode from 'vscode';
import { isCsDevKitInstalled } from '../capabilities';
import { extensionLogOutputChannel } from '../utils/logging';
import { AspireResourceExtendedDebugConfiguration } from '../dcp/types';
import { dontShowAgainLabel, enableHotReloadLabel, hotReloadAvailablePrompt, hotReloadEnableFailed, hotReloadEnabled } from '../loc/strings';
import { hotReloadPromptSuppressedKey } from '../utils/hotReloadNotificationState';

const csDevKitExtensionId = 'ms-dotnettools.csdevkit';

// C# Dev Kit reads the master Hot Reload gate as
// `workspace.getConfiguration('csharp.experimental.debug').get('hotReload')`, so the section and
// name are split the same way here to stay consistent with how the setting is actually resolved.
// The setting is declared with `"scope": "machine"`, which means VS Code silently ignores it when
// it is placed in workspace settings — it only takes effect from user/machine settings.
const hotReloadConfigurationSection = 'csharp.experimental.debug';
const hotReloadConfigurationName = 'hotReload';

/**
 * The subset of C# Dev Kit's exported API surface that this extension consumes.
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
    getBrokeredServiceServerPipeName: () => Promise<string>;
    hasServerProcessLoaded: () => boolean;
    /**
     * True when Dev Kit activated in "limited" mode, which it does for an untrusted workspace. In
     * that mode it returns ONLY this flag — no service broker and no pipe name — so Hot Reload
     * cannot work at all until the workspace is trusted.
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
    devKitServerLoaded: boolean;
    settingEnabled: boolean;
    /** True when this extension supplied the brokered service pipe name to the debug configuration. */
    pipeNameInjected: boolean;
}

/**
 * Returns whether the user has opted into C# Dev Kit's experimental Hot Reload gate.
 */
export function isHotReloadSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration(hotReloadConfigurationSection).get<boolean>(hotReloadConfigurationName) === true;
}

function tryGetDevKitExports(): CSharpDevKitExports | undefined {
    if (!isCsDevKitInstalled()) {
        return undefined;
    }

    const devKit = vscode.extensions.getExtension<CSharpDevKitExports>(csDevKitExtensionId);

    // Deliberately do NOT call activate() here. Forcing Dev Kit activation from the resource launch
    // path would add startup cost for a purely optional enhancement, and Dev Kit is already active by
    // the time it can service Hot Reload. If it has not activated yet, we simply skip the injection
    // and let the C# extension's own late-initialization path handle the session.
    if (!devKit?.isActive) {
        return undefined;
    }

    const exports = devKit.exports;
    if (typeof exports?.hasServerProcessLoaded !== 'function' || typeof exports?.getBrokeredServiceServerPipeName !== 'function') {
        // A future Dev Kit could change its exported shape. Treat that as "unavailable" rather than
        // throwing, so .NET debugging keeps working exactly as it does without Dev Kit installed.
        return undefined;
    }

    return exports;
}

/**
 * Resolves C# Dev Kit's brokered service pipe name, or `undefined` when Dev Kit is not installed,
 * not active, or its server process has not finished loading.
 */
export async function tryGetDevKitBrokeredServicePipeName(): Promise<string | undefined> {
    const exports = tryGetDevKitExports();
    if (exports === undefined || !exports.hasServerProcessLoaded()) {
        return undefined;
    }

    try {
        const pipeName = await exports.getBrokeredServiceServerPipeName();
        return pipeName === '' ? undefined : pipeName;
    }
    catch (err) {
        extensionLogOutputChannel.warn(`Failed to read the C# Dev Kit brokered service pipe name; Hot Reload will be unavailable for this session: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/**
 * Opts a .NET resource debug configuration into C# Dev Kit's Hot Reload when Dev Kit is present.
 *
 * Hot Reload in VS Code is implemented by vsdbg (shipped inside the C# extension) applying Roslyn
 * Edit-and-Continue deltas that are produced by C# Dev Kit and delivered over a brokered service
 * pipe. vsdbg only connects to that pipe when the launch configuration carries
 * `brokeredServicePipeName`.
 *
 * The C# extension normally injects that property itself from its `coreclr` debug configuration
 * provider, but it can only do so once Dev Kit's server process has loaded and reported the pipe
 * name. Aspire starts resource sessions programmatically as part of a long AppHost startup chain, so
 * a resource can be resolved while that value is still unset. Supplying it here makes the behavior
 * deterministic rather than dependent on that ordering.
 *
 * This is strictly additive: when Dev Kit is absent the function is a no-op and the resulting
 * configuration is byte-identical to what it was before, preserving the C#-extension-only workflow.
 */
export async function applyDevKitHotReloadSupport(debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<HotReloadDiagnostics> {
    const devKit = vscode.extensions.getExtension<CSharpDevKitExports>(csDevKitExtensionId);

    const diagnostics: HotReloadDiagnostics = {
        devKitInstalled: isCsDevKitInstalled(),
        devKitActive: devKit?.isActive === true,
        // In limited activation Dev Kit returns ONLY this flag, so the broker exports below are
        // absent and Hot Reload is impossible regardless of anything Aspire does.
        devKitLimitedActivation: devKit?.isActive === true && devKit.exports?.isLimitedActivation === true,
        devKitServerLoaded: false,
        settingEnabled: isHotReloadSettingEnabled(),
        pipeNameInjected: false
    };

    const exports = tryGetDevKitExports();
    if (exports === undefined) {
        return diagnostics;
    }

    diagnostics.devKitServerLoaded = exports.hasServerProcessLoaded();

    // Hot Reload is applied by the debugger, so a no-debug ("run") session can never hot reload.
    // Skip the work entirely rather than attaching a pipe that nothing will use.
    if (debugConfiguration.noDebug === true) {
        return diagnostics;
    }

    if (debugConfiguration.brokeredServicePipeName !== undefined) {
        diagnostics.pipeNameInjected = true;
        return diagnostics;
    }

    const pipeName = await tryGetDevKitBrokeredServicePipeName();
    if (pipeName === undefined) {
        return diagnostics;
    }

    debugConfiguration.brokeredServicePipeName = pipeName;
    diagnostics.pipeNameInjected = true;

    return diagnostics;
}

/**
 * Writes the resolved Hot Reload state to the Aspire log.
 *
 * The pipe name itself is intentionally never logged — only whether one was supplied — because it
 * addresses a live brokered service endpoint.
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
        `devKitServerLoaded=${diagnostics.devKitServerLoaded}, ` +
        `csharp.experimental.debug.hotReload=${diagnostics.settingEnabled}, ` +
        `brokeredServicePipeName=${diagnostics.pipeNameInjected ? 'set' : 'missing'}`);

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
}

/**
 * Reports whether the brokered service pipe name survived into the DAP `launch` request.
 *
 * `applyDevKitHotReloadSupport` only records what this extension put on the configuration. The C#
 * extension's own `coreclr` configuration provider runs afterwards and can still overwrite or drop
 * the value, so the launch request is the first point where the pipe name vsdbg will actually use is
 * observable. Logging it here is what makes "there is no Hot Reload button" diagnosable: an absent
 * pipe means the debugger was never told how to reach Dev Kit, whereas a present pipe points at
 * delta production or session association instead.
 *
 * Only the presence of the pipe name is logged, never its value, because it addresses a live
 * brokered service endpoint.
 */
export function logResolvedHotReloadState(session: vscode.DebugSession, launchArguments: unknown): void {
    // Hot Reload is a coreclr/vsdbg capability, and without Dev Kit there is nothing to report.
    if (session.type !== 'coreclr' || !isCsDevKitInstalled()) {
        return;
    }

    const pipeName = (launchArguments as { brokeredServicePipeName?: unknown } | undefined)?.brokeredServicePipeName;
    const resolved = typeof pipeName === 'string' && pipeName !== '';

    extensionLogOutputChannel.info(`Hot Reload brokered service pipe at launch for ${session.name}: ${resolved ? 'present' : 'absent'}`);

    if (!resolved) {
        extensionLogOutputChannel.info(
            'Without a brokered service pipe the debugger cannot reach C# Dev Kit, so Hot Reload will not be offered for this session. ' +
            "See the '.NET Hot Reload' output channel for the availability status reported by the debugger.");
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

    hotReloadPromptShownThisWindow = true;

    const selection = await vscode.window.showInformationMessage(hotReloadAvailablePrompt, enableHotReloadLabel, dontShowAgainLabel);

    if (selection === dontShowAgainLabel) {
        await hotReloadPromptState?.update(hotReloadPromptSuppressedKey, true);
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

    await hotReloadPromptState?.update(hotReloadPromptSuppressedKey, true);
    extensionLogOutputChannel.info(`Enabled '${hotReloadConfigurationSection}.${hotReloadConfigurationName}' in user settings at the user's request.`);

    // Dev Kit reads the gate when it starts a hot reload session, so the resource that is already
    // launching will not pick it up. Say so rather than letting the user hunt for a button that is
    // not there yet.
    vscode.window.showInformationMessage(hotReloadEnabled);

    return true;
}
