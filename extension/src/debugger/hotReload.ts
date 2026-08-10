import * as vscode from 'vscode';
import { isCsDevKitInstalled } from '../capabilities';
import { hotReloadDisabledNotice, openSettingsLabel } from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';

const hotReloadConfigurationSection = 'csharp.experimental.debug';
const hotReloadConfigurationName = 'hotReload';
const hotReloadOnSaveConfigurationSection = 'csharp.debug';
const hotReloadOnSaveConfigurationName = 'hotReloadOnSave';
const openSettingsCommand = 'workbench.action.openSettings';
const hotReloadSetting = `${hotReloadConfigurationSection}.${hotReloadConfigurationName}`;

export interface HotReloadDiagnostics {
    devKitInstalled: boolean;
    workspaceTrusted: boolean;
    settingEnabled: boolean;
    reloadOnSaveEnabled: boolean;
}

export function getHotReloadDiagnostics(): HotReloadDiagnostics {
    return {
        devKitInstalled: isCsDevKitInstalled(),
        workspaceTrusted: vscode.workspace.isTrusted,
        settingEnabled: vscode.workspace
            .getConfiguration(hotReloadConfigurationSection)
            .get<boolean>(hotReloadConfigurationName) === true,
        reloadOnSaveEnabled: vscode.workspace
            .getConfiguration(hotReloadOnSaveConfigurationSection)
            .get<boolean>(hotReloadOnSaveConfigurationName) !== false
    };
}

export function logHotReloadDiagnostics(resourceIdentifier: string, diagnostics: HotReloadDiagnostics): void {
    extensionLogOutputChannel.info(
        `Hot Reload state for ${resourceIdentifier}: devKitInstalled=${diagnostics.devKitInstalled}, ` +
        `workspaceTrusted=${diagnostics.workspaceTrusted}, ` +
        `${hotReloadSetting}=${diagnostics.settingEnabled}, ` +
        `${hotReloadOnSaveConfigurationSection}.${hotReloadOnSaveConfigurationName}=${diagnostics.reloadOnSaveEnabled}`);
}

let hotReloadDisabledAdvisoryShown = false;

export async function showHotReloadDisabledAdvisoryIfNeeded(diagnostics: HotReloadDiagnostics): Promise<void> {
    if (hotReloadDisabledAdvisoryShown
        || !diagnostics.devKitInstalled
        || diagnostics.settingEnabled) {
        return;
    }

    // Set this before showing the message so concurrently launching resources cannot stack notices.
    hotReloadDisabledAdvisoryShown = true;

    try {
        const selection = await vscode.window.showInformationMessage(hotReloadDisabledNotice, openSettingsLabel);
        if (selection === openSettingsLabel) {
            await vscode.commands.executeCommand(openSettingsCommand, hotReloadSetting);
        }
    }
    catch (err) {
        extensionLogOutputChannel.warn(`C# Dev Kit Hot Reload advisory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
