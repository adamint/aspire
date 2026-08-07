import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    appHostLifecycleStartConfirmationMessage,
    appHostLifecycleStartConfirmationTitle,
    appHostLifecycleStartInvocationMessage,
    appHostLifecycleStopConfirmationMessage,
    appHostLifecycleStopConfirmationTitle,
    appHostLifecycleStopInvocationMessage,
    appHostLifecycleUnspecifiedMode,
} from '../loc/strings';
import { isRunnableAppHostFileContents, isSupportedAppHostFileExtension } from '../utils/appHostLanguage';
import { extensionLogOutputChannel } from '../utils/logging';
import { isCommandCancellation } from '../utils/telemetry';

/**
 * Names of the contributed language model tools. These must match the `name`
 * entries under `contributes.languageModelTools` in package.json and the
 * `onLanguageModelTool:` activation events, because VS Code resolves the
 * registration and the manifest entry by name.
 * See https://code.visualstudio.com/api/extension-guides/ai/tools
 */
export const aspireAppHostStartToolName = 'aspire_apphost_start';
export const aspireAppHostStopToolName = 'aspire_apphost_stop';

/** Largest AppHost file we will read while classifying a tool target. */
const maxAppHostBytesInspected = 512 * 1024;

/** Upper bound on model-supplied text echoed back into a confirmation dialog. */
const maxConfirmationPathLength = 120;

export type AppHostLifecycleMode = 'run' | 'debug';

/**
 * Who owns the AppHost process the tool acted on. `editor` means an Aspire debug
 * session created by this extension, `external` means a process the extension can
 * observe but did not start (a terminal, another window, or the CLI directly).
 */
export type AppHostLifecycleOwnership = 'editor' | 'external' | 'none';

export type AppHostLifecycleOutcome =
    | 'started'
    | 'alreadyStarting'
    | 'alreadyRunning'
    | 'stopped'
    | 'notRunning'
    | 'notEditorOwned'
    | 'ambiguousSession'
    | 'invalidInput'
    | 'pathNotFound'
    | 'pathAmbiguous'
    | 'pathOutsideWorkspace'
    | 'pathEscapesWorkspace'
    | 'notAnAppHost'
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

/**
 * The complete result contract returned to the model. Everything here is derived
 * from the tool input and the extension's own lifecycle state — never from CLI
 * output, environment, dashboard URLs, or DCP/RPC credentials — so a tool result
 * cannot become an exfiltration channel for a prompt-injected agent.
 */
export interface AppHostLifecycleToolResult {
    tool: string;
    outcome: AppHostLifecycleOutcome;
    /** Path relative to the containing workspace folder, or empty when the input could not be resolved. */
    appHostPath: string;
    requestedMode?: AppHostLifecycleMode;
    effectiveMode?: AppHostLifecycleMode;
    ownership: AppHostLifecycleOwnership;
}

/**
 * Narrow view of `AppHostLaunchService` used by the tools. Only the editor-owned
 * launch path is reachable: there is deliberately no CLI fallback and no way to
 * request an Aspire command other than `run`.
 */
export interface AppHostLifecycleLaunchService {
    isLaunching(appHostPath: string): boolean;
    launch(appHostPath: string, command: 'run', noDebug: boolean): Promise<void>;
}

/**
 * Narrow view of `AspireDebugSession`. `stopDebugging` is the coordinated stop that
 * terminates the AppHost child session before the Aspire parent session, which is
 * why the stop tool never touches processes directly.
 */
export interface AppHostLifecycleEditorSession {
    readonly appHostPath: string | undefined;
    /** True once the AppHost reported that startup finished and the dashboard is up. */
    readonly startupCompleted: boolean;
    // Mirrors the subset of AspireExtendedDebugConfiguration this surface reads. The
    // index signature keeps the real debug configuration structurally assignable
    // without importing the debugger types into the tool layer.
    readonly configuration: { readonly noDebug?: boolean;[key: string]: unknown };
    stopDebugging(): Promise<void>;
}

export interface AppHostLifecycleToolDependencies {
    readonly launchService: AppHostLifecycleLaunchService;
    getEditorOwnedSessions(): readonly AppHostLifecycleEditorSession[];
    getRunningAppHostPaths(): readonly string[];
}

