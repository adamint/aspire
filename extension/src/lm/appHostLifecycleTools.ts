import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { appHostTelemetryTargetPathConfigKey } from '../debugger/AspireDebugConfigurationMetadata';
import {
    appHostLifecycleStartConfirmationMessage,
    appHostLifecycleStartConfirmationTitle,
    appHostLifecycleStartInvocationMessage,
    appHostLifecycleStopConfirmationMessage,
    appHostLifecycleStopConfirmationTitle,
    appHostLifecycleStopInvocationMessage,
    appHostLifecycleUnresolvedPath,
    appHostLifecycleUnspecifiedMode,
} from '../loc/strings';
import { type CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';
import {
    canonicalizeAppHostPath,
    compareAppHostIdentity,
    getAppHostPathComparisonKey,
} from '../utils/appHostIdentity';
import { extensionLogOutputChannel } from '../utils/logging';
import { isCommandCancellation } from '../utils/telemetry';

export const aspireAppHostStartToolName = 'aspire_apphost_start';
export const aspireAppHostStopToolName = 'aspire_apphost_stop';

const maxAppHostSelectorLength = 4096;
const maxConfirmationPathLength = 512;
const maxReportedKnownAppHosts = 32;
const maxPreparedInvocationRecords = 64;
const preparedInvocationRecordLifetimeMs = 5 * 60 * 1000;
const identityChangingCharacters = /[\u0000-\u001F\u007F-\u009F]|\p{Cf}/u;
const nonDisplayCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

export type AppHostLifecycleMode = 'run' | 'debug';
export type AppHostLifecycleController = 'editor' | 'external' | 'none' | 'unknown';
export type AppHostLifecycleOutcome =
    | 'started'
    | 'alreadyStarting'
    | 'alreadyRunning'
    | 'stopped'
    | 'alreadyStopping'
    | 'notRunning'
    | 'notEditorOwned'
    | 'ambiguousSession'
    | 'invalidInput'
    | 'unknownAppHost'
    | 'discoveryFailed'
    | 'workspaceNotTrusted'
    | 'cancelled'
    | 'failed';

export interface AppHostStartToolInput {
    appHostPath: string;
    mode: AppHostLifecycleMode;
}

export interface AppHostStopToolInput {
    appHostPath: string;
}

export interface AppHostLifecycleToolResult {
    tool: string;
    outcome: AppHostLifecycleOutcome;
    appHostPath: string;
    controller: AppHostLifecycleController;
    requestedMode?: AppHostLifecycleMode;
    effectiveMode?: AppHostLifecycleMode;
    knownAppHosts?: readonly string[];
}

export interface AppHostLifecycleLaunchService {
    readonly launchingPaths: Iterable<string>;
    launch(
        appHostPath: string,
        command: 'run',
        noDebug: boolean,
        doStep: undefined,
        token: vscode.CancellationToken,
    ): Promise<boolean>;
}

export interface AppHostLifecycleDiscoveryService {
    discover(
        workspaceFolder: vscode.WorkspaceFolder,
        forceRefresh?: boolean,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<readonly CandidateAppHostDisplayInfo[]>;
}

export interface AppHostLifecycleRunningAppHost {
    readonly appHostPath: string;
}

export interface AppHostLifecycleEditorSession {
    readonly appHostPath: string | undefined;
    readonly configuration: vscode.DebugConfiguration;
    stopDebugging(): Promise<void>;
}

export interface AppHostLifecycleToolDependencies {
    readonly launchService: AppHostLifecycleLaunchService;
    readonly discoveryService: AppHostLifecycleDiscoveryService;
    readonly getEditorSessions: () => readonly AppHostLifecycleEditorSession[];
    readonly getRunningAppHosts: (token: vscode.CancellationToken) => Promise<readonly AppHostLifecycleRunningAppHost[]>;
}

interface ResolvedAppHostTarget {
    // AppHostLaunchService tracks in-flight launches by path.resolve(program), so preserve
    // the lexical workspace-relative path even when the underlying file lives under a symlink.
    readonly launchPath: string;
    // Containment checks and AppHost identity comparisons still run on the canonical path so
    // symlinked workspaces collapse to the same physical AppHost.
    readonly absolutePath: string;
    readonly selector: string;
}

interface DiscoveredTargets {
    readonly targets: readonly ResolvedAppHostTarget[];
    readonly hadFailures: boolean;
    readonly hadSuppressedCandidates: boolean;
}

type TargetResolution =
    | { readonly resolved: true; readonly target: ResolvedAppHostTarget }
    | {
        readonly resolved: false;
        readonly outcome: 'invalidInput' | 'unknownAppHost' | 'discoveryFailed' | 'workspaceNotTrusted' | 'cancelled';
        readonly knownAppHosts?: readonly string[];
    };

interface EditorSessionMatches {
    readonly sessions: readonly AppHostLifecycleEditorSession[];
    readonly ambiguous: boolean;
}

type ExternalRunState = 'running' | 'notRunning' | 'unknown';

interface PreparedInvocationRecord<T> {
    readonly key: string;
    readonly value: T;
    readonly expiresAt: number;
}

class PreparedInvocationQueue<T> {
    private readonly _records: PreparedInvocationRecord<T>[] = [];
    private readonly _quarantinedKeys = new Set<string>();
    private _disabled = false;

    enqueue(key: string, value: T): boolean {
        this.pruneExpired();
        if (this._disabled || this._quarantinedKeys.has(key)) {
            return false;
        }

        const existingIndex = this._records.findIndex(record => record.key === key);
        if (existingIndex !== -1) {
            this._records.splice(existingIndex, 1);
            this.addQuarantinedKey(key);
            return false;
        }

        if (this._records.length === maxPreparedInvocationRecords) {
            const evictedRecord = this._records.shift()!;
            this.addQuarantinedKey(evictedRecord.key);
            if (this._disabled) {
                return false;
            }
        }

        this._records.push({
            key,
            value,
            expiresAt: Date.now() + preparedInvocationRecordLifetimeMs,
        });
        return true;
    }

    take(key: string): T | undefined {
        this.pruneExpired();
        if (this._disabled || this._quarantinedKeys.has(key)) {
            return undefined;
        }

        const index = this._records.findIndex(record => record.key === key);
        if (index === -1) {
            return undefined;
        }

        return this._records.splice(index, 1)[0].value;
    }

    private pruneExpired(): void {
        const now = Date.now();
        const expiredKeys = this._records
            .filter(record => record.expiresAt <= now)
            .map(record => record.key);
        if (expiredKeys.length === 0) {
            return;
        }

        const unexpiredRecords = this._records.filter(record => record.expiresAt > now);
        this._records.splice(0, this._records.length, ...unexpiredRecords);
        for (const key of expiredKeys) {
            this.addQuarantinedKey(key);
            if (this._disabled) {
                return;
            }
        }
    }

    private addQuarantinedKey(key: string): void {
        if (this._quarantinedKeys.has(key)) {
            return;
        }

        if (this._quarantinedKeys.size === maxPreparedInvocationRecords) {
            this.disable();
            return;
        }

        this._quarantinedKeys.add(key);
    }

    private disable(): void {
        this._records.length = 0;
        this._quarantinedKeys.clear();
        this._disabled = true;
    }
}

export class AppHostLifecycleToolService implements vscode.Disposable {
    private readonly _pendingStarts = new Set<string>();
    private readonly _pendingStops = new Set<string>();
    private readonly _workspaceFolderIds = new Map<string, number>();
    private readonly _disposalCancellationSource = new vscode.CancellationTokenSource();
    private _nextWorkspaceFolderId = 1;
    private _disposed = false;

    constructor(private readonly _dependencies: AppHostLifecycleToolDependencies) {
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
        this._disposalCancellationSource.cancel();
        this._disposalCancellationSource.dispose();
        this._pendingStarts.clear();
        this._pendingStops.clear();
    }

    async prepareResolution(rawAppHostPath: unknown, token: vscode.CancellationToken): Promise<TargetResolution> {
        return this.resolveTarget(rawAppHostPath, token, true);
    }

    async prepareTarget(rawAppHostPath: unknown, token: vscode.CancellationToken): Promise<ResolvedAppHostTarget | undefined> {
        const resolution = await this.prepareResolution(rawAppHostPath, token);
        return resolution.resolved ? resolution.target : undefined;
    }

    async describeTarget(rawAppHostPath: unknown, token: vscode.CancellationToken): Promise<string | undefined> {
        return (await this.prepareTarget(rawAppHostPath, token))?.selector;
    }

    async start(
        input: unknown,
        token: vscode.CancellationToken,
        preparedTarget?: ResolvedAppHostTarget,
    ): Promise<AppHostLifecycleToolResult> {
        if (this._disposed) {
            return createResult(aspireAppHostStartToolName, 'cancelled', '', 'none');
        }

        if (!isStartInput(input)) {
            return createResult(aspireAppHostStartToolName, 'invalidInput', '', 'none');
        }

        const resolution = await this.resolveTarget(preparedTarget?.selector ?? input.appHostPath, token);
        if (!resolution.resolved) {
            return createResult(
                aspireAppHostStartToolName,
                resolution.outcome,
                '',
                'none',
                input.mode,
                undefined,
                resolution.knownAppHosts);
        }

        if (preparedTarget &&
            getAppHostPathComparisonKey(resolution.target.absolutePath) !== getAppHostPathComparisonKey(preparedTarget.absolutePath)) {
            return createResult(
                aspireAppHostStartToolName,
                'unknownAppHost',
                '',
                'none',
                input.mode,
                undefined,
                [resolution.target.selector]);
        }

        const target = resolution.target;
        const identityKey = getAppHostPathComparisonKey(target.absolutePath);
        const editorSessions = this.getEditorRunSessions(target);
        if (editorSessions.ambiguous || editorSessions.sessions.length > 1) {
            return createResult(aspireAppHostStartToolName, 'ambiguousSession', target.selector, 'unknown', input.mode);
        }

        if (editorSessions.sessions.length > 0) {
            return createResult(
                aspireAppHostStartToolName,
                'alreadyRunning',
                target.selector,
                'editor',
                input.mode,
                getSessionMode(editorSessions.sessions[0]));
        }

        if (this._pendingStarts.has(identityKey) || this.isLaunching(target)) {
            return createResult(aspireAppHostStartToolName, 'alreadyStarting', target.selector, 'editor', input.mode);
        }

        if (this._pendingStops.has(identityKey)) {
            return createResult(aspireAppHostStartToolName, 'alreadyStopping', target.selector, 'editor', input.mode);
        }

        this._pendingStarts.add(identityKey);
        const launchCancellationSource = new vscode.CancellationTokenSource();
        const cancellationRegistration = vscode.Disposable.from(
            token.onCancellationRequested(() => launchCancellationSource.cancel()),
            this._disposalCancellationSource.token.onCancellationRequested(() => launchCancellationSource.cancel()));
        if (token.isCancellationRequested || this._disposed) {
            launchCancellationSource.cancel();
        }

        try {
            const externalState = await this.getExternalRunState(target, token);
            const sessionsAfterProbe = this.getEditorRunSessions(target);
            if (sessionsAfterProbe.ambiguous || sessionsAfterProbe.sessions.length > 1) {
                return createResult(aspireAppHostStartToolName, 'ambiguousSession', target.selector, 'unknown', input.mode);
            }

            if (sessionsAfterProbe.sessions.length > 0) {
                return createResult(
                    aspireAppHostStartToolName,
                    'alreadyRunning',
                    target.selector,
                    'editor',
                    input.mode,
                    getSessionMode(sessionsAfterProbe.sessions[0]));
            }

            if (this.isLaunching(target)) {
                return createResult(aspireAppHostStartToolName, 'alreadyStarting', target.selector, 'editor', input.mode);
            }

            if (externalState === 'running') {
                return createResult(aspireAppHostStartToolName, 'alreadyRunning', target.selector, 'external', input.mode);
            }

            if (externalState === 'unknown') {
                return createResult(aspireAppHostStartToolName, 'failed', target.selector, 'unknown', input.mode);
            }

            if (this._disposed || token.isCancellationRequested) {
                return createResult(aspireAppHostStartToolName, 'cancelled', target.selector, 'none', input.mode);
            }

            const launchAccepted = await this._dependencies.launchService.launch(
                target.launchPath,
                'run',
                input.mode === 'run',
                undefined,
                launchCancellationSource.token);
            if (!launchAccepted) {
                return createResult(aspireAppHostStartToolName, 'alreadyStarting', target.selector, 'editor', input.mode);
            }

            return createResult(aspireAppHostStartToolName, 'started', target.selector, 'editor', input.mode, input.mode);
        }
        catch (error) {
            return this.createErrorResult(aspireAppHostStartToolName, error, target.selector, input.mode);
        }
        finally {
            cancellationRegistration.dispose();
            launchCancellationSource.dispose();
            this._pendingStarts.delete(identityKey);
        }
    }

    async stop(
        input: unknown,
        token: vscode.CancellationToken,
        preparedTarget?: ResolvedAppHostTarget,
    ): Promise<AppHostLifecycleToolResult> {
        if (this._disposed) {
            return createResult(aspireAppHostStopToolName, 'cancelled', '', 'none');
        }

        if (!isStopInput(input)) {
            return createResult(aspireAppHostStopToolName, 'invalidInput', '', 'none');
        }

        const resolution = await this.resolveTarget(preparedTarget?.selector ?? input.appHostPath, token);
        if (!resolution.resolved) {
            return createResult(
                aspireAppHostStopToolName,
                resolution.outcome,
                '',
                'none',
                undefined,
                undefined,
                resolution.knownAppHosts);
        }

        if (preparedTarget &&
            getAppHostPathComparisonKey(resolution.target.absolutePath) !== getAppHostPathComparisonKey(preparedTarget.absolutePath)) {
            return createResult(
                aspireAppHostStopToolName,
                'unknownAppHost',
                '',
                'none',
                undefined,
                undefined,
                [resolution.target.selector]);
        }

        const target = resolution.target;
        if (this._disposed || token.isCancellationRequested) {
            return createResult(aspireAppHostStopToolName, 'cancelled', target.selector, 'none');
        }

        const identityKey = getAppHostPathComparisonKey(target.absolutePath);
        if (this._pendingStops.has(identityKey)) {
            return createResult(aspireAppHostStopToolName, 'alreadyStopping', target.selector, 'editor');
        }

        const editorSessions = this.getEditorRunSessions(target);
        if (editorSessions.ambiguous || editorSessions.sessions.length > 1) {
            return createResult(aspireAppHostStopToolName, 'ambiguousSession', target.selector, 'unknown');
        }

        if (editorSessions.sessions.length === 1) {
            return this.stopEditorSession(target, identityKey, editorSessions.sessions[0]);
        }

        if (this._pendingStarts.has(identityKey) || this.isLaunching(target)) {
            return createResult(aspireAppHostStopToolName, 'alreadyStarting', target.selector, 'editor');
        }

        try {
            const externalState = await this.getExternalRunState(target, token);
            if (this._disposed || token.isCancellationRequested) {
                return createResult(aspireAppHostStopToolName, 'cancelled', target.selector, 'none');
            }

            if (this._pendingStops.has(identityKey)) {
                return createResult(aspireAppHostStopToolName, 'alreadyStopping', target.selector, 'editor');
            }

            const sessionsAfterProbe = this.getEditorRunSessions(target);
            if (sessionsAfterProbe.ambiguous || sessionsAfterProbe.sessions.length > 1) {
                return createResult(aspireAppHostStopToolName, 'ambiguousSession', target.selector, 'unknown');
            }

            if (sessionsAfterProbe.sessions.length === 1) {
                return this.stopEditorSession(target, identityKey, sessionsAfterProbe.sessions[0]);
            }

            if (externalState === 'running') {
                return createResult(aspireAppHostStopToolName, 'notEditorOwned', target.selector, 'external');
            }

            if (externalState === 'unknown') {
                return createResult(aspireAppHostStopToolName, 'failed', target.selector, 'unknown');
            }
        }
        catch (error) {
            return this.createErrorResult(aspireAppHostStopToolName, error, target.selector);
        }

        return createResult(aspireAppHostStopToolName, 'notRunning', target.selector, 'none');
    }

    private async resolveTarget(
        rawAppHostPath: unknown,
        token: vscode.CancellationToken,
        allowSingleTargetFallback = false,
    ): Promise<TargetResolution> {
        if (!vscode.workspace.isTrusted) {
            return { resolved: false, outcome: 'workspaceNotTrusted' };
        }

        if (typeof rawAppHostPath !== 'string' ||
            rawAppHostPath.length === 0 ||
            rawAppHostPath.length > maxAppHostSelectorLength ||
            isAbsolutePath(rawAppHostPath) ||
            identityChangingCharacters.test(rawAppHostPath)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        try {
            const selectorKey = toSelectorKey(rawAppHostPath);
            const discoveredTargets = await this.discoverTargets(token);
            const matches = discoveredTargets.targets.filter(target => toSelectorKey(target.selector) === selectorKey);
            if (matches.length === 1) {
                return { resolved: true, target: matches[0] };
            }

            if (allowSingleTargetFallback &&
                !discoveredTargets.hadFailures &&
                !discoveredTargets.hadSuppressedCandidates &&
                discoveredTargets.targets.length === 1) {
                return { resolved: true, target: discoveredTargets.targets[0] };
            }

            if (discoveredTargets.hadFailures) {
                return { resolved: false, outcome: 'discoveryFailed' };
            }

            return {
                resolved: false,
                outcome: 'unknownAppHost',
                knownAppHosts: discoveredTargets.targets.slice(0, maxReportedKnownAppHosts).map(target => target.selector),
            };
        }
        catch (error) {
            if (isCommandCancellation(error)) {
                return { resolved: false, outcome: 'cancelled' };
            }

            extensionLogOutputChannel.warn(`Aspire AppHost lifecycle tool discovery failed: ${String(error)}`);
            return { resolved: false, outcome: 'discoveryFailed' };
        }
    }

    private async discoverTargets(token: vscode.CancellationToken): Promise<DiscoveredTargets> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const discoveredByFolder = await Promise.all(workspaceFolders.map(async folder => {
            try {
                return {
                    folder,
                    candidates: await this._dependencies.discoveryService.discover(folder, false, token),
                    failed: false,
                };
            }
            catch (error) {
                if (isCommandCancellation(error)) {
                    throw error;
                }

                // One noisy workspace folder should not hide buildable AppHosts discovered from
                // the other roots. Cancellation is still handled above so the whole request can stop.
                extensionLogOutputChannel.warn(`Aspire AppHost lifecycle tool discovery skipped workspace folder '${folder.name}': ${String(error)}`);
                return {
                    folder,
                    candidates: [] as readonly CandidateAppHostDisplayInfo[],
                    failed: true,
                };
            }
        }));
        const folderQualifiers = workspaceFolders.map(folder => this.getWorkspaceFolderQualifier(folder));
        const targets = new Map<string, ResolvedAppHostTarget>();
        const ambiguousSelectorKeys = new Set<string>();
        let hadFailures = false;
        let hadSuppressedCandidates = false;

        for (const [index, { folder, candidates, failed }] of discoveredByFolder.entries()) {
            hadFailures ||= failed;
            for (const candidate of candidates) {
                if (candidate.status !== 'buildable') {
                    continue;
                }

                if (!path.isAbsolute(candidate.path) || !fs.existsSync(candidate.path)) {
                    hadSuppressedCandidates = true;
                    continue;
                }

                const relativePath = toContainedRelativePath(folder.uri.fsPath, candidate.path);
                if (!relativePath ||
                    identityChangingCharacters.test(relativePath)) {
                    hadSuppressedCandidates = true;
                    continue;
                }

                const launchPath = path.resolve(candidate.path);
                const absolutePath = canonicalizeAppHostPath(launchPath);
                const selector = workspaceFolders.length > 1
                    ? `${folderQualifiers[index]}/${relativePath}`
                    : relativePath;
                if (selector.length > maxConfirmationPathLength || identityChangingCharacters.test(selector)) {
                    hadSuppressedCandidates = true;
                    continue;
                }

                const selectorKey = toSelectorKey(selector);
                if (ambiguousSelectorKeys.has(selectorKey)) {
                    hadSuppressedCandidates = true;
                    continue;
                }

                const existing = targets.get(selectorKey);
                if (!existing) {
                    targets.set(selectorKey, { launchPath, absolutePath, selector });
                    continue;
                }

                if (getAppHostPathComparisonKey(existing.absolutePath) !== getAppHostPathComparisonKey(absolutePath)) {
                    targets.delete(selectorKey);
                    ambiguousSelectorKeys.add(selectorKey);
                    hadSuppressedCandidates = true;
                }
            }
        }

        return {
            targets: [...targets.values()].sort((left, right) => left.selector.localeCompare(right.selector)),
            hadFailures,
            hadSuppressedCandidates,
        };
    }

    private getWorkspaceFolderQualifier(folder: vscode.WorkspaceFolder): string {
        const key = getAppHostPathComparisonKey(folder.uri.fsPath);
        let id = this._workspaceFolderIds.get(key);
        if (id === undefined) {
            id = this._nextWorkspaceFolderId++;
            this._workspaceFolderIds.set(key, id);
        }

        return `${toRelativeQualifierSegment(folder.name)}~${id}`;
    }

    private getEditorRunSessions(target: ResolvedAppHostTarget): EditorSessionMatches {
        const sessions: AppHostLifecycleEditorSession[] = [];
        let ambiguous = false;

        for (const session of this._dependencies.getEditorSessions()) {
            if (getAspireCommand(session.configuration) !== 'run') {
                continue;
            }

            const sessionPath = getSessionAppHostPath(session);
            const relation = compareAppHostIdentity(sessionPath, target.absolutePath);
            if (relation === 'same') {
                sessions.push(session);
            }
            else if (relation === 'ambiguous') {
                ambiguous = true;
            }
        }

        return { sessions, ambiguous };
    }

    private isLaunching(target: ResolvedAppHostTarget): boolean {
        for (const launchingPath of this._dependencies.launchService.launchingPaths) {
            if (compareAppHostIdentity(launchingPath, target.absolutePath) === 'same') {
                return true;
            }
        }

        return false;
    }

    private async stopEditorSession(
        target: ResolvedAppHostTarget,
        identityKey: string,
        session: AppHostLifecycleEditorSession,
    ): Promise<AppHostLifecycleToolResult> {
        const effectiveMode = getSessionMode(session);
        this._pendingStops.add(identityKey);
        try {
            await session.stopDebugging();
            return createResult(aspireAppHostStopToolName, 'stopped', target.selector, 'editor', undefined, effectiveMode);
        }
        catch (error) {
            return this.createErrorResult(aspireAppHostStopToolName, error, target.selector, undefined, effectiveMode);
        }
        finally {
            this._pendingStops.delete(identityKey);
        }
    }

    private async getExternalRunState(target: ResolvedAppHostTarget, token: vscode.CancellationToken): Promise<ExternalRunState> {
        try {
            const runningAppHosts = await this._dependencies.getRunningAppHosts(token);
            let ambiguous = false;
            for (const runningAppHost of runningAppHosts) {
                const relation = compareAppHostIdentity(runningAppHost.appHostPath, target.absolutePath);
                if (relation === 'same') {
                    return 'running';
                }

                ambiguous ||= relation === 'ambiguous';
            }

            return ambiguous ? 'unknown' : 'notRunning';
        }
        catch (error) {
            if (isCommandCancellation(error)) {
                throw error;
            }

            extensionLogOutputChannel.warn(`Aspire AppHost lifecycle tool could not query running AppHosts: ${String(error)}`);
            return 'unknown';
        }
    }

    private createErrorResult(
        tool: string,
        error: unknown,
        appHostPath: string,
        requestedMode?: AppHostLifecycleMode,
        effectiveMode?: AppHostLifecycleMode,
    ): AppHostLifecycleToolResult {
        if (isCommandCancellation(error)) {
            return createResult(tool, 'cancelled', appHostPath, 'none', requestedMode, effectiveMode);
        }

        extensionLogOutputChannel.error(`Aspire language model tool ${tool} failed: ${String(error)}`);
        return createResult(tool, 'failed', appHostPath, 'unknown', requestedMode, effectiveMode);
    }
}

export class AppHostStartLanguageModelTool implements vscode.LanguageModelTool<AppHostStartToolInput> {
    private readonly _preparedInvocations = new PreparedInvocationQueue<TargetResolution>();

    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AppHostStartToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const preparation = await this._service.prepareResolution(options.input?.appHostPath, token);
        const accepted = this._preparedInvocations.enqueue(createStartPreparationKey(options.input), preparation);

        const preparedTarget = accepted && preparation.resolved ? preparation.target : undefined;
        const appHostPath = toVisibleDisplayText(preparedTarget?.selector ?? appHostLifecycleUnresolvedPath);
        const mode = isLifecycleMode(options.input?.mode) ? options.input.mode : appHostLifecycleUnspecifiedMode;
        const preparedInvocation: vscode.PreparedToolInvocation = {
            invocationMessage: toPlainTextMarkdown(appHostLifecycleStartInvocationMessage(appHostPath)),
        };
        if (preparedTarget) {
            preparedInvocation.confirmationMessages = {
                title: appHostLifecycleStartConfirmationTitle,
                message: toPlainTextMarkdown(appHostLifecycleStartConfirmationMessage(appHostPath, mode)),
            };
        }

        return preparedInvocation;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AppHostStartToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!isStartInput(options.input)) {
            return createToolResult(createResult(aspireAppHostStartToolName, 'invalidInput', '', 'none'));
        }

        const preparation = this._preparedInvocations.take(createStartPreparationKey(options.input));
        if (!preparation) {
            return createToolResult(createResult(
                aspireAppHostStartToolName,
                'failed',
                '',
                'none',
                options.input.mode));
        }

        if (!preparation.resolved) {
            return createToolResult(createResult(
                aspireAppHostStartToolName,
                preparation.outcome,
                '',
                'none',
                options.input.mode,
                undefined,
                preparation.knownAppHosts));
        }

        return createToolResult(await this._service.start(options.input, token, preparation.target));
    }
}

