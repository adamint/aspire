import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    aspireOpenDashboardToolName,
    type EditorAssistanceToolName,
    type EditorAssistanceToolResult,
} from './editorAssistanceToolContracts';
import {
    sendTelemetryEvent,
    type EventMeasurements,
    type EventProperties,
} from '../utils/telemetry';

const editorAssistanceResultEventName = 'aspire/vscode/editorAssistance/result' as const;

type ResultEventProperties = EventProperties<typeof editorAssistanceResultEventName>;
type ResultEventMeasurements = EventMeasurements<typeof editorAssistanceResultEventName>;

export interface EditorAssistanceTelemetryClock {
    now(): number;
}

export interface EditorAssistanceTelemetryEvent {
    readonly eventName: typeof editorAssistanceResultEventName;
    readonly properties: ResultEventProperties;
    readonly measurements: ResultEventMeasurements;
}

export interface EditorAssistanceTelemetryOptions {
    readonly clock?: EditorAssistanceTelemetryClock;
    readonly sendEvent?: (
        eventName: typeof editorAssistanceResultEventName,
        properties: ResultEventProperties,
        measurements: ResultEventMeasurements) => void;
}

const outcomesByTool: Readonly<Record<EditorAssistanceToolName, ReadonlySet<string>>> = {
    aspire_debug_session_status: new Set([
        'running',
        'starting',
        'stopping',
        'notDebugging',
        'multipleSessions',
        'appHostNotFound',
        'ambiguousAppHost',
        'resourceNotFound',
        'resourceAmbiguous',
        'workspaceNotTrusted',
        'invalidInput',
        'canceled',
        'error',
    ]),
    aspire_explain_launch_failure: new Set([
        'failureFound',
        'noRecordedFailure',
        'appHostNotFound',
        'ambiguousAppHost',
        'workspaceNotTrusted',
        'invalidInput',
        'canceled',
        'error',
    ]),
    aspire_open_dashboard: new Set([
        'opened',
        'dashboardUnavailable',
        'appHostNotRunning',
        'appHostNotFound',
        'ambiguousAppHost',
        'workspaceNotTrusted',
        'invalidInput',
        'canceled',
        'error',
    ]),
    aspire_open_output: new Set([
        'opened',
        'workspaceNotTrusted',
        'invalidInput',
        'canceled',
        'error',
    ]),
    aspire_list_debug_sessions: new Set([
        'sessionsFound',
        'noSessions',
        'workspaceNotTrusted',
        'invalidInput',
        'canceled',
        'error',
    ]),
};

const statusStateBuckets = new Set([
    'running',
    'starting',
    'stopping',
    'notDebugging',
    'multipleSessions',
]);
const scopes = new Set(['appHost', 'resource']);
const controllers = new Set(['editor', 'cli']);
const modes = new Set(['run', 'debug', 'deploy', 'publish', 'other']);
const launchFailureStages = new Set([
    'discovery',
    'validation',
    'cliLaunch',
    'build',
    'dcpStartup',
    'debugSession',
    'dashboard',
]);
const launchFailureCategories = new Set([
    'invalidConfiguration',
    'missingDependency',
    'cliUnavailable',
    'buildFailed',
    'processExited',
    'timeout',
    'portConflict',
    'permissionDenied',
    'unsupported',
    'canceled',
    'unknown',
]);
const providerKinds = new Set([
    'dotnet',
    'node',
    'python',
    'java',
    'go',
    'rust',
    'maui',
    'azureFunctions',
    'browser',
    'bun',
    'other',
]);
const exitCodeBuckets = new Set(['none', 'zero', 'one', 'signal', 'other']);
const dashboardPresentations = new Set([
    'integratedBrowser',
    'externalBrowser',
    'debugBrowser',
    'notification',
]);

/**
 * Records one finite telemetry event around each language model tool invocation.
 *
 * Tool results can contain safe user-facing display values, such as a workspace-relative
 * AppHost path or resource name. The telemetry projection deliberately rebuilds its payload
 * from bounded enums and never copies those result objects or caller input.
 */
export class EditorAssistanceTelemetry {
    private readonly _clock: EditorAssistanceTelemetryClock;
    private readonly _sendEvent: NonNullable<EditorAssistanceTelemetryOptions['sendEvent']>;

    constructor(options: EditorAssistanceTelemetryOptions = {}) {
        this._clock = options.clock ?? { now: Date.now };
        this._sendEvent = options.sendEvent ?? sendTelemetryEvent;
    }

    async capture<T extends EditorAssistanceToolResult>(
        tool: EditorAssistanceToolName,
        invoke: () => Promise<T>): Promise<T> {
        const startedAt = this._clock.now();
        try {
            const result = await invoke();
            this.record(tool, result, this.getDuration(startedAt));
            return result;
        }
        catch (error) {
            this.record(tool, undefined, this.getDuration(startedAt));
            throw error;
        }
    }

    private record(
        tool: EditorAssistanceToolName,
        result: EditorAssistanceToolResult | undefined,
        durationMs: number): void {
        const outcome = getBoundedOutcome(tool, result?.outcome);
        const properties: ResultEventProperties = {
            tool,
            outcome,
            source: 'languageModelTool',
        };

        if (tool === aspireDebugSessionStatusToolName && result) {
            copyIfBounded(properties, 'scope', result, 'scope', scopes);
            copyIfBounded(properties, 'controller', result, 'controller', controllers);
            copyIfBounded(properties, 'mode', result, 'mode', modes);
            if (statusStateBuckets.has(outcome)) {
                properties.state_bucket = outcome;
            }
        }
        else if (tool === aspireExplainLaunchFailureToolName && result?.outcome === 'failureFound') {
            copyIfBounded(properties, 'controller', result, 'controller', controllers);
            copyIfBounded(properties, 'mode', result, 'mode', modes);
            copyIfBounded(properties, 'stage', result, 'stage', launchFailureStages);
            copyIfBounded(properties, 'category', result, 'category', launchFailureCategories);
            copyIfBounded(properties, 'provider_kind', result, 'providerKind', providerKinds);
            copyIfBounded(properties, 'exit_code_bucket', result, 'exitCodeBucket', exitCodeBuckets);
        }
        else if (tool === aspireOpenDashboardToolName && result?.outcome === 'opened') {
            copyIfBounded(properties, 'presentation', result, 'presentation', dashboardPresentations);
        }

        this._sendEvent(
            editorAssistanceResultEventName,
            properties,
            { duration_ms: durationMs });
    }

    private getDuration(startedAt: number): number {
        const duration = this._clock.now() - startedAt;
        return Number.isFinite(duration) ? Math.max(0, duration) : 0;
    }
}

function getBoundedOutcome(tool: EditorAssistanceToolName, outcome: unknown): string {
    return typeof outcome === 'string' && outcomesByTool[tool].has(outcome)
        ? outcome
        : 'error';
}

function copyIfBounded(
    target: ResultEventProperties,
    targetProperty: keyof ResultEventProperties,
    source: object,
    sourceProperty: string,
    allowedValues: ReadonlySet<string>): void {
    const value = (source as Record<string, unknown>)[sourceProperty];
    if (typeof value === 'string' && allowedValues.has(value)) {
        target[targetProperty] = value;
    }
}
