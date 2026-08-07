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
    appHostLifecycleUnresolvedPath,
    appHostLifecycleUnspecifiedMode,
} from '../loc/strings';
import { isRunnableAppHostFileContents, isSupportedAppHostFileExtension } from '../utils/appHostLanguage';
import { extensionLogOutputChannel } from '../utils/logging';
import { isCommandCancellation } from '../utils/telemetry';
import { AppHostLifecycleLockTimeoutError } from '../services/AppHostLaunchService';

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

/** Reject model-supplied paths large enough to make path normalization itself expensive. */
const maxAppHostPathLength = 4096;

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
    | 'busy'
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
    getEditorOwnedRunSessions(appHostPath: string): readonly AppHostLifecycleEditorSession[];
    getRunningAppHosts(token: vscode.CancellationToken): Promise<readonly AppHostLifecycleRunningAppHost[]>;
    isSameAppHostIdentity(left: string | undefined, right: string | undefined): boolean;
    runWithAppHostLifecycleLock<T>(appHostPath: string, token: vscode.CancellationToken, action: () => Promise<T>): Promise<T>;
    launchFromLifecycleOwner(appHostPath: string, command: 'run', noDebug: boolean, token: vscode.CancellationToken): Promise<void>;
}

export interface AppHostLifecycleRunningAppHost {
    readonly appHostPath: string;
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
    readonly configuration: { readonly noDebug?: boolean; readonly command?: string;[key: string]: unknown };
    stopDebugging(): Promise<void>;
}

export interface AppHostLifecycleToolDependencies {
    readonly launchService: AppHostLifecycleLaunchService;
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
    private _disposed = false;

    constructor(dependencies: AppHostLifecycleToolDependencies) {
        this._dependencies = dependencies;
    }

    dispose(): void {
        this._disposed = true;
    }

    /**
     * Resolves the requested path for display purposes only. Used by
     * `prepareInvocation`, which the VS Code API requires to be side-effect free.
     */
    describeTarget(rawAppHostPath: unknown): string {
        return describeModelSuppliedPath(rawAppHostPath);
    }

    async start(input: AppHostStartToolInput, token: vscode.CancellationToken): Promise<AppHostLifecycleToolResult> {
        if (!isValidStartInput(input)) {
            return createResult(aspireAppHostStartToolName, 'invalidInput', '', 'none', undefined, undefined);
        }

        const requestedMode = input.mode;
        const preflight = this.preflight(aspireAppHostStartToolName, input?.appHostPath, token, requestedMode);
        if (preflight.rejected) {
            return preflight.result;
        }

        try {
            return await this._dependencies.launchService.runWithAppHostLifecycleLock(preflight.target.absolutePath, token, async () => {
                // Re-resolve after the confirmation and after waiting on the shared lock:
                // the file can be deleted or replaced, and an editor command may already
                // have launched this AppHost while this call was queued.
                const recheck = this.preflight(aspireAppHostStartToolName, input.appHostPath, token, requestedMode);
                if (recheck.rejected) {
                    return recheck.result;
                }

                const current = recheck.target;
                const editorSessions = this.findEditorOwnedSessions(current.absolutePath);
                // A session that finished startup is checked before the launching flag on
                // purpose. That flag is only cleared once `aspire ps` reconciliation observes
                // the process, which can lag far behind the session itself.
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

                if (await this.isRunningOutsideEditor(current.absolutePath, token)) {
                    // Launching again would start a second AppHost against the same project.
                    // Report it instead so the agent can decide, and never adopt or kill a
                    // process this extension does not own.
                    return createResult(aspireAppHostStartToolName, 'alreadyRunning', current.relativePath, 'external', requestedMode, undefined);
                }

                try {
                    // `noDebug` is the only lever the tool exposes; the Aspire command is pinned
                    // to `run` so an agent can never reach deploy/publish/do through this surface.
                    await this._dependencies.launchService.launchFromLifecycleOwner(
                        current.absolutePath,
                        'run',
                        requestedMode === 'run',
                        token);
                }
                catch (error) {
                    return this.createErrorResult(aspireAppHostStartToolName, error, current.relativePath, 'editor', requestedMode, undefined);
                }

                return createResult(aspireAppHostStartToolName, 'started', current.relativePath, 'editor', requestedMode, requestedMode);
            });
        }
        catch (error) {
            return this.createErrorResult(aspireAppHostStartToolName, error, preflight.target.relativePath, 'editor', requestedMode, undefined);
        }
    }