export class AppHostStopLanguageModelTool implements vscode.LanguageModelTool<AppHostStopToolInput> {
    private readonly _preparedInvocations = new PreparedInvocationQueue<TargetResolution>();

    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AppHostStopToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const preparation = await this._service.prepareResolution(options.input?.appHostPath, token);
        const accepted = this._preparedInvocations.enqueue(createStopPreparationKey(options.input), preparation);

        const preparedTarget = accepted && preparation.resolved ? preparation.target : undefined;
        const appHostPath = toVisibleDisplayText(preparedTarget?.selector ?? appHostLifecycleUnresolvedPath);
        const preparedInvocation: vscode.PreparedToolInvocation = {
            invocationMessage: toPlainTextMarkdown(appHostLifecycleStopInvocationMessage(appHostPath)),
        };
        if (preparedTarget) {
            preparedInvocation.confirmationMessages = {
                title: appHostLifecycleStopConfirmationTitle,
                message: toPlainTextMarkdown(appHostLifecycleStopConfirmationMessage(appHostPath)),
            };
        }

        return preparedInvocation;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AppHostStopToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!isStopInput(options.input)) {
            return createToolResult(createResult(aspireAppHostStopToolName, 'invalidInput', '', 'none'));
        }

        const preparation = this._preparedInvocations.take(createStopPreparationKey(options.input));
        if (!preparation) {
            return createToolResult(createResult(aspireAppHostStopToolName, 'failed', '', 'none'));
        }

        if (!preparation.resolved) {
            return createToolResult(createResult(
                aspireAppHostStopToolName,
                preparation.outcome,
                '',
                'none',
                undefined,
                undefined,
                preparation.knownAppHosts));
        }

        return createToolResult(await this._service.stop(options.input, token, preparation.target));
    }
}

