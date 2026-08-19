import * as vscode from 'vscode';
import { getRustExtensionId, javaDebugExtensionId, javaLanguageExtensionId } from '../capabilities';
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
    debuggerType: string;
    extensionIds: readonly string[];
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
    ['python', {
        debuggerName: 'Python',
        debuggerType: 'python',
        extensionIds: [pythonDebuggerExtension.extensionId!],
    }],
    ['go', {
        debuggerName: 'Go',
        debuggerType: 'go',
        extensionIds: [goDebuggerExtension.extensionId!],
    }],
    ['bun', {
        debuggerName: 'Bun',
        debuggerType: 'bun',
        extensionIds: [bunDebuggerExtension.extensionId!],
    }],
    ['java', {
        debuggerName: 'Java',
        debuggerType: 'java',
        extensionIds: [javaLanguageExtensionId, javaDebugExtensionId],
    }],
]);

const notificationSuppressedKeyPrefix = 'aspire.debuggerInstallHint.suppressed.';

export function getDebuggerInstallHintForResource(
    resource: DebuggableResourceSnapshot,
    platform: NodeJS.Platform = process.platform
): DebuggerInstallHint | undefined {
    const launchConfigurationType = resource.properties?.[launchConfigurationTypePropertyName];
    let hint = launchConfigurationType ? debuggerInstallHints.get(launchConfigurationType) : undefined;
    if (launchConfigurationType === 'rust') {
        const selectedExtensionId = getRustExtensionId(
            platform,
            candidateExtensionId => !!vscode.extensions.getExtension(candidateExtensionId));
        // Preserve either installed Windows adapter, but recommend CodeLLDB when neither is installed
        // because GNU targets require it and it also supports MSVC targets.
        const extensionId = platform === 'win32' && !vscode.extensions.getExtension(selectedExtensionId)
            ? 'vadimcn.vscode-lldb'
            : selectedExtensionId;
        hint = {
            debuggerName: 'Rust',
            debuggerType: 'rust',
            extensionIds: [extensionId],
        };
    }

    return hint?.extensionIds.some(extensionId => !vscode.extensions.getExtension(extensionId))
        ? hint
        : undefined;
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
            const missingExtensionIds = hint.extensionIds.filter(
                extensionId => !vscode.extensions.getExtension(extensionId));
            for (const extensionId of missingExtensionIds) {
                await vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId);
            }

            // Installing an already-installed but disabled extension is a no-op, and disabled
            // extensions remain absent from this registry. A fresh install can also appear after
            // the command resolves, so wait for the registry change before deciding it is disabled.
            // See https://github.com/microsoft/vscode/issues/71943.
            const registered = await this._waitForExtensionRegistrations(hint.extensionIds);
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

    private async _waitForExtensionRegistrations(extensionIds: readonly string[]): Promise<boolean> {
        const areAllExtensionsRegistered = () =>
            extensionIds.every(extensionId => !!vscode.extensions.getExtension(extensionId));
        if (areAllExtensionsRegistered()) {
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
                if (areAllExtensionsRegistered()) {
                    finish(true);
                }
            });
            timeout = setTimeout(
                () => finish(false),
                DebuggerInstallHintService._extensionRegistrationTimeoutMs);

            // Close the gap between the initial check and registering the change listener.
            if (areAllExtensionsRegistered()) {
                finish(true);
            }
        });
    }

    private async _showNotification(hint: DebuggerInstallHint): Promise<void> {
        const suppressionKey = `${notificationSuppressedKeyPrefix}${hint.debuggerType}`;
        if (this._notificationsShown.has(hint.debuggerType)
            || this._globalState.get<boolean>(suppressionKey, false)) {
            return;
        }

        // Mark the debugger before awaiting user input so overlapping repository updates cannot
        // open duplicate notifications for multiple resources using the same debugger.
        this._notificationsShown.add(hint.debuggerType);

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
            this._notificationsShown.delete(hint.debuggerType);
            await vscode.window.showErrorMessage(errorMessage(error));
        }
    }
}
