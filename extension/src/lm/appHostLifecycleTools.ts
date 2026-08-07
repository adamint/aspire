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
import { type AppHostIdentityRelation } from '../utils/appHostIdentity';
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

/**
 * The only file name the launcher accepts as a single-file C# AppHost. See
 * `IsAppHostFile` in `src/Aspire.Cli/Projects/DotNetAppHostProject.cs`.
 */
const singleFileAppHostFileName = 'apphost.cs';

/**
 * Upper bound on the workspace-relative path a confirmation may show.
 *
 * A path longer than this is refused outright rather than elided, because an elided path
 * no longer identifies one file: two AppHosts sharing a long prefix would produce the same
 * prompt. The bound is far above any realistic repository path (Windows' own MAX_PATH is
 * 260 for a full path), so refusing beyond it costs nothing in practice.
 */
const maxConfirmationPathLength = 512;

/** Reject model-supplied paths large enough to make path normalization itself expensive. */
const maxAppHostPathLength = 4096;

/**
 * Characters that change what a path *is* without changing, or while changing, how it
 * looks: C0/C1 controls and DEL, plus every Unicode format character (`\p{Cf}`).
 *
 * Bidi controls (U+202A-U+202E, U+2066-U+2069) reorder the run that follows them, so a
 * path can render as a completely different one. Zero-width characters (U+200B-U+200D)
 * are invisible, so two distinct files can produce identical-looking prompts. Deleting
 * them would break the one-to-one relationship between the confirmed identity and the
 * executed target, so they are rejected instead.
 * See https://unicode.org/reports/tr9/ and https://unicode.org/reports/tr36/#Bidirectional_Text_Spoofing
 */
const identityChangingCharacters = /[\u0000-\u001F\u007F-\u009F]|\p{Cf}/u;

export type AppHostLifecycleMode = 'run' | 'debug';

/**
 * Who owns the AppHost process the tool acted on. `editor` means an Aspire debug
 * session created by this extension, `external` means a process the extension can
 * observe but did not start (a terminal, another window, or the CLI directly), and
 * `unknown` means the ownership probe itself failed, which is deliberately not
 * collapsed into `none`.
 */
export type AppHostLifecycleOwnership = 'editor' | 'external' | 'none' | 'unknown';

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
    getEditorOwnedRunSessions(appHostPath: string): AppHostLifecycleOwnedSessions;
    getRunningAppHosts(token: vscode.CancellationToken): Promise<readonly AppHostLifecycleRunningAppHost[]>;
    compareAppHostIdentity(left: string | undefined, right: string | undefined): AppHostIdentityRelation;
    runWithAppHostLifecycleLock<T>(appHostPath: string, token: vscode.CancellationToken, action: () => Promise<T>): Promise<T>;
    launchFromLifecycleOwner(appHostPath: string, command: 'run', noDebug: boolean, token: vscode.CancellationToken): Promise<void>;
}

/**
 * Editor-owned sessions for a requested AppHost, plus whether any session's relationship
 * to it could not be proven. See {@link AppHostIdentityRelation}.
 */