    async stop(input: AppHostStopToolInput, token: vscode.CancellationToken): Promise<AppHostLifecycleToolResult> {
        if (!isValidStopInput(input)) {
            return createResult(aspireAppHostStopToolName, 'invalidInput', '', 'none', undefined, undefined);
        }

        const preflight = this.preflight(aspireAppHostStopToolName, input?.appHostPath, token, undefined);
        if (preflight.rejected) {
            return preflight.result;
        }

        try {
            return await this._dependencies.launchService.runWithAppHostLifecycleLock(preflight.target.absolutePath, token, async () => {
                const recheck = this.preflight(aspireAppHostStopToolName, input.appHostPath, token, undefined);
                if (recheck.rejected) {
                    return recheck.result;
                }

                const current = recheck.target;
                const editorSessions = this.findEditorOwnedSessions(current.absolutePath);
                if (editorSessions.length > 1) {
                    // Two sessions claim the same AppHost. Stopping "one of them" would be an
                    // arbitrary choice, so refuse and let the user disambiguate in the UI.
                    return createResult(aspireAppHostStopToolName, 'ambiguousSession', current.relativePath, 'editor', undefined, undefined);
                }

                if (editorSessions.length === 0) {
                    const runningExternally = await this.isRunningOutsideEditor(current.absolutePath, token);
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
                if (token.isCancellationRequested) {
                    return createResult(aspireAppHostStopToolName, 'cancelled', current.relativePath, 'editor', undefined, effectiveMode);
                }
                try {
                    await session.stopDebugging();
                }
                catch (error) {
                    return this.createErrorResult(aspireAppHostStopToolName, error, current.relativePath, 'editor', undefined, effectiveMode);
                }

                return createResult(aspireAppHostStopToolName, 'stopped', current.relativePath, 'editor', undefined, effectiveMode);
            });
        }
        catch (error) {
            return this.createErrorResult(aspireAppHostStopToolName, error, preflight.target.relativePath, 'editor', undefined, undefined);
        }
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
        if (requestedPath.length === 0 ||
            requestedPath.length > maxAppHostPathLength ||
            /[\u0000-\u001F\u007F]/.test(requestedPath)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
            return { resolved: false, outcome: 'pathOutsideWorkspace' };
        }

        const candidates = path.isAbsolute(requestedPath)
            ? [path.resolve(requestedPath)]
            : workspaceFolders.map(folder => path.resolve(folder.uri.fsPath, requestedPath));
        const lexicallyContained = candidates
            .map(candidate => ({ candidate, folder: findContainingWorkspaceFolder(workspaceFolders, candidate) }))
            .filter((value): value is { candidate: string; folder: string } => value.folder !== undefined);
        if (lexicallyContained.length === 0) {
            return { resolved: false, outcome: 'pathOutsideWorkspace' };
        }

        const realPathCandidates = lexicallyContained.map(({ candidate, folder }) => ({
            candidate,
            folder,
            realCandidate: realPathOrUndefined(candidate),
            realFolder: realPathOrUndefined(folder),
        }));
        if (realPathCandidates.some(({ realCandidate, realFolder }) =>
            realCandidate && realFolder && !isContainedIn(realFolder, realCandidate))) {
            return { resolved: false, outcome: 'pathEscapesWorkspace' };
        }

        const existing = realPathCandidates.filter(value =>
            value.realCandidate !== undefined &&
            value.realFolder !== undefined &&
            isContainedIn(value.realFolder, value.realCandidate));
        if (existing.length === 0) {
            return { resolved: false, outcome: 'pathNotFound' };
        }

        // Existence is what disambiguates a relative path in a multi-root workspace. When
        // the same relative path exists under more than one folder there is no defensible
        // way to pick one, so the request is refused rather than guessed.
        if (new Set(existing.map(({ candidate }) => getComparisonKey(candidate))).size > 1) {
            return { resolved: false, outcome: 'pathAmbiguous' };
        }

        const { candidate: absolutePath, folder: containingFolder } = existing[0];

        if (!isAppHostFile(absolutePath)) {
            return { resolved: false, outcome: 'notAnAppHost' };
        }

        return {
            resolved: true,
            target: {
                absolutePath,
                relativePath: toPosixRelativePath(containingFolder, absolutePath),
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

    private findEditorOwnedSessions(appHostPath: string): AppHostLifecycleEditorSession[] {
        return [...this._dependencies.launchService.getEditorOwnedRunSessions(appHostPath)];
    }

    private async isRunningOutsideEditor(appHostPath: string, token: vscode.CancellationToken): Promise<boolean> {
        const runningAppHosts = await this._dependencies.launchService.getRunningAppHosts(token);
        return runningAppHosts.some(runningAppHost =>
            this._dependencies.launchService.isSameAppHostIdentity(runningAppHost.appHostPath, appHostPath));
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

        if (error instanceof AppHostLifecycleLockTimeoutError) {
            return createResult(tool, 'busy', relativePath, ownership, requestedMode, effectiveMode);
        }

        // Failure details stay in the extension log. They routinely contain absolute
        // paths, CLI stderr, and DCP/RPC connection details, none of which may cross
        // back into the model transcript.
        extensionLogOutputChannel.error(`Aspire language model tool ${tool} failed: ${String(error)}`);
        return createResult(tool, 'failed', relativePath, ownership, requestedMode, effectiveMode);
    }

}

export class AppHostStartLanguageModelTool implements vscode.LanguageModelTool<AppHostStartToolInput> {
    constructor(private readonly _service: AppHostLifecycleToolService) {
    }

    // Preparation performs lexical path formatting only. Filesystem validation is
    // deferred to invoke(), after trust and cancellation checks.
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
 * {@link vscode.lm.registerTool} API exists.
 *
 * The API check keeps the extension loadable on VS Code builds that predate the
 * finalized language model tool API (`engines.vscode` allows older hosts). The
 * implementation is registered in Restricted Mode too because VS Code can retain the
 * contributed tool metadata there; invocation then returns `workspaceNotTrusted`
 * instead of failing with a missing implementation.
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
    else {
        registerTools();
    }

    return {
        get registered() {
            return registrations.length > 0;
        },
        tools,
        dispose() {
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

function isValidStartInput(value: unknown): value is AppHostStartToolInput {
    return hasOnlyProperties(value, ['appHostPath', 'mode']) &&
        typeof value.appHostPath === 'string' &&
        parseMode(value.mode) !== undefined;
}

function isValidStopInput(value: unknown): value is AppHostStopToolInput {
    return hasOnlyProperties(value, ['appHostPath']) &&
        typeof value.appHostPath === 'string';
}

function hasOnlyProperties<T extends string>(value: unknown, properties: readonly T[]): value is Record<T, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const actualProperties = Object.keys(value);
    return actualProperties.length === properties.length &&
        properties.every(property => Object.prototype.hasOwnProperty.call(value, property));
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
        // Unicode format characters are invisible but reorder or hide what follows them:
        // a bidi isolate/override run (U+2066-U+2069, U+202A-U+202E) can make a path render
        // as a completely different one while the surrounding prompt text stays intact, and
        // zero-width characters (U+200B-U+200D) can split a name the user would recognize.
        // They are neither `\s` nor C0 controls, so they need their own pass.
        // See https://unicode.org/reports/tr9/ and https://unicode.org/reports/tr36/#Bidirectional_Text_Spoofing
        .replace(/\p{Cf}/gu, '')
        .replace(/[`*_[\]<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}

/**
 * Renders the requested AppHost for the confirmation dialog as a workspace-relative path.
 *
 * Input that cannot be mapped into an open workspace folder is described with a fixed
 * placeholder rather than echoed. Such a call is always rejected by {@link
 * AppHostLifecycleToolService.resolveTarget} anyway, so echoing it would only hand the
 * model free-form prose inside the trusted prompt that gates "Always allow".
 */
function describeModelSuppliedPath(value: unknown): string {
    if (typeof value !== 'string') {
        return appHostLifecycleUnresolvedPath;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const requestedPath = value.trim();
    const candidate = requestedPath.length > 0 &&
        requestedPath.length <= maxAppHostPathLength &&
        !/[\u0000-\u001F\u007F]/.test(requestedPath)
        ? path.isAbsolute(requestedPath)
            ? path.resolve(requestedPath)
            : workspaceFolders.length === 1
                ? path.resolve(workspaceFolders[0].uri.fsPath, requestedPath)
                : undefined
        : undefined;
    const containingFolder = candidate ? findContainingWorkspaceFolder(workspaceFolders, candidate) : undefined;
    if (!containingFolder || !candidate) {
        return appHostLifecycleUnresolvedPath;
    }

    const sanitized = sanitizeModelSuppliedText(toPosixRelativePath(containingFolder, candidate), maxConfirmationPathLength);
    return sanitized.length > 0 ? sanitized : appHostLifecycleUnresolvedPath;
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

function realPathOrUndefined(candidate: string): string | undefined {
    try {
        return fs.realpathSync.native(candidate);
    }
    catch {
        return undefined;
    }
}

function getComparisonKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