export function registerAppHostLifecycleTools(service: AppHostLifecycleToolService): vscode.Disposable {
    if (typeof vscode.lm?.registerTool !== 'function') {
        extensionLogOutputChannel.info('Skipping Aspire AppHost lifecycle tools because the language model tool API is unavailable.');
        return new vscode.Disposable(() => { });
    }

    extensionLogOutputChannel.info('Registered Aspire AppHost lifecycle language model tools.');
    return vscode.Disposable.from(
        vscode.lm.registerTool(aspireAppHostStartToolName, new AppHostStartLanguageModelTool(service)),
        vscode.lm.registerTool(aspireAppHostStopToolName, new AppHostStopLanguageModelTool(service)));
}

function createToolResult(result: AppHostLifecycleToolResult): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
}

function createResult(
    tool: string,
    outcome: AppHostLifecycleOutcome,
    appHostPath: string,
    controller: AppHostLifecycleController,
    requestedMode?: AppHostLifecycleMode,
    effectiveMode?: AppHostLifecycleMode,
    knownAppHosts?: readonly string[],
): AppHostLifecycleToolResult {
    return {
        tool,
        outcome,
        appHostPath,
        controller,
        ...(requestedMode ? { requestedMode } : {}),
        ...(effectiveMode ? { effectiveMode } : {}),
        ...(knownAppHosts ? { knownAppHosts } : {}),
    };
}

