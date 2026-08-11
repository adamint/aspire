import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AspireCommandType, AspireExtendedDebugConfiguration } from '../dcp/types';
import { startDebuggingDeclined } from '../loc/strings';
import { canonicalizeAppHostPath, getAppHostPathComparisonKey, isSameAppHost } from '../utils/appHostIdentity';
import { classifyAppHostDirectory, classifyAppHostPath } from '../utils/appHostLanguage';
import { classifyError, isCommandCancellation, sendTelemetryEvent, type EventProperties } from '../utils/telemetry';
import { bucketAspireCommand } from '../utils/telemetryBuckets';
import { checkCliAvailableOrRedirect } from '../utils/workspace';

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
                this.clearLaunching(appHostPath);
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
        this._debugSessionSubscription.dispose();
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

    isLaunching(appHostPath: string): boolean {
        return this.getMatchingLaunchingPaths(appHostPath).length > 0;
    }

    /**
     * Clears launching state for the given AppHost path (e.g., when it
     * appears in the running AppHosts list).
     */
    clearLaunching(appHostPath: string): void {
        this.clearLaunchClaims(this.getMatchingLaunchingPaths(appHostPath));
    }

    clearMatchingLaunching(appHostPath: string): void {
        const identityMatches = this.getMatchingLaunchingPaths(appHostPath);
        if (identityMatches.length > 0) {
            this.clearLaunchClaims(identityMatches);
            return;
        }

        const resolvedPath = path.resolve(appHostPath);
        const aliasMatches = Array.from(this._launchingPaths)
            .filter(launchingPath => isProjectFileToSourceFileMatch(launchingPath, resolvedPath));
        if (aliasMatches.length === 1) {
            this.clearLaunchClaims(aliasMatches);
        }
    }

    private clearLaunchClaims(matchingPaths: readonly string[]): void {
        let changed = false;
        for (const matchingPath of matchingPaths) {
            changed = this._launchingPaths.delete(matchingPath) || changed;
        }

        if (changed) {
            this._onDidChangeLaunchingState.fire();
        }
    }

    /**
     * Launches an Aspire debug session for the given AppHost path.
     * Automatically marks the path as "launching" until it either appears
     * in the running list or the debug session terminates.
     * @param appHostPath Absolute path to the AppHost project.
     * @param command The Aspire CLI command to execute (run, deploy, publish, do).
     * @param noDebug When true, launches without the debugger attached.
     * @param doStep Optional step name for the 'do' command.
     * @param cancellationToken Optional cancellation for asynchronous pre-launch gates.
     * @returns Whether this call claimed and started a new launch.
     */
    async launch(
        appHostPath: string,
        command: AspireCommandType,
        noDebug: boolean,
        doStep?: string,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<boolean> {
        throwIfCancellationRequested(cancellationToken);
        const claimedPath = this.tryClaimLaunch(appHostPath);
        if (claimedPath === undefined) {
            return false;
        }

        const startTime = Date.now();
        const executionSuppressed = isE2eDebugLaunchSuppressed();
        let telemetryProperties: Awaited<ReturnType<typeof getLaunchTelemetryProperties>> | undefined;
        let requestEmitted = false;

        try {
            telemetryProperties = await getLaunchTelemetryProperties(appHostPath, command, noDebug, executionSuppressed);
            throwIfCancellationRequested(cancellationToken);

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
            requestEmitted = true;
            if (executionSuppressed) {
                this.releaseLaunchClaim(claimedPath);
                sendTelemetryEvent('aspire/vscode/apphost/launch/result', {
                    ...telemetryProperties,
                    outcome: 'suppressed',
                }, {
                    duration_ms: Date.now() - startTime,
                });
                return true;
            }

            const cliAvailability = await checkCliAvailableOrRedirect('debug_gate');
            throwIfCancellationRequested(cancellationToken);
            if (!cliAvailability.available) {
                throw new vscode.CancellationError();
            }
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
            return true;
        } catch (err) {
            this.releaseLaunchClaim(claimedPath);
            if (requestEmitted && telemetryProperties) {
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
            }
            throw err;
        }
    }

    private tryClaimLaunch(appHostPath: string): string | undefined {
        const resolvedPath = path.resolve(appHostPath);
        if (this.getMatchingLaunchingPaths(resolvedPath).length > 0 ||
            Array.from(this._launchingPaths).some(launchingPath => isProjectFileToSourceFileMatch(launchingPath, resolvedPath))) {
            return undefined;
        }

        // The check and add are synchronous so editor, tree, and language-model callers
        // cannot interleave different lexical paths for the same physical AppHost.
        this._launchingPaths.add(resolvedPath);
        this._onDidChangeLaunchingState.fire();
        return resolvedPath;
    }

    private releaseLaunchClaim(claimedPath: string): void {
        if (this._launchingPaths.delete(claimedPath)) {
            this._onDidChangeLaunchingState.fire();
        }
    }

    private getMatchingLaunchingPaths(appHostPath: string): string[] {
        const resolvedPath = path.resolve(appHostPath);
        return Array.from(this._launchingPaths).filter(launchingPath => isSameLaunchingIdentity(launchingPath, resolvedPath));
    }
}

function throwIfCancellationRequested(token: vscode.CancellationToken | undefined): void {
    if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
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

function isSameLaunchingIdentity(left: string, right: string): boolean {
    if (isSameAppHost(left, right)) {
        return true;
    }

    const canonicalLeft = canonicalizeAppHostPath(left);
    const canonicalRight = canonicalizeAppHostPath(right);
    return getAppHostPathComparisonKey(path.dirname(canonicalLeft)) === getAppHostPathComparisonKey(path.dirname(canonicalRight)) &&
        isProjectAndAppHostSourcePair(canonicalLeft, canonicalRight);
}

function isProjectFileToSourceFileMatch(left: string, right: string): boolean {
    const canonicalLeft = canonicalizeAppHostPath(left);
    const canonicalRight = canonicalizeAppHostPath(right);
    return getAppHostPathComparisonKey(path.dirname(canonicalLeft)) === getAppHostPathComparisonKey(path.dirname(canonicalRight)) &&
        ((isProjectFile(canonicalLeft) && isSourceFile(canonicalRight)) ||
            (isSourceFile(canonicalLeft) && isProjectFile(canonicalRight)));
}

function isProjectAndAppHostSourcePair(left: string, right: string): boolean {
    return (isProjectFile(left) && isAppHostSourceFile(right)) ||
        (isAppHostSourceFile(left) && isProjectFile(right));
}

function isProjectFile(value: string): boolean {
    return path.extname(value).toLowerCase() === '.csproj';
}

function isAppHostSourceFile(value: string): boolean {
    return path.basename(value).toLowerCase() === 'apphost.cs';
}

function isSourceFile(value: string): boolean {
    const fileName = path.basename(value).toLowerCase();
    return fileName === 'apphost.cs' || fileName === 'program.cs';
}
