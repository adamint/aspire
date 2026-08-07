import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AspireCommandType, AspireExtendedDebugConfiguration, AspireOperationKind } from '../dcp/types';
import { appHostLifecycleBusy, startDebuggingDeclined } from '../loc/strings';
import { classifyAppHostDirectory, classifyAppHostPath } from '../utils/appHostLanguage';
import { classifyError, isCommandCancellation, sendTelemetryEvent, type EventProperties } from '../utils/telemetry';
import { bucketAspireCommand } from '../utils/telemetryBuckets';
import { checkCliAvailableOrRedirect } from '../utils/workspace';

function getComparisonKey(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isAspireCommandType(value: unknown): value is AspireCommandType {
    return value === 'run' || value === 'deploy' || value === 'publish' || value === 'do';
}

function getTerminationCommand(configuration: vscode.DebugConfiguration): AspireCommandType | undefined {
    // Run is the default Aspire command when omitted from launch configuration.
    if (configuration.command === undefined || configuration.command === null) {
        return 'run';
    }

    return isAspireCommandType(configuration.command) ? configuration.command : undefined;
}

export interface AppHostLaunchRequestedEvent {
    appHostPath: string;
    command: AspireCommandType;
    noDebug: boolean;
    doStep?: string;
    executionSuppressed: boolean;
}

export interface AppHostDebugSessionTerminatedEvent {
    appHostPath: string;
    command?: AspireCommandType;
    shouldRequestStopRefresh: boolean;
}

export interface AppHostLaunchSession {
    readonly appHostPath: string | undefined;
    readonly operationKind: AspireOperationKind;
    readonly startupCompleted: boolean;
    readonly configuration: { readonly noDebug?: boolean;[key: string]: unknown };
    stopDebugging(): Promise<void>;
}

export interface RunningAppHost {
    readonly appHostPath: string;
}

export const appHostLifecycleLockWaitTimeoutMs = 10_000;

export class AppHostLifecycleLockTimeoutError extends Error {
    constructor() {
        // `AppHostLaunchService.launch` is the editor's own run/debug path, so this
        // message can reach a notification via showErrorMessage. It must therefore be
        // localized, unlike the tool path where the timeout only maps to a `busy` outcome.
        super(appHostLifecycleBusy);
        this.name = 'AppHostLifecycleLockTimeoutError';
    }
}

/**
 * Centralizes all Aspire AppHost launch operations that require a resolved
 * AppHost path. Both the editor command provider (which discovers the path)
 * and the tree provider (which extracts it from a tree item) delegate here.
 *
 * Also tracks which AppHost paths are currently in a "launching" state
 * (between the user clicking Run/Debug and the AppHost appearing in the
 * running list or the debug session terminating).
 */
export class AppHostLaunchService implements vscode.Disposable {
    private readonly _launchingPaths = new Set<string>();
    private readonly _lifecycleLocks = new Map<string, Promise<unknown>>();
    private readonly _lifecycleCancellationSource = new vscode.CancellationTokenSource();
    private _getEditorSessions: () => readonly AppHostLaunchSession[] = () => [];
    private _getRunningAppHosts: (token: vscode.CancellationToken) => Promise<readonly RunningAppHost[]> = async () => [];
    private _disposed = false;

    private readonly _onDidChangeLaunchingState = new vscode.EventEmitter<void>();
    readonly onDidChangeLaunchingState = this._onDidChangeLaunchingState.event;

    private readonly _onDidTerminateAppHostDebugSession = new vscode.EventEmitter<AppHostDebugSessionTerminatedEvent>();
    readonly onDidTerminateAppHostDebugSession = this._onDidTerminateAppHostDebugSession.event;

    private readonly _onDidRequestLaunch = new vscode.EventEmitter<AppHostLaunchRequestedEvent>();
    readonly onDidRequestLaunch = this._onDidRequestLaunch.event;

    private readonly _debugSessionSubscription: vscode.Disposable;

    constructor() {
        // When a debug session terminates, clear launching state for that AppHost
        // so the tree reverts from "Starting..." if the launch failed or was cancelled.
        this._debugSessionSubscription = vscode.debug.onDidTerminateDebugSession(session => {
            const appHostPath = session.configuration?.program;
            if (appHostPath && session.configuration?.type === 'aspire') {
                const key = getComparisonKey(path.resolve(appHostPath));
                if (this._launchingPaths.delete(key)) {
                    this._onDidChangeLaunchingState.fire();
                }
                const command = getTerminationCommand(session.configuration);
                this._onDidTerminateAppHostDebugSession.fire({
                    appHostPath,
                    command,
                    shouldRequestStopRefresh: command === 'run',
                });
            }
        });
    }

    dispose(): void {
        this._disposed = true;
        this._lifecycleCancellationSource.cancel();
        this._lifecycleCancellationSource.dispose();
        this._debugSessionSubscription.dispose();
        this._lifecycleLocks.clear();
        this._onDidChangeLaunchingState.dispose();
        this._onDidTerminateAppHostDebugSession.dispose();
        this._onDidRequestLaunch.dispose();
    }

    /**
     * Returns whether the given AppHost path is currently in a launching state.
     */
    get launchingPaths(): readonly string[] {
        return Array.from(this._launchingPaths);
    }

    get pendingLifecycleOperationCount(): number {
        return this._lifecycleLocks.size;
    }

    setEditorSessionProvider(provider: () => readonly AppHostLaunchSession[]): void {
        this._getEditorSessions = provider;
    }

    setRunningAppHostProvider(provider: (token: vscode.CancellationToken) => Promise<readonly RunningAppHost[]>): void {
        this._getRunningAppHosts = provider;
    }

    getEditorOwnedRunSessions(appHostPath: string): readonly AppHostLaunchSession[] {
        return this._getEditorSessions().filter(session =>
            session.operationKind === 'run' &&
            this.isSameAppHostIdentity(session.appHostPath, appHostPath));
    }

    async getRunningAppHosts(token: vscode.CancellationToken): Promise<readonly RunningAppHost[]> {
        throwIfCancelled(token);
        const appHosts = await this._getRunningAppHosts(token);
        throwIfCancelled(token);
        return appHosts;
    }

    isSameAppHostIdentity(left: string | undefined, right: string | undefined): boolean {
        if (!left || !right) {
            return false;
        }

        return isMatchingAppHostPath(path.resolve(left), path.resolve(right));
    }

    async runWithAppHostLifecycleLock<T>(appHostPath: string, token: vscode.CancellationToken, action: () => Promise<T>): Promise<T> {
        throwIfCancelled(token);
        const key = this.getLifecycleLockKey(appHostPath);
        const previous = this._lifecycleLocks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        // The queue tail follows the prior owner and this operation's gate. A cancelled
        // waiter releases its gate only after the prior owner settles, so later callers
        // cannot overtake a still-running editor launch.
        const tail = previous.then(() => gate, () => gate);
        this._lifecycleLocks.set(key, tail);
        void tail.then(() => {
            if (this._lifecycleLocks.get(key) === tail) {
                this._lifecycleLocks.delete(key);
            }
        });

        let acquired = false;
        try {
            await waitForPromise(previous, token, appHostLifecycleLockWaitTimeoutMs);
            acquired = true;
            throwIfCancelled(token);
            return await action();
        }
        finally {
            if (acquired) {
                release();
            }
            else {
                // Preserve queue ordering even though this caller no longer waits.
                void previous.then(release, release);
            }
        }
    }

    private getLifecycleLockKey(appHostPath: string): string {
        const resolvedPath = path.resolve(appHostPath);
        for (const existingKey of this._lifecycleLocks.keys()) {
            if (isMatchingAppHostPath(existingKey, resolvedPath)) {
                return existingKey;
            }
        }

        return getComparisonKey(path.normalize(resolvedPath));
    }

    isLaunching(appHostPath: string): boolean {
        const resolvedAppHostPath = path.resolve(appHostPath);
        const exactKey = getComparisonKey(path.normalize(resolvedAppHostPath));
        if (this._launchingPaths.has(exactKey)) {
            return true;
        }

        // The editor can discover a C# AppHost by its project while an agent addresses
        // the same AppHost by Program.cs/AppHost.cs (or vice versa). Keep the launching
        // guard active across that identity boundary after the shared launch lock releases.
        return Array.from(this._launchingPaths).some(launchingPath =>
            isMatchingAppHostPath(launchingPath, resolvedAppHostPath));
    }

    /**
     * Clears launching state for the given AppHost path (e.g., when it
     * appears in the running AppHosts list).
     */
    clearLaunching(appHostPath: string): void {
        const key = getComparisonKey(path.resolve(appHostPath));
        if (this._launchingPaths.delete(key)) {
            this._onDidChangeLaunchingState.fire();
        }
    }

    clearMatchingLaunching(appHostPath: string): void {
        const resolvedAppHostPath = path.resolve(appHostPath);
        const exactKey = getComparisonKey(path.normalize(resolvedAppHostPath));
        if (this._launchingPaths.delete(exactKey)) {
            this._onDidChangeLaunchingState.fire();
            return;
        }

        const matchingPaths = Array.from(this._launchingPaths).filter(launchingPath => isMatchingAppHostPath(launchingPath, resolvedAppHostPath));
        if (matchingPaths.length !== 1) {
            return;
        }

        this._launchingPaths.delete(matchingPaths[0]);
        this._onDidChangeLaunchingState.fire();
    }

    /**
     * Launches an Aspire debug session for the given AppHost path.
     * Automatically marks the path as "launching" until it either appears
     * in the running list or the debug session terminates.
     * @param appHostPath Absolute path to the AppHost project.
     * @param command The Aspire CLI command to execute (run, deploy, publish, do).
     * @param noDebug When true, launches without the debugger attached.
     * @param doStep Optional step name for the 'do' command.
     */
    async launch(appHostPath: string, command: AspireCommandType, noDebug: boolean, doStep?: string): Promise<void> {
        return await this.runWithAppHostLifecycleLock(appHostPath, this._lifecycleCancellationSource.token, async () => {
            if (this._disposed) {
                throw new vscode.CancellationError();
            }

            await this.launchCore(appHostPath, command, noDebug, doStep, this._lifecycleCancellationSource.token);
        });
    }

    async launchFromLifecycleOwner(appHostPath: string, command: 'run', noDebug: boolean, token: vscode.CancellationToken): Promise<void> {
        if (this._disposed) {
            throw new vscode.CancellationError();
        }

        await this.launchCore(appHostPath, command, noDebug, undefined, token);
    }

    private async launchCore(
        appHostPath: string,
        command: AspireCommandType,
        noDebug: boolean,
        doStep: string | undefined,
        token: vscode.CancellationToken,
    ): Promise<void> {
        throwIfCancelled(token);
        const startTime = Date.now();
        const executionSuppressed = isE2eDebugLaunchSuppressed();
        const telemetryProperties = await getLaunchTelemetryProperties(appHostPath, command, noDebug, executionSuppressed);
        throwIfCancelled(token);

        const config: AspireExtendedDebugConfiguration = {
            type: 'aspire',
            name: `Aspire ${command}: ${vscode.workspace.asRelativePath(appHostPath)}`,
            request: 'launch',
            program: appHostPath,
            command,
            noDebug
        };

        if (doStep) {
            config.step = doStep;
        }

        this._onDidRequestLaunch.fire({
            appHostPath,
            command,
            noDebug,
            doStep,
            executionSuppressed,
        });
        throwIfCancelled(token);
        if (executionSuppressed) {
            this.clearLaunching(appHostPath);
            sendTelemetryEvent('aspire/vscode/apphost/launch/result', {
                ...telemetryProperties,
                outcome: 'suppressed',
            }, {
                duration_ms: Date.now() - startTime,
            });
            return;
        }

        try {
            // Track launching state before awaiting the CLI/debug checks so the tree shows
            // "Starting..." immediately after the user invokes the command. Every pre-start
            // failure path below clears it because VS Code will not emit a terminate event.
            // See https://code.visualstudio.com/api/references/vscode-api#debug.startDebugging
            this._launchingPaths.add(getComparisonKey(path.resolve(appHostPath)));
            this._onDidChangeLaunchingState.fire();

            const cliAvailability = await checkCliAvailableOrRedirect('debug_gate');
            if (!cliAvailability.available) {
                throw new vscode.CancellationError();
            }
            throwIfCancelled(token);
            config.skipCliAvailabilityCheck = true;

            const started = await vscode.debug.startDebugging(undefined, config);
            if (!started) {
                // A false result means VS Code declined the launch before the
                // debug session started (for example, no provider matched or
                // an adapter gate rejected it). Surface it as an error so the
                // tree command path does not silently swallow a real launch
                // failure while still clearing the temporary "Starting..." state.
                const error = new Error(startDebuggingDeclined(command, vscode.workspace.asRelativePath(appHostPath)));
                error.name = 'StartDebuggingDeclined';
                throw error;
            }
            sendTelemetryEvent('aspire/vscode/apphost/launch/result', {
                ...telemetryProperties,
                outcome: 'success',
            }, {
                duration_ms: Date.now() - startTime,
            });
        } catch (err) {
            this.clearLaunching(appHostPath);
            const canceled = isCommandCancellation(err);
            const properties: EventProperties<'aspire/vscode/apphost/launch/result'> = {
                ...telemetryProperties,
                outcome: canceled ? 'canceled' : 'error',
            };
            if (!canceled) {
                properties.error_kind = classifyError(err);
            }
            sendTelemetryEvent('aspire/vscode/apphost/launch/result', properties, {
                duration_ms: Date.now() - startTime,
            });
            throw err;
        }
    }

}

function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

function waitForPromise(promise: Promise<unknown>, token: vscode.CancellationToken, timeoutMs: number): Promise<void> {
    if (token.isCancellationRequested) {
        return Promise.reject(new vscode.CancellationError());
    }

    return new Promise<void>((resolve, reject) => {
        let cancellation: vscode.Disposable | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (action: () => void) => {
            if (settled) {
                return;
            }

            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            cancellation?.dispose();
            action();
        };
        timeout = setTimeout(() => {
            finish(() => reject(new AppHostLifecycleLockTimeoutError()));
        }, timeoutMs);
        (timeout as { unref?: () => void }).unref?.();
        cancellation = token.onCancellationRequested(() => {
            finish(() => reject(new vscode.CancellationError()));
        });
        promise.then(
            () => {
                finish(resolve);
            },
            () => {
                finish(resolve);
            });
    });
}

async function getLaunchTelemetryProperties(appHostPath: string, command: AspireCommandType, noDebug: boolean, executionSuppressed: boolean) {
    const isDirectory = isDirectoryForTelemetry(appHostPath);
    return {
        mode: noDebug ? 'run' : 'debug',
        command: bucketAspireCommand(command),
        apphost_language: isDirectory ? await classifyAppHostDirectory(appHostPath) : classifyAppHostPath(appHostPath),
        execution_suppressed: executionSuppressed ? 'true' : 'false',
    };
}

function isDirectoryForTelemetry(appHostPath: string): boolean {
    try {
        return fs.statSync(appHostPath, { throwIfNoEntry: false })?.isDirectory() === true;
    }
    catch {
        return false;
    }
}

function isE2eDebugLaunchSuppressed(): boolean {
    return process.env.ASPIRE_EXTENSION_E2E_ENABLE_BRIDGE === 'true' &&
        !!process.env.ASPIRE_EXTENSION_E2E_STATE_FILE &&
        !!process.env.ASPIRE_EXTENSION_E2E_CONTROL_FILE &&
        process.env.ASPIRE_EXTENSION_E2E_SUPPRESS_DEBUG_LAUNCH === 'true';
}

function isMatchingAppHostPath(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    if (getComparisonKey(normalizedLeft) === getComparisonKey(normalizedRight)) {
        return true;
    }

    return getComparisonKey(path.dirname(normalizedLeft)) === getComparisonKey(path.dirname(normalizedRight)) &&
        isProjectFileToSourceFileMatch(normalizedLeft, normalizedRight);
}

function isProjectFileToSourceFileMatch(left: string, right: string): boolean {
    return (isProjectFile(left) && isSourceFile(right)) || (isSourceFile(left) && isProjectFile(right));
}

function isProjectFile(value: string): boolean {
    return path.extname(value).toLowerCase() === '.csproj';
}

function isSourceFile(value: string): boolean {
    const fileName = path.basename(value).toLowerCase();
    return fileName === 'apphost.cs' || fileName === 'program.cs';
}
