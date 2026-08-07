import * as vscode from 'vscode';
import {
    bunDebuggerName,
    debuggerInstallAction,
    debuggerInstallDontShowAgain,
    debuggerInstallFailed,
    debuggerInstallNotification,
    debuggerInstalledRestartAppHost,
    goDebuggerName,
    pythonDebuggerName,
} from '../loc/strings';
import { bunDebuggerExtension } from './languages/bun';
import { goDebuggerExtension } from './languages/go';
import { pythonDebuggerExtension } from './languages/python';
import { ResourceDebuggerExtension } from './debuggerExtensions';

export interface DebuggerInstallHint {
    debuggerName: string;
    extensionId: string;
}

export interface DebuggerInstallHintServiceDependencies {
    getExtension(extensionId: string): vscode.Extension<unknown> | undefined;
    onDidChangeExtensions: vscode.Event<void>;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showErrorMessage(message: string): Thenable<string | undefined>;
    installExtension(extensionId: string): Thenable<void>;
}

/**
 * Add* methods whose resources opt into debugging by default, grouped by the debug adapter
 * extension that has to be installed for the debugger to attach.
 *
 * Only methods that call `.WithDebugging()` (or the polyglot equivalent) for the user belong
 * here. `AddPythonExecutable` is deliberately absent: it produces a `PythonAppResource` but
 * leaves debugging opt-in, so suggesting debugpy for it would be misleading.
 *
 * Node/Vite/Next.js resources are also absent because they are debugged by VS Code's built-in
 * js-debug adapter, which needs no extension (see `languages/node.ts`, `extensionId: null`).
 */
const debuggerInstallHintDefinitions: readonly {
    debuggerName: string;
    debuggerExtension: ResourceDebuggerExtension;
    methodNames: readonly string[];
}[] = [
    {
        debuggerName: pythonDebuggerName,
        debuggerExtension: pythonDebuggerExtension,
        methodNames: ['AddPythonApp', 'AddPythonModule', 'AddUvicornApp'],
    },
    {
        debuggerName: goDebuggerName,
        debuggerExtension: goDebuggerExtension,
        methodNames: ['AddGoApp'],
    },
    {
        debuggerName: bunDebuggerName,
        debuggerExtension: bunDebuggerExtension,
        methodNames: ['AddBunApp'],
    },
];

const debuggerInstallHintsByMethodName = new Map<string, DebuggerInstallHint>();
const debuggerInstallHintsByExtensionId = new Map<string, DebuggerInstallHint>();

for (const definition of debuggerInstallHintDefinitions) {
    const extensionId = definition.debuggerExtension.extensionId;
    if (!extensionId) {
        // A null extensionId means the debug adapter ships with VS Code, so there is nothing to install.
        continue;
    }

    const hint: DebuggerInstallHint = { debuggerName: definition.debuggerName, extensionId };
    debuggerInstallHintsByExtensionId.set(extensionId, hint);
    for (const methodName of definition.methodNames) {
        // C# AppHosts use `AddPythonApp(...)` while polyglot AppHosts use `addPythonApp(...)`, and
        // the JS/TS parser matches `/^add\w+$/i`, so any casing can reach this lookup. Key the map
        // case-insensitively instead of enumerating every spelling.
        debuggerInstallHintsByMethodName.set(methodName.toLowerCase(), hint);
    }
}

const notificationSuppressedKeyPrefix = 'aspire.debuggerInstallHint.suppressed.';

export function getDebuggerInstallHint(methodName: string): DebuggerInstallHint | undefined {
    return debuggerInstallHintsByMethodName.get(methodName.toLowerCase());
}

export function getDebuggerInstallHintForExtension(extensionId: string): DebuggerInstallHint | undefined {
    return debuggerInstallHintsByExtensionId.get(extensionId);
}

export async function installDebuggerExtension(extensionId: string): Promise<void> {
    // https://code.visualstudio.com/api/references/commands - `workbench.extensions.installExtension`
    // accepts an extension id and resolves once the gallery install completes.
    await vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId);
}

