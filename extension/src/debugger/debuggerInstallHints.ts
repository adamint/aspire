import * as vscode from 'vscode';
import { ResourceState } from '../editor/resourceConstants';
import {
    bunDebuggerName,
    debuggerInstallAction,
    debuggerInstallNotification,
    debuggerInstalledRestartAppHost,
    dontShowAgainLabel,
    errorMessage,
    goDebuggerName,
    pythonDebuggerName,
} from '../loc/strings';
import { bunDebuggerExtension } from './languages/bun';
import { goDebuggerExtension } from './languages/go';
import { pythonDebuggerExtension } from './languages/python';

export const launchConfigurationTypePropertyName = 'resource.launchConfigurationType';

export interface DebuggerInstallHint {
    debuggerName: string;
    extensionId: string;
}

interface DebuggableResourceSnapshot {
    state: string | null;
    properties: Record<string, string | null> | null;
}

const debuggerInstallHints = new Map<string, DebuggerInstallHint>([
    ['python', { debuggerName: pythonDebuggerName, extensionId: pythonDebuggerExtension.extensionId! }],
    ['go', { debuggerName: goDebuggerName, extensionId: goDebuggerExtension.extensionId! }],
    ['bun', { debuggerName: bunDebuggerName, extensionId: bunDebuggerExtension.extensionId! }],
]);

const notificationSuppressedKeyPrefix = 'aspire.debuggerInstallHint.suppressed.';

export function getDebuggerInstallHintForResource(resource: DebuggableResourceSnapshot): DebuggerInstallHint | undefined {
    const launchConfigurationType = resource.properties?.[launchConfigurationTypePropertyName];
    const hint = launchConfigurationType ? debuggerInstallHints.get(launchConfigurationType) : undefined;
    return hint && !vscode.extensions.getExtension(hint.extensionId) ? hint : undefined;
}

export class DebuggerInstallHintService {
    private readonly _notificationsShown = new Set<string>();

    constructor(private readonly _globalState: vscode.Memento) {
    }

    async notifyMissingDebuggers(resources: Iterable<DebuggableResourceSnapshot>): Promise<void> {
        const notifications: Promise<void>[] = [];
        for (const resource of resources) {
            if (resource.state !== ResourceState.Running) {
                continue;
            }

            const hint = getDebuggerInstallHintForResource(resource);
            if (hint) {
                notifications.push(this._showNotification(hint));
            }
        }

        await Promise.all(notifications);
    }

    async installDebuggerExtension(hint: DebuggerInstallHint): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.extensions.installExtension', hint.extensionId);
            await vscode.window.showInformationMessage(debuggerInstalledRestartAppHost(hint.debuggerName));
        } catch (error) {
            await vscode.window.showErrorMessage(errorMessage(error));
        }
    }

    private async _showNotification(hint: DebuggerInstallHint): Promise<void> {
        const suppressionKey = `${notificationSuppressedKeyPrefix}${hint.extensionId}`;
        if (this._notificationsShown.has(hint.extensionId)
            || this._globalState.get<boolean>(suppressionKey, false)) {
            return;
        }

        // Mark the extension before awaiting user input so overlapping repository updates cannot
        // open duplicate notifications for multiple resources using the same debugger.
        this._notificationsShown.add(hint.extensionId);

        try {
            const selected = await vscode.window.showInformationMessage(
                debuggerInstallNotification(hint.debuggerName),
                debuggerInstallAction,
                dontShowAgainLabel);

            if (selected === debuggerInstallAction) {
                await this.installDebuggerExtension(hint);
            } else if (selected === dontShowAgainLabel) {
                await this._globalState.update(suppressionKey, true);
            }
        } catch (error) {
            this._notificationsShown.delete(hint.extensionId);
            await vscode.window.showErrorMessage(errorMessage(error));
        }
    }
}
