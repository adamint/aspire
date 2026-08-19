import * as vscode from 'vscode';
import { ResourceState } from '../editor/resourceConstants';
import {
    debuggerInstallAction,
    debuggerInstallNotification,
    debuggerExtensionDisabled,
    debuggerInstalledRestartAppHost,
    dontShowAgainLabel,
    errorMessage,
} from '../loc/strings';
import { bunDebuggerExtension } from './languages/bun';
import { goDebuggerExtension } from './languages/go';
import { pythonDebuggerExtension } from './languages/python';

export const launchConfigurationTypePropertyName = 'resource.launchConfigurationType';

export interface DebuggerInstallHint {
    debuggerName: string;
    extensionId: string;
}

interface DebuggerInstallFailure {
    success: false;
    errorKind: string;
}

interface DebuggableResourceSnapshot {
    state: string | null;
    properties: Record<string, string | null> | null;
}

interface DebuggerInstallHintDataSource {
    readonly workspaceAppHostCandidatePaths: readonly string[];
    readonly workspaceResources: readonly DebuggableResourceSnapshot[];
    readonly appHosts: readonly { resources?: readonly DebuggableResourceSnapshot[] | null }[];
    readonly onDidChangeData: vscode.Event<void>;
    keepDataActive(): vscode.Disposable;
}

const debuggerInstallHints = new Map<string, DebuggerInstallHint>([
    ['python', { debuggerName: 'Python', extensionId: pythonDebuggerExtension.extensionId! }],
    ['go', { debuggerName: 'Go', extensionId: goDebuggerExtension.extensionId! }],
    ['bun', { debuggerName: 'Bun', extensionId: bunDebuggerExtension.extensionId! }],
]);

const notificationSuppressedKeyPrefix = 'aspire.debuggerInstallHint.suppressed.';

export function getDebuggerInstallHintForResource(resource: DebuggableResourceSnapshot): DebuggerInstallHint | undefined {
    const launchConfigurationType = resource.properties?.[launchConfigurationTypePropertyName];
    const hint = launchConfigurationType ? debuggerInstallHints.get(launchConfigurationType) : undefined;
    return hint && !vscode.extensions.getExtension(hint.extensionId) ? hint : undefined;
}

export class DebuggerInstallHintService {
    private static readonly _extensionRegistrationTimeoutMs = 5_000;
    private readonly _notificationsShown = new Set<string>();

    constructor(private readonly _globalState: vscode.Memento) {
    }

    watchForMissingDebuggers(dataSource: DebuggerInstallHintDataSource): vscode.Disposable {
        let dataLease: vscode.Disposable | undefined;
        const refresh = () => {
            const hasKnownAppHost = dataSource.workspaceAppHostCandidatePaths.length > 0
                || dataSource.appHosts.length > 0;
            if (hasKnownAppHost && !dataLease) {
                // AppHost discovery runs independently of the panel data lifecycle. Wait for a real
                // candidate before keeping ps/describe active so unrelated .NET workspaces do not
                // acquire a permanent Aspire CLI process just because the extension activated.
                dataLease = dataSource.keepDataActive();
            } else if (!hasKnownAppHost && dataLease) {
                dataLease.dispose();
                dataLease = undefined;
            }

            const resources = [
                ...dataSource.workspaceResources,
                ...dataSource.appHosts.flatMap(appHost => appHost.resources ?? []),
            ];
            void this.notifyMissingDebuggers(resources);
        };

        const dataSubscription = dataSource.onDidChangeData(refresh);
        refresh();

        return vscode.Disposable.from(
            dataSubscription,
            new vscode.Disposable(() => dataLease?.dispose()));
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

    async installDebuggerExtension(hint: DebuggerInstallHint): Promise<void | DebuggerInstallFailure> {
        try {
            await vscode.commands.executeCommand('workbench.extensions.installExtension', hint.extensionId);

            // Installing an already-installed but disabled extension is a no-op, and disabled
            // extensions remain absent from this registry. A fresh install can also appear after
            // the command resolves, so wait for the registry change before deciding it is disabled.
            // See https://github.com/microsoft/vscode/issues/71943.
            const registered = await this._waitForExtensionRegistration(hint.extensionId);
            const message = registered
                ? debuggerInstalledRestartAppHost(hint.debuggerName)
                : debuggerExtensionDisabled(hint.debuggerName);
            await vscode.window.showInformationMessage(message);
        } catch (error) {
            await vscode.window.showErrorMessage(errorMessage(error));
            return {
                success: false,
                errorKind: error instanceof Error ? error.name : 'Error',
            };
        }
    }

    private async _waitForExtensionRegistration(extensionId: string): Promise<boolean> {
        if (vscode.extensions.getExtension(extensionId)) {
            return true;
        }

        return new Promise(resolve => {
            let settled = false;
            let timeout: NodeJS.Timeout | undefined;
            let subscription: vscode.Disposable | undefined;
            const finish = (registered: boolean) => {
                if (settled) {
                    return;
                }

                settled = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                subscription?.dispose();
                resolve(registered);
            };
            subscription = vscode.extensions.onDidChange(() => {
                if (vscode.extensions.getExtension(extensionId)) {
                    finish(true);
                }
            });
            timeout = setTimeout(
                () => finish(false),
                DebuggerInstallHintService._extensionRegistrationTimeoutMs);

            // Close the gap between the initial check and registering the change listener.
            if (vscode.extensions.getExtension(extensionId)) {
                finish(true);
            }
        });
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
