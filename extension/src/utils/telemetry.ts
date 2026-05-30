import { TelemetryReporter } from '@vscode/extension-telemetry';
import * as vscode from 'vscode';

// Module-private state.
// Aspire emits all telemetry through a single TelemetryReporter (which itself
// honors `vscode.env.isTelemetryEnabled`, including transitions between
// "on" / "errorsOnly" / "off"). We keep it as a module singleton because the
// reporter is created at activation time and consumed from multiple places —
// the command wrapper, the engagement reporter, the tree view, the debug
// session, and the dashboard telemetry passthrough server.
let reporter: TelemetryReporter | undefined;

// Common properties merged into every event we emit. The TelemetryReporter
// already injects extension version, OS, machine id, etc., so this map is
// reserved for Aspire-specific cross-event signals (e.g. detected AppHost
// language, run mode). Values are kept as strings because @vscode/extension-telemetry
// only supports string-valued properties; numeric data must go through `measurements`.
const commonProperties: { [key: string]: string } = {};

// Optional listener invoked from {@link withCommandTelemetry} on every
// successful or attempted command invocation. The engagement reporter sets
// this from `meaningfulEngagement.ts` so it can fire its activation event on
// the first command without needing to be plumbed through every callsite.
// Kept as a single optional callback to avoid circular module dependencies
// (telemetry.ts must not import meaningfulEngagement.ts).
let commandInvocationListener: (() => void) | undefined;

export function initializeTelemetry(context: vscode.ExtensionContext): void {
    if (reporter) {
        return;
    }
    // Get the AI key from package.json.
    const extension = vscode.extensions.getExtension(context.extension.id);
    const aiKey = extension?.packageJSON.aiKey;
    if (aiKey) {
        reporter = new TelemetryReporter(aiKey);
        context.subscriptions.push({ dispose: () => reporter?.dispose() });
    }
}

/**
 * Returns the shared TelemetryReporter, or undefined if telemetry has not been
 * initialized (e.g. tests that skip activation, or builds without an AI key).
 * Callers that need to bypass the helper functions (notably the dashboard
 * telemetry passthrough) use this to call sendTelemetryEvent directly.
 */
export function getTelemetryReporter(): TelemetryReporter | undefined {
    return reporter;
}

/**
 * Whether telemetry is allowed to leave the machine right now. Combines our
 * reporter availability with VS Code's global telemetry user setting so that
 * the dashboard passthrough endpoint advertises "enabled" only when both are
 * true. The reporter itself enforces the user setting on send, but we also
 * gate the dashboard's session-start handshake to avoid pointless traffic.
 */
export function isExtensionTelemetryEnabled(): boolean {
    return reporter !== undefined && vscode.env.isTelemetryEnabled;
}

/**
 * Sets one or more common properties that will be merged into every event
 * emitted via {@link sendTelemetryEvent}, {@link sendTelemetryErrorEvent}, and
 * {@link withCommandTelemetry}. Existing values for the same keys are replaced.
 * `undefined` values clear a key.
 */
export function setCommonTelemetryProperties(properties: { [key: string]: string | undefined }): void {
    for (const [key, value] of Object.entries(properties)) {
        if (value === undefined) {
            delete commonProperties[key];
        }
        else {
            commonProperties[key] = value;
        }
    }
}

export function getCommonTelemetryProperties(): Readonly<{ [key: string]: string }> {
    return commonProperties;
}

function mergeProperties(properties?: { [key: string]: string }): { [key: string]: string } {
    return { ...commonProperties, ...(properties ?? {}) };
}

export function sendTelemetryEvent(eventName: string, properties?: { [key: string]: string }, measurements?: { [key: string]: number }): void {
    reporter?.sendTelemetryEvent(eventName, mergeProperties(properties), measurements);
}

/**
 * Emits an error telemetry event. Use for faults (unexpected exceptions,
 * dashboard fault posts, etc.) — the underlying reporter applies stricter
 * PII scrubbing on error events than on regular events.
 */
export function sendTelemetryErrorEvent(eventName: string, properties?: { [key: string]: string }, measurements?: { [key: string]: number }): void {
    reporter?.sendTelemetryErrorEvent(eventName, mergeProperties(properties), measurements);
}