export interface AppHostLifecycleToolRegistration extends vscode.Disposable {
    readonly registered: boolean;
    /**
     * The registered tool instances by tool name. VS Code does not surface
     * `prepareInvocation` through `vscode.lm`, so E2E automation needs a way to ask the
     * extension's own instance for the confirmation it would present.
     */
    readonly tools: ReadonlyMap<string, PreparableAppHostLifecycleTool>;
}

export interface PreparableAppHostLifecycleTool {
    prepareInvocation(options: { readonly input: Record<string, unknown> }, token: vscode.CancellationToken): vscode.PreparedToolInvocation;
}

interface ResolvedAppHostTarget {
    /** Path as addressed through the workspace folder (symlinks not resolved), used for launching. */
    absolutePath: string;
    /** Path relative to the containing workspace folder, always with `/` separators. */
    relativePath: string;
    /** Fully resolved, case-normalized path used for locking and session matching. */
    comparisonKey: string;
}

type AppHostTargetResolution =
    | { resolved: true; target: ResolvedAppHostTarget }
    | { resolved: false; outcome: AppHostLifecycleOutcome };

type PreflightResult =
    | { rejected: true; result: AppHostLifecycleToolResult }
    | { rejected: false; target: ResolvedAppHostTarget };

/**
 * Backs the `aspire_apphost_start` / `aspire_apphost_stop` language model tools.
 *
 * The service is intentionally the only place that decides whether an agent request
 * may touch AppHost lifecycle state. It canonicalizes the requested path, enforces
 * workspace containment and trust, serializes work per AppHost so concurrent model
 * calls cannot start two processes, and refuses anything it cannot prove is an
 * editor-owned Aspire debug session.
 */
export class AppHostLifecycleToolService implements vscode.Disposable {
    private readonly _dependencies: AppHostLifecycleToolDependencies;
    private readonly _locks = new Map<string, Promise<unknown>>();
    private _disposed = false;

    constructor(dependencies: AppHostLifecycleToolDependencies) {
        this._dependencies = dependencies;
    }

    /** Number of AppHost paths with in-flight work. Exposed so tests can prove locks are released. */
    get pendingLockCount(): number {
        return this._locks.size;
    }

    dispose(): void {
        this._disposed = true;
        this._locks.clear();
    }

    /**
     * Resolves the requested path for display purposes only. Used by
     * `prepareInvocation`, which the VS Code API requires to be side-effect free.
     */
    describeTarget(rawAppHostPath: unknown): string {
        const resolution = this.resolveTarget(rawAppHostPath);
        return resolution.resolved
            ? resolution.target.relativePath
            : sanitizeModelSuppliedText(rawAppHostPath, maxConfirmationPathLength);
    }

    async start(input: AppHostStartToolInput, token: vscode.CancellationToken): Promise<AppHostLifecycleToolResult> {
        const requestedMode = parseMode(input?.mode);
        const preflight = this.preflight(aspireAppHostStartToolName, input?.appHostPath, token, requestedMode);
        if (preflight.rejected) {
            return preflight.result;
        }

        if (!requestedMode) {
            return createResult(aspireAppHostStartToolName, 'invalidInput', '', 'none', undefined, undefined);
        }

        return await this.runExclusive(preflight.target.comparisonKey, async () => {
            // Re-resolve after the confirmation and after waiting on the per-path lock: the
            // file can be deleted or replaced, and a concurrent tool call may already have
            // launched this AppHost while this call was queued.
            const recheck = this.preflight(aspireAppHostStartToolName, input.appHostPath, token, requestedMode);
            if (recheck.rejected) {
                return recheck.result;
            }

            const current = recheck.target;
            const editorSessions = this.findEditorOwnedSessions(current.comparisonKey);
            // A session that finished startup is checked before the launching flag on
            // purpose. That flag is only cleared once `aspire ps` reconciliation observes
            // the process, which can lag far behind the session itself, and answering
            // "still starting" for a fully running AppHost would make an agent poll a
            // state that never changes.
            const runningSession = editorSessions.find(session => session.startupCompleted);
            if (runningSession) {
                return createResult(
                    aspireAppHostStartToolName,
                    'alreadyRunning',
                    current.relativePath,
                    'editor',
                    requestedMode,
                    getSessionMode(runningSession));
            }

            if (this._dependencies.launchService.isLaunching(current.absolutePath) || editorSessions.length > 0) {
                return createResult(aspireAppHostStartToolName, 'alreadyStarting', current.relativePath, 'editor', requestedMode, undefined);
            }

            if (this.isRunningOutsideEditor(current.comparisonKey)) {
                // Launching again would start a second AppHost against the same project.
                // Report it instead so the agent can decide, and never adopt or kill a
                // process this extension does not own.
                return createResult(aspireAppHostStartToolName, 'alreadyRunning', current.relativePath, 'external', requestedMode, undefined);
            }

            try {
                // `noDebug` is the only lever the tool exposes; the Aspire command is pinned
                // to `run` so an agent can never reach deploy/publish/do through this surface.
                await this._dependencies.launchService.launch(current.absolutePath, 'run', requestedMode === 'run');
            }
            catch (error) {
                return this.createErrorResult(aspireAppHostStartToolName, error, current.relativePath, 'editor', requestedMode, undefined);
            }

            return createResult(aspireAppHostStartToolName, 'started', current.relativePath, 'editor', requestedMode, requestedMode);
        });
    }