function isStartInput(value: unknown): value is AppHostStartToolInput {
    return typeof value === 'object' &&
        value !== null &&
        typeof (value as AppHostStartToolInput).appHostPath === 'string' &&
        isLifecycleMode((value as AppHostStartToolInput).mode);
}

function isStopInput(value: unknown): value is AppHostStopToolInput {
    return typeof value === 'object' &&
        value !== null &&
        typeof (value as AppHostStopToolInput).appHostPath === 'string';
}

function isLifecycleMode(value: unknown): value is AppHostLifecycleMode {
    return value === 'run' || value === 'debug';
}

function createStartPreparationKey(input: unknown): string {
    const appHostPath = typeof input === 'object' && input !== null
        ? (input as Partial<AppHostStartToolInput>).appHostPath
        : undefined;
    const mode = typeof input === 'object' && input !== null
        ? (input as Partial<AppHostStartToolInput>).mode
        : undefined;
    return createPreparationKey(appHostPath, mode);
}

function createStopPreparationKey(input: unknown): string {
    const appHostPath = typeof input === 'object' && input !== null
        ? (input as Partial<AppHostStopToolInput>).appHostPath
        : undefined;
    return createPreparationKey(appHostPath);
}

function createPreparationKey(...values: readonly unknown[]): string {
    return values.map(value => typeof value === 'string'
        ? `string:${value.length}:${value}`
        : `${typeof value}:`).join('|');
}

