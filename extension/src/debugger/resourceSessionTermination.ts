import * as vscode from 'vscode';
import { AspireResourceExtendedDebugConfiguration, ResourceTerminationSignal } from '../dcp/types';
import { extensionLogOutputChannel } from '../utils/logging';
import { cleanupRun } from './runCleanupRegistry';

/**
 * Reads the termination signal off a resource debug configuration.
 *
 * Always go through this instead of reading `configuration.terminationSignal` directly. The
 * configuration round-trips through VS Code as untyped JSON (`vscode.DebugSession.configuration`
 * is a plain object rebuilt by VS Code), so the field is not guaranteed to still match its
 * declared type by the time a consumer sees it. Anything unrecognized falls back to
 * `adapter-exit`, the behavior every process-backed resource type has.
 */
export function getResourceTerminationSignal(configuration: AspireResourceExtendedDebugConfiguration): ResourceTerminationSignal {
    return configuration.terminationSignal === 'debug-session-end' ? 'debug-session-end' : 'adapter-exit';
}

/** Emits the terminal DCP notification for a run. Implemented by `AspireDebugSession`. */
export type SendSessionTerminated = (runId: string, dcpId: string) => void;

/**
 * Owns the stop/finish state machine for one resource debug session.
 *
 * There are exactly two terminal transitions and both have to be idempotent, because a run can
 * be torn down concurrently by a DCP `DELETE /run_session`, by VS Code terminating the session,
 * and by Aspire session disposal:
 *
 * - `finish()` performs the terminal bookkeeping exactly once: it stops listening for the VS Code
 *   termination event, emits `sessionTerminated` when this run owns that notification, and runs
 *   the per-run cleanup handlers (browser profile directory, Azure Functions host, ...).
 * - `stop()` requests a VS Code stop and then finishes. It is memoized so concurrent stops issue a
 *   single `vscode.debug.stopDebugging`, and it resolves only after VS Code has finished stopping
 *   so callers can sequence teardown. `AspireDebugSession.stopDebugging()` depends on that:
 *   it stops the AppHost first and only then the Aspire parent, which keeps VS Code's parent
 *   session cascade from racing the AppHost registry refresh.
 *
 * Collecting both transitions here is the point: the signal is read once, in the constructor, so
 * no caller can partially reconstruct termination ownership.
 */
export class ResourceSessionTermination {
    private readonly _session: vscode.DebugSession;
    private readonly _runId: string;
    private readonly _dcpId: string | null;
    private readonly _signal: ResourceTerminationSignal;
    private readonly _sendSessionTerminated: SendSessionTerminated;

    private _terminationListener: vscode.Disposable | undefined;
    private _finished = false;
    private _stopPromise: Promise<void> | undefined;

    constructor(session: vscode.DebugSession, configuration: AspireResourceExtendedDebugConfiguration, sendSessionTerminated: SendSessionTerminated) {
        this._session = session;
        this._runId = configuration.runId;
        this._dcpId = configuration.debugSessionId;
        this._signal = getResourceTerminationSignal(configuration);
        this._sendSessionTerminated = sendSessionTerminated;
    }

    /**
     * Starts listening for the end of this VS Code debug session, when this run's termination is
     * driven by the session ending rather than by a debug adapter exit. No-op otherwise.
     */
    watchForDebugSessionEnd(): void {
        if (this._signal !== 'debug-session-end') {
            return;
        }

        this._terminationListener = vscode.debug.onDidTerminateDebugSession(terminatedSession => {
            // js-debug terminates target/page child sessions (and sessions belonging to other
            // parents) while this browser session is still alive, so only the root session this
            // instance owns is the DCP lifetime signal.
            if (terminatedSession.id !== this._session.id) {
                return;
            }

            this.finish();
        });
    }

    /**
     * Runs the terminal bookkeeping for the run. Safe to call repeatedly; only the first call
     * has an effect.
     */
    finish(): void {
        if (this._finished) {
            return;
        }

        this._finished = true;
        this._terminationListener?.dispose();
        this._terminationListener = undefined;

        // A run whose lifetime is the debug session reports its own termination. `dcpId` is the
        // same `debugSessionId` the adapter tracker addresses its notifications to; there is no
        // separate id, so there is nothing to keep in sync.
        if (this._signal === 'debug-session-end' && this._dcpId) {
            this._sendSessionTerminated(this._runId, this._dcpId);
        }

        cleanupRun(this._runId);
    }

    /**
     * Stops the VS Code debug session and then finishes the run.
     *
     * The returned promise settles only after VS Code has finished stopping, and rejects if VS Code
     * failed to stop the session. Callers that can act on (or report) the failure should await it;
     * fire-and-forget callers should use {@link stopAndLogFailure} so the rejection is not unhandled.
     */
    stop(): Promise<void> {
        this._stopPromise ??= this.stopCore();

        return this._stopPromise;
    }

    /**
     * Fire-and-forget variant of {@link stop} for disposal paths that have no caller to report a
     * failure to. Shares the memoized stop, so it never issues a second `stopDebugging`.
     */
    stopAndLogFailure(): void {
        // stopCore() already logged the failure; swallow here only to keep the rejection handled.
        void this.stop().catch(() => { });
    }

    private async stopCore(): Promise<void> {
        try {
            await vscode.debug.stopDebugging(this._session);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Failed to stop debug session '${this._session.name}': ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
        finally {
            // Finish even when VS Code reported a failed stop. The run still has to be terminated in
            // DCP and its cleanup handlers still have to run, otherwise the resource stays "running"
            // in the dashboard forever and its scratch state (browser profile directory) leaks.
            this.finish();
        }
    }
}