    async stop(input: AppHostStopToolInput, token: vscode.CancellationToken): Promise<AppHostLifecycleToolResult> {
        const preflight = this.preflight(aspireAppHostStopToolName, input?.appHostPath, token, undefined);
        if (preflight.rejected) {
            return preflight.result;
        }

        return await this.runExclusive(preflight.target.comparisonKey, async () => {
            const recheck = this.preflight(aspireAppHostStopToolName, input.appHostPath, token, undefined);
            if (recheck.rejected) {
                return recheck.result;
            }

            const current = recheck.target;
            const editorSessions = this.findEditorOwnedSessions(current.comparisonKey);
            if (editorSessions.length > 1) {
                // Two sessions claim the same AppHost. Stopping "one of them" would be an
                // arbitrary choice, so refuse and let the user disambiguate in the UI.
                return createResult(aspireAppHostStopToolName, 'ambiguousSession', current.relativePath, 'editor', undefined, undefined);
            }

            if (editorSessions.length === 0) {
                const runningExternally = this.isRunningOutsideEditor(current.comparisonKey);
                return createResult(
                    aspireAppHostStopToolName,
                    runningExternally ? 'notEditorOwned' : 'notRunning',
                    current.relativePath,
                    runningExternally ? 'external' : 'none',
                    undefined,
                    undefined);
            }

            const session = editorSessions[0];
            const effectiveMode = getSessionMode(session);
            try {
                await session.stopDebugging();
            }
            catch (error) {
                return this.createErrorResult(aspireAppHostStopToolName, error, current.relativePath, 'editor', undefined, effectiveMode);
            }

            return createResult(aspireAppHostStopToolName, 'stopped', current.relativePath, 'editor', undefined, effectiveMode);
        });
    }

    /**
     * Canonicalizes a model-supplied AppHost path against the open workspace folders.
     *
     * Resolution never guesses: a relative path that matches files in several folders
     * is ambiguous, a path that leaves the workspace lexically or through a symlink is
     * rejected, and a file that does not look like a runnable Aspire AppHost is refused.
     */
    resolveTarget(rawAppHostPath: unknown): AppHostTargetResolution {
        if (typeof rawAppHostPath !== 'string') {
            return { resolved: false, outcome: 'invalidInput' };
        }

        const requestedPath = rawAppHostPath.trim();
        // A NUL byte truncates the path inside libuv, so a value such as
        // "AppHost/AppHost.csproj\u0000/../../etc/passwd" could pass string checks and
        // then address a different file on disk.
        if (requestedPath.length === 0 || requestedPath.includes('\0')) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
            return { resolved: false, outcome: 'pathOutsideWorkspace' };
        }

        const candidates = path.isAbsolute(requestedPath)
            ? [path.resolve(requestedPath)]
            : workspaceFolders.map(folder => path.resolve(folder.uri.fsPath, requestedPath));
        const existing = candidates.filter(candidate => pathExists(candidate));
        if (existing.length === 0) {
            return { resolved: false, outcome: 'pathNotFound' };
        }