function isAbsolutePath(value: string): boolean {
    // Selectors are opaque values emitted by discovery. Syntax from another platform can be a
    // legal filename on this host, so only the host platform's absolute-path rules apply.
    return process.platform === 'win32'
        ? path.win32.isAbsolute(value)
        : path.posix.isAbsolute(value);
}

function toVisibleDisplayText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(nonDisplayCharacters, character => {
        const codePoint = character.codePointAt(0)!;
        const hex = codePoint.toString(16).toUpperCase();
        return codePoint <= 0xFFFF ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
    });
}

function toPlainTextMarkdown(value: string): vscode.MarkdownString {
    return new vscode.MarkdownString().appendText(value);
}

function toSelectorKey(value: string): string {
    // A backslash is a path separator on Windows but a legal filename character on POSIX.
    const normalized = (process.platform === 'win32' ? value.replace(/\\/g, '/') : value)
        .replace(/^\.\//, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toRelativeQualifierSegment(segment: string): string {
    const sanitized = segment
        .replace(/[\\/]/g, '_')
        .replace(/[\u0000-\u001F\u007F-\u009F]|\p{Cf}/gu, '_');
    const relativeSegment = path.win32.isAbsolute(`${sanitized}/x`) ? sanitized.replace(/:/g, '') : sanitized;
    return relativeSegment === '' || relativeSegment === '.' || relativeSegment === '..' ? '_' : relativeSegment;
}

function toContainedRelativePath(folderPath: string, candidatePath: string): string | undefined {
    const relativePath = path.relative(canonicalizeAppHostPath(folderPath), canonicalizeAppHostPath(candidatePath));
    if (relativePath.length === 0 ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)) {
        return undefined;
    }

    return relativePath.split(path.sep).join('/');
}

function getAspireCommand(configuration: vscode.DebugConfiguration): string | undefined {
    return configuration.command === undefined || configuration.command === null
        ? 'run'
        : typeof configuration.command === 'string' ? configuration.command : undefined;
}

function getSessionAppHostPath(session: AppHostLifecycleEditorSession): string | undefined {
    const resolvedAppHostPath = session.configuration[appHostTelemetryTargetPathConfigKey];
    if (typeof resolvedAppHostPath === 'string') {
        return resolvedAppHostPath;
    }

    return session.appHostPath;
}

function getSessionMode(session: AppHostLifecycleEditorSession): AppHostLifecycleMode {
    return session.configuration.noDebug === true ? 'run' : 'debug';
}
