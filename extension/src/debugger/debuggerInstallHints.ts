import * as vscode from 'vscode';
import {
    bunDebuggerName,
    debuggerInstallAction,
    debuggerInstallDontShowAgain,
    debuggerInstallNotification,
    goDebuggerName,
    pythonDebuggerName,
} from '../loc/strings';

export interface DebuggerInstallHint {
    debuggerName: string;
    extensionId: string;
}

export interface DebuggerInstallHintServiceDependencies {
    getExtension(extensionId: string): vscode.Extension<unknown> | undefined;
    onDidChangeExtensions: vscode.Event<void>;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    installExtension(extensionId: string): Thenable<void>;
}

const pythonDebuggerInstallHint: DebuggerInstallHint = {
    debuggerName: pythonDebuggerName,
    extensionId: 'ms-python.debugpy',
};

const goDebuggerInstallHint: DebuggerInstallHint = {
    debuggerName: goDebuggerName,
    extensionId: 'golang.go',
};

const bunDebuggerInstallHint: DebuggerInstallHint = {
    debuggerName: bunDebuggerName,
    extensionId: 'oven.bun-vscode',
};

const debuggerInstallHintsByMethod = new Map<string, DebuggerInstallHint>([
    ['AddPythonApp', pythonDebuggerInstallHint],
    ['AddPythonModule', pythonDebuggerInstallHint],
    ['AddUvicornApp', pythonDebuggerInstallHint],
    ['addPythonApp', pythonDebuggerInstallHint],
    ['addPythonModule', pythonDebuggerInstallHint],
    ['addUvicornApp', pythonDebuggerInstallHint],
    ['AddGoApp', goDebuggerInstallHint],
    ['addGoApp', goDebuggerInstallHint],
    ['AddBunApp', bunDebuggerInstallHint],
    ['addBunApp', bunDebuggerInstallHint],
]);

const notificationSuppressedKeyPrefix = 'aspire.debuggerInstallHint.suppressed.';

export function getDebuggerInstallHint(methodName: string): DebuggerInstallHint | undefined {
    return debuggerInstallHintsByMethod.get(methodName);
}

export async function installDebuggerExtension(extensionId: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId);
}

export class DebuggerInstallHintService implements vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly _notificationsShownThisSession = new Set<string>();
    private readonly _extensionChangeSubscription: vscode.Disposable;
    private _disposed = false;

    constructor(
        private readonly _globalState: vscode.Memento,
        private readonly _dependencies: DebuggerInstallHintServiceDependencies,
    ) {
        this._extensionChangeSubscription = _dependencies.onDidChangeExtensions(() => this.refresh());
    }

    getMissingDebugger(methodName: string): DebuggerInstallHint | undefined {
        const hint = getDebuggerInstallHint(methodName);
        return hint && !this._dependencies.getExtension(hint.extensionId) ? hint : undefined;
    }

    async showNotificationIfNeeded(hint: DebuggerInstallHint): Promise<void> {
        const notificationSuppressedKey = `${notificationSuppressedKeyPrefix}${hint.extensionId}`;
        if (this._disposed
            || this._dependencies.getExtension(hint.extensionId)
            || this._notificationsShownThisSession.has(hint.extensionId)
            || this._globalState.get<boolean>(notificationSuppressedKey, false)) {
            return;
        }

        // Mark the extension before opening the notification. Repository refreshes can overlap
        // while the toast is awaiting user input, and each language can have several resources
        // across several AppHosts.
        this._notificationsShownThisSession.add(hint.extensionId);

        let selected: string | undefined;
        try {
            selected = await this._dependencies.showInformationMessage(
                debuggerInstallNotification(hint.debuggerName),
                debuggerInstallAction,
                debuggerInstallDontShowAgain);
        } catch (error) {
            // No notification was shown successfully, so a later resource update should retry.
            this._notificationsShownThisSession.delete(hint.extensionId);
            throw error;
        }

        if (this._disposed) {
            return;
        }

        if (selected === debuggerInstallDontShowAgain) {
            await this._globalState.update(notificationSuppressedKey, true);
        } else if (selected === debuggerInstallAction) {
            await this.installExtension(hint.extensionId);
        }
    }

    async installExtension(extensionId: string): Promise<void> {
        if (this._disposed) {
            return;
        }

        await this._dependencies.installExtension(extensionId);
        this.refresh();
    }

    refresh(): void {
        if (!this._disposed) {
            this._onDidChange.fire();
        }
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
        this._extensionChangeSubscription.dispose();
        this._onDidChange.dispose();
    }
}

export function createDebuggerInstallHintService(globalState: vscode.Memento): DebuggerInstallHintService {
    return new DebuggerInstallHintService(globalState, {
        getExtension: extensionId => vscode.extensions.getExtension(extensionId),
        onDidChangeExtensions: vscode.extensions.onDidChange,
        showInformationMessage: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
        installExtension: installDebuggerExtension,
    });
}