        // Existence is what disambiguates a relative path in a multi-root workspace. When
        // the same relative path exists under more than one folder there is no defensible
        // way to pick one, so the request is refused rather than guessed.
        if (new Set(existing.map(getComparisonKey)).size > 1) {
            return { resolved: false, outcome: 'pathAmbiguous' };
        }

        const absolutePath = existing[0];
        const containingFolder = findContainingWorkspaceFolder(workspaceFolders, absolutePath);
        if (!containingFolder) {
            return { resolved: false, outcome: 'pathOutsideWorkspace' };
        }

        // Containment is checked twice on purpose. The lexical check above rejects
        // `../` traversal, and this real-path check rejects a symlink (or junction)
        // that lives inside the workspace but points outside it.
        const realAppHostPath = tryRealPath(absolutePath);
        const realFolderPath = tryRealPath(containingFolder);
        if (!isContainedIn(realFolderPath, realAppHostPath)) {
            return { resolved: false, outcome: 'pathEscapesWorkspace' };
        }

        if (!isAppHostFile(absolutePath)) {
            return { resolved: false, outcome: 'notAnAppHost' };
        }

        return {
            resolved: true,
            target: {
                absolutePath,
                relativePath: toPosixRelativePath(containingFolder, absolutePath),
                comparisonKey: getComparisonKey(realAppHostPath),
            },
        };
    }

    private preflight(
        tool: string,
        rawAppHostPath: unknown,
        token: vscode.CancellationToken,
        requestedMode: AppHostLifecycleMode | undefined,
    ): PreflightResult {
        const reject = (outcome: AppHostLifecycleOutcome): PreflightResult => ({
            rejected: true,
            result: createResult(tool, outcome, '', 'none', requestedMode, undefined),
        });

        // A disposed service means the extension is deactivating; treat queued work as
        // cancelled rather than starting processes that would outlive the host.
        if (this._disposed || token.isCancellationRequested) {
            return reject('cancelled');
        }

        // Untrusted workspaces can contain hostile project files, and starting an AppHost
        // executes them. Restricted Mode must therefore block the tool even if a
        // registration somehow survived a trust change.
        if (!vscode.workspace.isTrusted) {
            return reject('workspaceNotTrusted');
        }

        const resolution = this.resolveTarget(rawAppHostPath);
        if (!resolution.resolved) {
            return reject(resolution.outcome);
        }

        return { rejected: false, target: resolution.target };
    }

    private findEditorOwnedSessions(comparisonKey: string): AppHostLifecycleEditorSession[] {
        return this._dependencies.getEditorOwnedSessions()
            .filter(session => session.appHostPath !== undefined && getComparisonKey(tryRealPath(session.appHostPath)) === comparisonKey);
    }

    private isRunningOutsideEditor(comparisonKey: string): boolean {
        return this._dependencies.getRunningAppHostPaths()
            .some(runningPath => !!runningPath && getComparisonKey(tryRealPath(runningPath)) === comparisonKey);
    }

    private createErrorResult(
        tool: string,
        error: unknown,
        relativePath: string,
        ownership: AppHostLifecycleOwnership,
        requestedMode: AppHostLifecycleMode | undefined,
        effectiveMode: AppHostLifecycleMode | undefined,
    ): AppHostLifecycleToolResult {
        if (isCommandCancellation(error)) {
            return createResult(tool, 'cancelled', relativePath, ownership, requestedMode, effectiveMode);
        }

        // Failure details stay in the extension log. They routinely contain absolute
        // paths, CLI stderr, and DCP/RPC connection details, none of which may cross
        // back into the model transcript.
        extensionLogOutputChannel.error(`Aspire language model tool ${tool} failed: ${String(error)}`);
        return createResult(tool, 'failed', relativePath, ownership, requestedMode, effectiveMode);
    }

    /**
     * Serializes work per canonical AppHost path. Chaining onto the previous promise
     * (settled or rejected) guarantees a second concurrent call observes the first
     * call's launching/running state instead of racing it into a duplicate process.
     */
    private async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
        const previous = this._locks.get(key) ?? Promise.resolve();
        const current = previous.then(action, action);
        // The tracked promise never rejects so a failed call cannot poison the chain
        // or surface as an unhandled rejection when nothing else awaits it.
        const tracked = current.then(() => undefined, () => undefined);
        this._locks.set(key, tracked);
        try {
            return await current;
        }
        finally {
            // Only the last writer clears the entry, otherwise a queued call would
            // release a lock that a newer call still owns.
            if (this._locks.get(key) === tracked) {
                this._locks.delete(key);
            }
        }
    }
}