export interface AppHostLifecycleOwnedSessions {
    readonly sessions: readonly AppHostLifecycleEditorSession[];
    readonly ambiguous: boolean;
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
    /**
     * The identity shown in the confirmation dialog. Identical to `relativePath` in a
     * single-root workspace, and prefixed with the workspace folder name otherwise, so a
     * relative path that exists under only one root still names that root in the prompt.
     */
    displayPath: string;
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
 * workspace containment and trust, and refuses anything it cannot prove is an
 * editor-owned Aspire debug session.
 *
 * Lifecycle work is serialized per AppHost through {@link AppHostLifecycleLaunchService},
 * which the editor's own Run/Debug commands share, so a model call and a user action
 * cannot start two processes for the same AppHost. That guarantee covers callers routed
 * through those commands; starting a `launch.json` Aspire configuration with F5 goes
 * straight to the debug adapter and bypasses the lock, which is why every decision here
 * is re-validated against live session state rather than the lock alone.
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
     * Renders the identity the confirmation dialog must show for a requested path.
     *
     * This runs the *same* resolution `invoke` runs and displays its result, so the target
     * the user approves is the target that gets executed. It reads the filesystem to do so,
     * which `prepareInvocation` allows: the API requires it to be free of side effects, not
     * free of I/O. Input that does not resolve is described with a fixed placeholder rather
     * than echoed, because such a call is always rejected anyway and echoing it would hand
     * the model free-form prose inside the trusted prompt that gates "Always allow".
     */
    describeTarget(rawAppHostPath: unknown): string {
        const resolution = this.resolveTarget(rawAppHostPath);
        return resolution.resolved ? resolution.target.displayPath : appHostLifecycleUnresolvedPath;
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
            // Probe for a process this extension does not own *before* taking the
            // lifecycle lock, and return early when the answer is "yes".
            //
            // `aspire ps` spawns the CLI and then queries each AppHost over its
            // backchannel, which can take tens of seconds when an AppHost is paused at a
            // breakpoint - the very situation this tool exists to protect. That slow case
            // is exactly the case this early exit covers, so the expensive probe never
            // runs while the lock is held. When the answer is "no" the probe result is
            // discarded: it is only a fast path, never the authority, because an AppHost
            // started from a terminal while this call waited up to 10s for the lock would
            // leave a stale `false` behind and allow a duplicate launch.
            if (!this.hasEditorOwnership(preflight.target.absolutePath) &&
                await this.isRunningOutsideEditor(preflight.target.absolutePath, token)) {
                // Launching again would start a second AppHost against the same project.
                // Report it instead so the agent can decide, and never adopt or kill a
                // process this extension does not own.
                return createResult(aspireAppHostStartToolName, 'alreadyRunning', preflight.target.relativePath, 'external', requestedMode, undefined);
            }

            return await this._dependencies.launchService.runWithAppHostLifecycleLock(preflight.target.absolutePath, token, async () => {
                // Re-resolve after the confirmation and after waiting on the shared lock:
                // the file can be deleted or replaced, and an editor command may already
                // have launched this AppHost while this call was queued.
                const recheck = this.preflight(aspireAppHostStartToolName, input.appHostPath, token, requestedMode);
                if (recheck.rejected) {
                    return recheck.result;
                }

                const current = recheck.target;
                const owned = this.findEditorOwnedSessions(current.absolutePath);
                // A session that finished startup is checked before the launching flag on
                // purpose. That flag is only cleared once `aspire ps` reconciliation observes
                // the process, which can lag far behind the session itself.
                const runningSession = owned.sessions.find(session => session.startupCompleted);
                if (runningSession) {
                    return createResult(
                        aspireAppHostStartToolName,
                        'alreadyRunning',
                        current.relativePath,
                        'editor',
                        requestedMode,
                        getSessionMode(runningSession));
                }

                if (this._dependencies.launchService.isLaunching(current.absolutePath) || owned.sessions.length > 0) {
                    return createResult(aspireAppHostStartToolName, 'alreadyStarting', current.relativePath, 'editor', requestedMode, undefined);
                }

                if (owned.ambiguous) {
                    // A session exists whose AppHost cannot be told apart from this one -
                    // for example a sibling project file and a `Program.cs` in a directory
                    // holding several projects. Launching would risk a second process for
                    // an AppHost that is already running, so refuse instead of guessing.
                    return createResult(aspireAppHostStartToolName, 'ambiguousSession', current.relativePath, 'editor', requestedMode, undefined);
                }

                // Authoritative ownership check immediately before launching. This is the
                // one that matters: everything before it could be stale by now.
                if (await this.isRunningOutsideEditor(current.absolutePath, token)) {
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
            // Same reasoning as `start`: the `aspire ps` probe stays outside the lock so a
            // slow or wedged AppHost cannot block the user's own Run/Debug. The probe only
            // labels the outcome here, so its result is safe to carry into the lock, and it
            // is skipped entirely when the editor already owns a session for this AppHost.
            const externalOwnershipBeforeLock = this.hasEditorOwnership(preflight.target.absolutePath)
                ? undefined
                : await this.probeExternalOwnershipForStop(preflight.target.absolutePath, token);

            return await this._dependencies.launchService.runWithAppHostLifecycleLock(preflight.target.absolutePath, token, async () => {
                const recheck = this.preflight(aspireAppHostStopToolName, input.appHostPath, token, undefined);
                if (recheck.rejected) {
                    return recheck.result;
                }

                const current = recheck.target;
                const owned = this.findEditorOwnedSessions(current.absolutePath);
                if (owned.sessions.length > 1) {
                    // Two sessions claim the same AppHost. Stopping "one of them" would be an
                    // arbitrary choice, so refuse and let the user disambiguate in the UI.
                    return createResult(aspireAppHostStopToolName, 'ambiguousSession', current.relativePath, 'editor', undefined, undefined);
                }

                if (owned.sessions.length === 0 && owned.ambiguous) {
                    // A session exists that this AppHost cannot be told apart from - a
                    // sibling project file and a `Program.cs` in a directory holding several
                    // projects, for instance. Stopping it would terminate an AppHost the
                    // caller never named, so refuse.
                    return createResult(aspireAppHostStopToolName, 'ambiguousSession', current.relativePath, 'editor', undefined, undefined);
                }

                if (owned.sessions.length === 0) {
                    const externalOwnership = externalOwnershipBeforeLock
                        ?? await this.probeExternalOwnershipForStop(current.absolutePath, token);
                    if (externalOwnership === 'unknown') {
                        // The probe failed, so "nothing is running" would be an assertion the
                        // extension cannot make. Report the failure and let the agent retry
                        // or fall back rather than telling it the AppHost is not running.
                        return createResult(aspireAppHostStopToolName, 'failed', current.relativePath, 'unknown', undefined, undefined);
                    }

                    return createResult(
                        aspireAppHostStopToolName,
                        externalOwnership === 'external' ? 'notEditorOwned' : 'notRunning',
                        current.relativePath,
                        externalOwnership,
                        undefined,
                        undefined);
                }

                const session = owned.sessions[0];
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
     * Resolution never guesses: only workspace-relative input is accepted, a relative
     * path that matches files in several folders is ambiguous, a path that leaves the
     * workspace lexically or through a symlink is rejected, and a file that does not look
     * like a runnable Aspire AppHost is refused.
     */
    resolveTarget(rawAppHostPath: unknown): AppHostTargetResolution {
        if (typeof rawAppHostPath !== 'string') {
            return { resolved: false, outcome: 'invalidInput' };
        }

        const requestedPath = rawAppHostPath.trim();
        // A NUL byte truncates the path inside libuv, so a value such as
        // "AppHost/AppHost.csproj\u0000/../../etc/passwd" could pass string checks and
        // then address a different file on disk. Format characters are rejected for a
        // different reason; see `identityChangingCharacters`.
        if (requestedPath.length === 0 ||
            requestedPath.length > maxAppHostPathLength ||
            identityChangingCharacters.test(requestedPath)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        // The tool contract, the manifest input schema, and the README all require a
        // workspace-relative path. Accepting an absolute path that happens to land inside
        // a workspace folder would widen the surface beyond what the user was told the
        // tool can address, so it is refused before any candidate is built.
        if (path.isAbsolute(requestedPath)) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
            return { resolved: false, outcome: 'pathOutsideWorkspace' };
        }

        const lexicallyContained = workspaceFolders
            .map(folder => ({ candidate: path.resolve(folder.uri.fsPath, requestedPath), folder }))
            .filter(({ candidate, folder }) => isContainedIn(folder.uri.fsPath, candidate));
        if (lexicallyContained.length === 0) {
            return { resolved: false, outcome: 'pathOutsideWorkspace' };
        }

        const realPathCandidates = lexicallyContained.map(({ candidate, folder }) => ({
            candidate,
            folder,
            realCandidate: realPathOrUndefined(candidate),
            realFolder: realPathOrUndefined(folder.uri.fsPath),
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

        const { candidate: absolutePath, folder } = existing[0];

        if (!isAppHostFile(absolutePath)) {
            return { resolved: false, outcome: 'notAnAppHost' };
        }

        // Workspace folders can nest. The deepest folder that contains the file wins so
        // the reported path matches the folder the user would recognize in the explorer.
        const containingFolder = findContainingWorkspaceFolder(workspaceFolders, absolutePath) ?? folder;
        const relativePath = toPosixRelativePath(containingFolder.uri.fsPath, absolutePath);
        // In a multi-root workspace the relative path alone does not say which root was
        // selected, and resolution *did* select one. Qualify it so the confirmed identity
        // is the identity that gets launched.
        const displayPath = workspaceFolders.length > 1
            ? `${containingFolder.name}/${relativePath}`
            : relativePath;
        // The display string is derived from real entries on disk, but a file or folder
        // name can itself carry invisible characters. Refuse anything that cannot be shown
        // exactly as it is rather than showing an identity the tool would not execute.
        if (identityChangingCharacters.test(displayPath) || displayPath.length > maxConfirmationPathLength) {
            return { resolved: false, outcome: 'invalidInput' };
        }

        return {
            resolved: true,
            target: {
                absolutePath,
                relativePath,
                displayPath: escapeMarkdown(displayPath),
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

    private findEditorOwnedSessions(appHostPath: string): AppHostLifecycleOwnedSessions {
        return this._dependencies.launchService.getEditorOwnedRunSessions(appHostPath);
    }

    private hasEditorOwnership(appHostPath: string): boolean {
        const owned = this._dependencies.launchService.getEditorOwnedRunSessions(appHostPath);
        return this._dependencies.launchService.isLaunching(appHostPath) ||
            owned.sessions.length > 0 ||
            owned.ambiguous;
    }

    private async isRunningOutsideEditor(appHostPath: string, token: vscode.CancellationToken): Promise<boolean> {
        const runningAppHosts = await this._dependencies.launchService.getRunningAppHosts(token);
        // An identity that cannot be proven distinct counts as running. Treating it as a
        // different AppHost would let `start` put a second process on the ports of the one
        // the CLI already reported.
        return runningAppHosts.some(runningAppHost =>
            this._dependencies.launchService.compareAppHostIdentity(runningAppHost.appHostPath, appHostPath) !== 'different');
    }

    /**
     * Ownership probe for `stop`, which distinguishes "not running" from "could not tell".
     *
     * Collapsing a probe failure into `none` would make the tool report `notRunning` for an
     * AppHost that is running outside the editor, contradicting the ownership contract the
     * agent relies on. The caller turns `unknown` into a `failed` outcome instead.
     */
    private async probeExternalOwnershipForStop(appHostPath: string, token: vscode.CancellationToken): Promise<AppHostLifecycleOwnership> {
        try {
            return await this.isRunningOutsideEditor(appHostPath, token) ? 'external' : 'none';
        }
        catch (error) {
            if (isCommandCancellation(error)) {
                throw error;
            }

            extensionLogOutputChannel.warn(`Aspire language model tool ${aspireAppHostStopToolName} could not determine external AppHost ownership: ${String(error)}`);
            return 'unknown';
        }
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

    // Preparation resolves the requested path so the confirmation shows the exact target
    // `invoke` will act on. It reads the filesystem but performs no lifecycle work, which
    // is what the API requires of a preparation step.
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
 * Escapes the Markdown constructs that change how a path renders inline.
 *
 * The confirmation body renders as Markdown, so an unescaped `*`, `_`, `` ` ``, `[`, or
 * `<` in a real file name would show the user something other than the file the tool is
 * about to launch. Escaping keeps the rendered text one-to-one with the path instead of
 * deleting characters, which would break that relationship in the other direction.
 * Characters that are only meaningful at the start of a line (`.`, `-`, `{`, `}`) are
 * left alone: the path is always interpolated mid-sentence and they are extremely common
 * in real project paths.
 * See https://spec.commonmark.org/0.31.2/#backslash-escapes
 */
function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_[\]()<>#+~|!]/g, character => `\\${character}`);
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

    if (!satisfiesSingleFileAppHostInvariant(candidate)) {
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

/**
 * Mirrors the launcher's rule for what counts as a single-file C# AppHost: the file must
 * be named `apphost.cs` and must have no sibling `.csproj`.
 *
 * See `IsAppHostFile` and `IsValidSingleFileAppHost` in
 * `src/Aspire.Cli/Projects/DotNetAppHostProject.cs`. Content alone cannot decide this.
 * A `.cs` file carrying the SDK directive next to a project file is not a single-file
 * AppHost: the launcher rejects it and falls back to searching for a project, so
 * confirming the source path would name a target that is not the one about to run. The
 * caller must name the project file in that shape.
 */
function satisfiesSingleFileAppHostInvariant(candidate: string): boolean {
    if (path.extname(candidate).toLowerCase() !== '.cs') {
        return true;
    }

    if (path.basename(candidate).toLowerCase() !== singleFileAppHostFileName) {
        return false;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(path.dirname(candidate), { withFileTypes: true });
    }
    catch {
        // The directory holding the file cannot be read, so the invariant cannot be
        // proven. Refuse rather than launch a shape the launcher may resolve elsewhere.
        return false;
    }

    return !entries.some(entry =>
        (entry.isFile() || entry.isSymbolicLink()) && path.extname(entry.name).toLowerCase() === '.csproj');
}

function findContainingWorkspaceFolder(folders: readonly vscode.WorkspaceFolder[], candidate: string): vscode.WorkspaceFolder | undefined {
    // Workspace folders can nest. The deepest match wins so the reported relative path
    // matches the folder the user would recognize in the explorer.
    let bestMatch: vscode.WorkspaceFolder | undefined;
    for (const folder of folders) {
        const folderPath = folder.uri.fsPath;
        if (isContainedIn(folderPath, candidate) && (!bestMatch || folderPath.length > bestMatch.uri.fsPath.length)) {
            bestMatch = folder;
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