/**
 * Outcome bucket reported for every command invocation.
 *  - `success`     : the command's promise resolved normally.
 *  - `canceled`    : the user dismissed a quick pick / input box, or the
 *                    command threw `vscode.CancellationError`. We treat this
 *                    distinctly from errors so dashboards aren't polluted by
 *                    routine user "back out" actions.
 *  - `error`       : the command threw or rejected with anything else.
 */
export type CommandOutcome = 'success' | 'canceled' | 'error';

/**
 * Wraps an extension command invocation so we capture invocation, outcome and
 * duration in one place. Every `vscode.commands.registerCommand` callback in
 * the extension should be routed through here so we get consistent telemetry
 * shape across the surface (command palette, tree view context menus, code
 * lens links, walkthroughs, etc.).
 *
 * The wrapper does NOT swallow errors — exceptions propagate to the caller so
 * existing error-handling (e.g. `tryExecuteCommand`'s catch block) keeps
 * working. We just observe.
 *
 * @param commandName Fully-qualified command name (e.g. `aspire-vscode.add`).
 * @param fn The command implementation.
 * @param additionalProperties Properties to merge into the emitted event
 *        (after common properties, before outcome/duration). Useful for
 *        per-call dimensions like `source: 'tree'` on tree-view commands.
 */
export async function withCommandTelemetry<T>(
    commandName: string,
    fn: () => Promise<T> | T,
    additionalProperties?: { [key: string]: string }
): Promise<T> {
    commandInvocationListener?.();
    const startTime = Date.now();
    let outcome: CommandOutcome = 'success';
    let errorKind: string | undefined;
    try {
        return await Promise.resolve(fn());
    }
    catch (err) {
        if (isCancellation(err)) {
            outcome = 'canceled';
        }
        else {
            outcome = 'error';
            errorKind = classifyError(err);
        }
        throw err;
    }
    finally {
        const durationMs = Date.now() - startTime;
        const properties: { [key: string]: string } = {
            command: commandName,
            outcome,
            ...(additionalProperties ?? {}),
        };
        if (errorKind) {
            properties.error_kind = errorKind;
        }
        sendTelemetryEvent('command/invoked', properties, { duration_ms: durationMs });
    }
}

function isCancellation(err: unknown): boolean {
    // VS Code's CancellationError doesn't always reach us by reference (the
    // value can be re-thrown across module boundaries or originate from a
    // QuickPick that the user dismissed silently). Match on the well-known
    // shape used across the extension API instead.
    if (err instanceof Error) {
        if (err.name === 'Canceled' || err.name === 'CancellationError') {
            return true;
        }
        if (typeof err.message === 'string' && err.message.toLowerCase() === 'canceled') {
            return true;
        }
    }
    // QuickPick dismissals occasionally surface as the literal string 'Canceled'.
    return typeof err === 'string' && err.toLowerCase() === 'canceled';
}

function classifyError(err: unknown): string {
    if (err instanceof Error) {
        return err.name || 'Error';
    }
    if (typeof err === 'string') {
        return 'String';
    }
    return typeof err;
}

/**
 * Returns whether the given value looks like a user-driven cancellation. Used
 * by both {@link withCommandTelemetry} and callers that want to bypass
 * user-visible error reporting on cancellation.
 */
export function isCommandCancellation(err: unknown): boolean {
    return isCancellation(err);
}

/**
 * Registers a callback invoked once per {@link withCommandTelemetry} call,
 * regardless of outcome. Designed for the engagement reporter to observe
 * "user did something with the extension" signals without coupling telemetry.ts
 * to the engagement reporter. Passing `undefined` clears the listener.
 */
export function setCommandInvocationListener(listener: (() => void) | undefined): void {
    commandInvocationListener = listener;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-only helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test seam: swap the singleton reporter with a fake. Returns a disposer that
 * restores the previous reporter. Intentionally not exported from the public
 * surface of the extension; only consumed by the in-process test suite.
 */
export function __setReporterForTests(fake: TelemetryReporter | undefined): () => void {
    const previous = reporter;
    reporter = fake;
    return () => { reporter = previous; };
}

/** Test seam: clear common properties so tests don't bleed into each other. */
export function __resetCommonPropertiesForTests(): void {
    for (const key of Object.keys(commonProperties)) {
        delete commonProperties[key];
    }
}
