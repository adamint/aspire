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
const identityChangingCharacters = /[\u0000-\u001F\u007F-\u009F]|\p{Cf}/u;

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
    isLaunching(appHostPath: string): boolean;
    launch(appHostPath: string, command: 'run', noDebug: boolean): Promise<void>;
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

export class AppHostLifecycleToolService implements vscode.Disposable {
    private readonly _pendingStarts = new Set<string>();
    private readonly _pendingStops = new Set<string>();
    private readonly _workspaceFolderIds = new Map<string, number>();
    private _nextWorkspaceFolderId = 1;
    private _disposed = false;

    constructor(private readonly _dependencies: AppHostLifecycleToolDependencies) {
    }

    dispose(): void {
        this._disposed = true;
        this._pendingStarts.clear();
        this._pendingStops.clear();
    }

    async describeTarget(rawAppHostPath: unknown, token: vscode.CancellationToken): Promise<string> {
        const resolution = await this.resolveTarget(rawAppHostPath, token);
        return resolution.resolved ? resolution.target.selector : appHostLifecycleUnresolvedPath;
    }

    async start(input: unknown, token: vscode.CancellationToken): Promise<AppHostLifecycleToolResult> {
        if (this._disposed) {
            return createResult(aspireAppHostStartToolName, 'cancelled', '', 'none');
        }

        if (!isStartInput(input)) {
            return createResult(aspireAppHostStartToolName, 'invalidInput', '', 'none');
        }

        const resolution = await this.resolveTarget(input.appHostPath, token);
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

        if (this._pendingStarts.has(identityKey) || this._dependencies.launchService.isLaunching(target.launchPath)) {
            return createResult(aspireAppHostStartToolName, 'alreadyStarting', target.selector, 'editor', input.mode);
        }

        if (this._pendingStops.has(identityKey)) {
            return createResult(aspireAppHostStartToolName, 'alreadyStopping', target.selector, 'editor', input.mode);
        }

        this._pendingStarts.add(identityKey);
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

            if (this._dependencies.launchService.isLaunching(target.launchPath)) {
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

            await this._dependencies.launchService.launch(target.launchPath, 'run', input.mode === 'run');
            return createResult(aspireAppHostStartToolName, 'started', target.selector, 'editor', input.mode, input.mode);
        }
        catch (error) {
            return this.createErrorResult(aspireAppHostStartToolName, error, target.selector, input.mode);
        }
        finally {
            this._pendingStarts.delete(identityKey);
        }
    }

    async stop(input: unknown, token: vscode.CancellationToken): Promise<AppHostLifecycleToolResult> {
        if (this._disposed) {
            return createResult(aspireAppHostStopToolName, 'cancelled', '', 'none');
        }

        if (!isStopInput(input)) {
            return createResult(aspireAppHostStopToolName, 'invalidInput', '', 'none');
        }

        const resolution = await this.resolveTarget(input.appHostPath, token);
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
            const session = editorSessions.sessions[0];
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

        if (this._pendingStarts.has(identityKey) || this._dependencies.launchService.isLaunching(target.launchPath)) {
            return createResult(aspireAppHostStopToolName, 'alreadyStarting', target.selector, 'editor');
        }

        try {
            const externalState = await this.getExternalRunState(target, token);
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

    private async resolveTarget(rawAppHostPath: unknown, token: vscode.CancellationToken): Promise<TargetResolution> {
        if (!vscode.workspace.isTrusted) {
            return { resolved: false, outcome: 'workspaceNotTrusted' };
        }

        if (typeof rawAppHostPath !== 'string' ||
            rawAppHostPath.length === 0 ||
            rawAppHostPath.length > maxAppHostSelectorLength ||
            isAbsolutePath(rawAppHostPath)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        try {
            const selectorKey = toSelectorKey(rawAppHostPath);
            const discoveredTargets = await this.discoverTargets(token);
            const matches = discoveredTargets.targets.filter(target => toSelectorKey(target.selector) === selectorKey);
            if (matches.length === 1) {
                return { resolved: true, target: matches[0] };
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
        let hadFailures = false;

        for (const [index, { folder, candidates, failed }] of discoveredByFolder.entries()) {
            hadFailures ||= failed;
            for (const candidate of candidates) {
                if (candidate.status !== 'buildable' || !path.isAbsolute(candidate.path) || !fs.existsSync(candidate.path)) {
                    continue;
                }

                const relativePath = toContainedRelativePath(folder.uri.fsPath, candidate.path);
                if (!relativePath ||
                    identityChangingCharacters.test(relativePath)) {
                    continue;
                }

                const launchPath = path.resolve(candidate.path);
                const absolutePath = canonicalizeAppHostPath(launchPath);
                const selector = workspaceFolders.length > 1
                    ? `${folderQualifiers[index]}/${relativePath}`
                    : relativePath;
                if (selector.length > maxConfirmationPathLength || identityChangingCharacters.test(selector)) {
                    continue;
                }

                const selectorKey = toSelectorKey(selector);
                const existing = targets.get(selectorKey);
                if (!existing || getAppHostPathComparisonKey(existing.absolutePath) === getAppHostPathComparisonKey(absolutePath)) {
                    targets.set(selectorKey, { launchPath, absolutePath, selector });
                }
            }
        }

        return {
            targets: [...targets.values()].sort((left, right) => left.selector.localeCompare(right.selector)),
            hadFailures,
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
    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AppHostStartToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const appHostPath = await this._service.describeTarget(options.input?.appHostPath, token);
        const mode = isLifecycleMode(options.input?.mode) ? options.input.mode : appHostLifecycleUnspecifiedMode;
        return {
            invocationMessage: appHostLifecycleStartInvocationMessage(appHostPath),
            confirmationMessages: {
                title: appHostLifecycleStartConfirmationTitle,
                message: appHostLifecycleStartConfirmationMessage(appHostPath, mode),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AppHostStartToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.start(options.input, token));
    }
}

export class AppHostStopLanguageModelTool implements vscode.LanguageModelTool<AppHostStopToolInput> {
    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AppHostStopToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const appHostPath = await this._service.describeTarget(options.input?.appHostPath, token);
        return {
            invocationMessage: appHostLifecycleStopInvocationMessage(appHostPath),
            confirmationMessages: {
                title: appHostLifecycleStopConfirmationTitle,
                message: appHostLifecycleStopConfirmationMessage(appHostPath),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AppHostStopToolInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.stop(options.input, token));
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

function isAbsolutePath(value: string): boolean {
    return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function toSelectorKey(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
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