export class DebuggerInstallHintService implements vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly _notificationsShownThisSession = new Set<string>();
    private readonly _installsAwaitingActivation = new Set<string>();
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

    /**
     * Whether any debugger hint could still produce a notification. The watcher uses this to skip
     * opening and parsing AppHost source documents on every resource poll once every hint has
     * already been shown, suppressed, or satisfied by an installed extension.
     */
    hasPendingNotifications(): boolean {
        for (const hint of debuggerInstallHintsByExtensionId.values()) {
            if (this._canShowNotification(hint)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Shows the coalesced install toast for `hint`. `resourceCount` is the number of running
     * resources across every AppHost that need this debugger extension, because the toast is shown
     * at most once per extension id and therefore has to speak for all of them.
     */
    async showNotificationIfNeeded(hint: DebuggerInstallHint, resourceCount: number): Promise<void> {
        if (!this._canShowNotification(hint)) {
            return;
        }

        // Mark the extension before opening the notification. Repository refreshes can overlap
        // while the toast is awaiting user input, and each language can have several resources
        // across several AppHosts.
        this._notificationsShownThisSession.add(hint.extensionId);

        let selected: string | undefined;
        try {
            selected = await this._dependencies.showInformationMessage(
                debuggerInstallNotification(hint.debuggerName, resourceCount),
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
            await this._globalState.update(`${notificationSuppressedKeyPrefix}${hint.extensionId}`, true);
        } else if (selected === debuggerInstallAction) {
            await this.installExtension(hint.extensionId);
        }
    }

    async installExtension(extensionId: string): Promise<void> {
        if (this._disposed) {
            return;
        }

        try {
            await this._dependencies.installExtension(extensionId);
        } catch (error) {
            // Installing goes through the marketplace, so it fails when the user is offline, behind a
            // proxy, or running a build without gallery access. Surface that instead of leaving the
            // hint in place with no explanation.
            if (!this._disposed) {
                const debuggerName = getDebuggerInstallHintForExtension(extensionId)?.debuggerName ?? extensionId;
                void this._dependencies.showErrorMessage(debuggerInstallFailed(debuggerName, getErrorMessage(error)));
            }

            return;
        }

        if (this._disposed) {
            return;
        }

        // `workbench.extensions.installExtension` resolves when the install completes, but the
        // extension host publishes the new extension afterwards, so `getExtension` can still return
        // undefined here. Defer the follow-up guidance until the extension is actually visible;
        // `refresh` re-checks on every `extensions.onDidChange` event.
        this._installsAwaitingActivation.add(extensionId);
        this.refresh();
    }

    refresh(): void {
        if (this._disposed) {
            return;
        }

        this._notifyCompletedInstalls();
        this._onDidChange.fire();
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
        this._installsAwaitingActivation.clear();
        this._extensionChangeSubscription.dispose();
        this._onDidChange.dispose();
    }

    private _canShowNotification(hint: DebuggerInstallHint): boolean {
        return !this._disposed
            && !this._dependencies.getExtension(hint.extensionId)
            && !this._notificationsShownThisSession.has(hint.extensionId)
            && !this._globalState.get<boolean>(`${notificationSuppressedKeyPrefix}${hint.extensionId}`, false);
    }

    private _notifyCompletedInstalls(): void {
        for (const extensionId of [...this._installsAwaitingActivation]) {
            if (!this._dependencies.getExtension(extensionId)) {
                continue;
            }

            this._installsAwaitingActivation.delete(extensionId);

            // Debug capabilities are snapshotted into DEBUG_SESSION_INFO / ASPIRE_EXTENSION_CAPABILITIES
            // when the AppHost process starts (see utils/AspireTerminalProvider), so a debugger installed
            // while an AppHost is running only takes effect on the next run. Say so rather than implying
            // the already-running resource became debuggable.
            const debuggerName = getDebuggerInstallHintForExtension(extensionId)?.debuggerName ?? extensionId;
            void this._dependencies.showInformationMessage(debuggerInstalledRestartAppHost(debuggerName));
        }
    }
}

export function createDebuggerInstallHintService(globalState: vscode.Memento): DebuggerInstallHintService {
    return new DebuggerInstallHintService(globalState, {
        getExtension: extensionId => vscode.extensions.getExtension(extensionId),
        onDidChangeExtensions: vscode.extensions.onDidChange,
        showInformationMessage: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        installExtension: installDebuggerExtension,
    });
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