export class AppHostStartLanguageModelTool implements vscode.LanguageModelTool<AppHostStartToolInput> {
    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    // The token is part of the API shape but preparation performs no I/O beyond a
    // synchronous path resolution, so there is nothing to abort here; cancellation is
    // honored in invoke() before any side effect.
    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AppHostStartToolInput>, _token: vscode.CancellationToken): vscode.PreparedToolInvocation {
        const displayPath = this._service.describeTarget(options.input?.appHostPath);
        const displayMode = describeRequestedMode(options.input?.mode);
        return {
            invocationMessage: appHostLifecycleStartInvocationMessage(displayPath),
            confirmationMessages: {
                title: appHostLifecycleStartConfirmationTitle,
                message: appHostLifecycleStartConfirmationMessage(displayPath, displayMode),
            },
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<AppHostStartToolInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.start(options.input, token));
    }
}

export class AppHostStopLanguageModelTool implements vscode.LanguageModelTool<AppHostStopToolInput> {
    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AppHostStopToolInput>, _token: vscode.CancellationToken): vscode.PreparedToolInvocation {
        const displayPath = this._service.describeTarget(options.input?.appHostPath);
        return {
            invocationMessage: appHostLifecycleStopInvocationMessage(displayPath),
            confirmationMessages: {
                title: appHostLifecycleStopConfirmationTitle,
                message: appHostLifecycleStopConfirmationMessage(displayPath),
            },
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<AppHostStopToolInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        return createToolResult(await this._service.stop(options.input, token));
    }
}

/**
 * Registers the AppHost lifecycle tools when the stable
 * {@link vscode.lm.registerTool} API exists and the workspace is trusted.
 *
 * The API check keeps the extension loadable on VS Code builds that predate the
 * finalized language model tool API (`engines.vscode` allows older hosts), and the
 * trust check mirrors the `isWorkspaceTrusted` `when` clause in package.json so
 * Restricted Mode never exposes a way to run workspace code from chat.
 */
export function registerAppHostLifecycleTools(service: AppHostLifecycleToolService): AppHostLifecycleToolRegistration {
    const registrations: vscode.Disposable[] = [];
    const startTool = new AppHostStartLanguageModelTool(service);
    const stopTool = new AppHostStopLanguageModelTool(service);
    // The preparable view exists for E2E automation, which only has raw JSON input. The
    // cast is safe because both tools validate every field of the input themselves and
    // treat anything unexpected as invalid rather than trusting the declared type.
    const tools = new Map<string, PreparableAppHostLifecycleTool>([
        [aspireAppHostStartToolName, { prepareInvocation: (options, token) => startTool.prepareInvocation({ input: options.input as unknown as AppHostStartToolInput }, token) }],
        [aspireAppHostStopToolName, { prepareInvocation: (options, token) => stopTool.prepareInvocation({ input: options.input as unknown as AppHostStopToolInput }, token) }],
    ]);
    let trustSubscription: vscode.Disposable | undefined;

    const registerTools = () => {
        if (registrations.length > 0) {
            return;
        }

        registrations.push(
            vscode.lm.registerTool(aspireAppHostStartToolName, startTool),
            vscode.lm.registerTool(aspireAppHostStopToolName, stopTool));
        extensionLogOutputChannel.info('Registered Aspire AppHost lifecycle language model tools.');
    };

    if (typeof vscode.lm?.registerTool !== 'function') {
        extensionLogOutputChannel.info('Skipping Aspire AppHost lifecycle language model tools: the language model tool API is unavailable.');
    }
    else if (vscode.workspace.isTrusted) {
        registerTools();
    }
    else {
        extensionLogOutputChannel.info('Deferring Aspire AppHost lifecycle language model tools until the workspace is trusted.');
        trustSubscription = vscode.workspace.onDidGrantWorkspaceTrust(() => registerTools());
    }

    return {
        get registered() {
            return registrations.length > 0;
        },
        tools,
        dispose() {
            trustSubscription?.dispose();
            trustSubscription = undefined;
            registrations.forEach(registration => registration.dispose());
            registrations.length = 0;
        },
    };
}

function createToolResult(result: AppHostLifecycleToolResult): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
}

function createResult(
    tool: string,
    outcome: AppHostLifecycleOutcome,
    appHostPath: string,
    ownership: AppHostLifecycleOwnership,
    requestedMode: AppHostLifecycleMode | undefined,
    effectiveMode: AppHostLifecycleMode | undefined,
): AppHostLifecycleToolResult {
    const result: AppHostLifecycleToolResult = { tool, outcome, appHostPath, ownership };
    if (requestedMode) {
        result.requestedMode = requestedMode;
    }

    if (effectiveMode) {
        result.effectiveMode = effectiveMode;
    }

    return result;
}

function parseMode(value: unknown): AppHostLifecycleMode | undefined {
    return value === 'run' || value === 'debug' ? value : undefined;
}

function describeRequestedMode(value: unknown): string {
    return parseMode(value) ?? appHostLifecycleUnspecifiedMode;
}

function getSessionMode(session: AppHostLifecycleEditorSession): AppHostLifecycleMode {
    return session.configuration?.noDebug === true ? 'run' : 'debug';
}

/**
 * Bounds and neutralizes model-supplied text before it is rendered in a confirmation
 * dialog. Confirmation messages render as Markdown, so a crafted path could otherwise
 * inject formatting or a wall of text into the prompt the user must approve.
 */
function sanitizeModelSuppliedText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') {
        return '';
    }

    const singleLine = value
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/[`*_[\]<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}

function pathExists(candidate: string): boolean {
    return statOrUndefined(candidate) !== undefined;
}

/**
 * `statSync` only suppresses ENOENT/ENOTDIR via `throwIfNoEntry`. Model-supplied paths
 * can also produce ENAMETOOLONG, EACCES, or ELOOP, and every one of those means the
 * same thing here: this input does not name a usable file.
 */
function statOrUndefined(candidate: string): fs.Stats | undefined {
    try {
        return fs.statSync(candidate, { throwIfNoEntry: false });
    }
    catch {
        return undefined;
    }
}

function isAppHostFile(candidate: string): boolean {
    // Directories are rejected: resolving a directory to the AppHost inside it would
    // mean inferring a target, which this surface must never do.
    if (statOrUndefined(candidate)?.isFile() !== true) {
        return false;
    }

    if (!isSupportedAppHostFileExtension(candidate)) {
        return false;
    }

    try {
        const handle = fs.openSync(candidate, 'r');
        try {
            // Read a bounded prefix so a model cannot point the tool at a huge file and
            // make the extension host allocate it during classification.
            const buffer = Buffer.alloc(maxAppHostBytesInspected);
            const bytesRead = fs.readSync(handle, buffer, 0, maxAppHostBytesInspected, 0);
            return isRunnableAppHostFileContents(candidate, buffer.subarray(0, bytesRead).toString('utf8'));
        }
        finally {
            fs.closeSync(handle);
        }
    }
    catch {
        return false;
    }
}

function findContainingWorkspaceFolder(folders: readonly vscode.WorkspaceFolder[], candidate: string): string | undefined {
    // Workspace folders can nest. The deepest match wins so the reported relative path
    // matches the folder the user would recognize in the explorer.
    let bestMatch: string | undefined;
    for (const folder of folders) {
        const folderPath = folder.uri.fsPath;
        if (isContainedIn(folderPath, candidate) && (!bestMatch || folderPath.length > bestMatch.length)) {
            bestMatch = folderPath;
        }
    }

    return bestMatch;
}

function isContainedIn(folderPath: string, candidate: string): boolean {
    const relative = path.relative(folderPath, candidate);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toPosixRelativePath(folderPath: string, candidate: string): string {
    return path.relative(folderPath, candidate).split(path.sep).join('/');
}

function tryRealPath(candidate: string): string {
    try {
        return fs.realpathSync.native(candidate);
    }
    catch {
        // A path can disappear between resolution and matching (for example a session
        // whose project was deleted while it ran); fall back to the lexical form so
        // matching stays deterministic instead of throwing.
        return path.resolve(candidate);
    }
}

function getComparisonKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
