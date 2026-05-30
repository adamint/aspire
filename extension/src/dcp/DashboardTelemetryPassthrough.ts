import { Request, Response, Express, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { extensionLogOutputChannel } from '../utils/logging';
import { getTelemetryReporter, isExtensionTelemetryEnabled, sendTelemetryErrorEvent, sendTelemetryEvent } from '../utils/telemetry';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard → extension telemetry contract.
//
// The Aspire dashboard implements its telemetry sender against the endpoints
// defined in `src/Aspire.Dashboard/Telemetry/DashboardTelemetryService.cs`
// (`TelemetryEndpoints` constants). When the dashboard is hosted by Visual
// Studio or the C# Dev Kit extension, those hosts expose this HTTP surface
// and forward each request to their own telemetry pipeline. We do the same
// here for the VS Code Aspire extension by forwarding to
// `@vscode/extension-telemetry`'s TelemetryReporter (which adds VS Code's
// telemetry-level enforcement and standard envelope properties).
//
// Wire shapes mirror the dashboard-side records in `TelemetryRequests.cs` and
// `TelemetryResponses.cs`. Keep these types and the dashboard records in
// lock-step — if the dashboard adds a new field, add it here too. Property
// names use PascalCase to match the dashboard's default System.Text.Json
// serialization.
// ─────────────────────────────────────────────────────────────────────────────

interface AspireTelemetryProperty {
    Value: unknown;
    PropertyType?: AspireTelemetryPropertyType;
}

// Matches `AspireTelemetryPropertyType` enum in TelemetryRequests.cs.
// Sent as the underlying int value because System.Text.Json serializes
// non-string-converted enums as numbers by default.
type AspireTelemetryPropertyType = 0 | 1 | 2 | 3;
const PropertyType = {
    Pii: 0 as const,
    Basic: 1 as const,
    Metric: 2 as const,
    UserSetting: 3 as const,
};

// Matches `TelemetryResult` enum in VisualStudioTelemetryTypes.cs.
type TelemetryResult = 'None' | 'Success' | 'Failure' | 'UserFault' | 'UserCancel';

// Matches `FaultSeverity` enum in VisualStudioTelemetryTypes.cs.
type FaultSeverity = 'Uncategorized' | 'Diagnostic' | 'General' | 'Critical' | 'Crash';

interface TelemetryEventCorrelation {
    id: string;
    eventType: 'UserTask' | 'Trace' | 'Operation' | 'Fault' | 'Asset';
}

interface AspireTelemetryScopeSettings {
    StartEventProperties: { [key: string]: AspireTelemetryProperty };
    Severity?: number;
    IsOptOutFriendly?: boolean;
    Correlations?: TelemetryEventCorrelation[];
    PostStartEvent?: boolean;
}

interface StartOperationRequest {
    EventName: string;
    Settings?: AspireTelemetryScopeSettings;
}

interface EndOperationRequest {
    Id: string;
    Result: TelemetryResult;
    ErrorMessage?: string;
}

interface PostOperationRequest {
    EventName: string;
    Result: TelemetryResult;
    ResultSummary?: string;
    Properties?: { [key: string]: AspireTelemetryProperty };
    CorrelatedWith?: TelemetryEventCorrelation[];
}

interface PostFaultRequest {
    EventName: string;
    Description: string;
    Severity: FaultSeverity;
    Properties?: { [key: string]: AspireTelemetryProperty };
    CorrelatedWith?: TelemetryEventCorrelation[];
}

interface PostAssetRequest {
    EventName: string;
    AssetId: string;
    AssetEventVersion: number;
    AdditionalProperties?: { [key: string]: AspireTelemetryProperty };
    CorrelatedWith?: TelemetryEventCorrelation[];
}

interface PostPropertyRequest {
    PropertyName: string;
    PropertyValue: AspireTelemetryProperty;
}

interface PostCommandLineFlagsRequest {
    FlagPrefixes: string[];
    AdditionalProperties: { [key: string]: AspireTelemetryProperty };
}

// In-flight operation state. We bridge the dashboard's start/end correlation
// model (which expects timing info on `end`) onto the @vscode/extension-telemetry
// model (which only has fire-and-forget event APIs) by tracking start time and
// the event name here, then computing duration when end arrives.
//
// An entry can also be abandoned: if the dashboard never sends an `end`
// (e.g. the dashboard crashes mid-operation) we'd otherwise leak memory.
// Abandoned entries are reaped after `_abandonedOperationTtlMs`.
interface PendingOperation {
    eventName: string;
    kind: 'operation' | 'userTask';
    correlation: TelemetryEventCorrelation;
    startTime: number;
    startProperties: { [key: string]: string };
    startMeasurements: { [key: string]: number };
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Dashboard telemetry passthrough handler. Owns the in-flight start/end
 * correlation map and routes every dashboard telemetry request through the
 * extension's TelemetryReporter.
 */
export class DashboardTelemetryPassthrough {
    // After this long without an `end`, an in-flight operation is treated as
    // abandoned and dropped. The dashboard's send loop processes requests on
    // a single reader so end calls should always come in reasonable order;
    // this is purely a safety net against dashboard crashes / disconnects.
    private static readonly _abandonedOperationTtlMs = 60 * 60 * 1000;

    private readonly _pendingOperations = new Map<string, PendingOperation>();
    private _disposed = false;

    /**
     * Registers the dashboard telemetry passthrough HTTP routes on the given
     * express app. The caller is expected to apply auth middleware *before*
     * these handlers (the routes themselves do not enforce auth — the DCP
     * server's `requireHeaders` middleware does).
     */
    register(app: Express, requireHeaders: (req: Request, res: Response, next: NextFunction) => void): void {
        // GET /telemetry/enabled — declares whether the extension is willing to
        // accept dashboard telemetry. The dashboard only proceeds to /telemetry/start
        // if this returns `is_enabled: true`. We honor both the extension's reporter
        // availability AND the user's VS Code telemetry setting.
        //
        // Note: `is_enabled` is snake_case to match the dashboard-side
        // TelemetryEnabledResponse record's JsonNamingPolicy default
        // (System.Text.Json serializes `IsEnabled` as `isEnabled`, but the
        // dashboard sets JsonNamingPolicy.SnakeCaseLower for this endpoint).
        // Verified against DashboardTelemetrySender.TryStartTelemetrySessionCoreAsync.
        app.get('/telemetry/enabled', (_req, res) => {
            const enabled = isExtensionTelemetryEnabled();
            res.json({ IsEnabled: enabled, isEnabled: enabled, is_enabled: enabled });
        });

        // POST /telemetry/start — session-start handshake. We don't open any
        // dashboard-specific session here; TelemetryReporter is already
        // running. Returning 200 OK tells the dashboard to start sending.
        app.post('/telemetry/start', requireHeaders, (_req, res) => {
            res.status(200).end();
        });

        app.post('/telemetry/startOperation', requireHeaders, (req: Request, res: Response) => {
            this._handleStart(req, res, 'operation', 'Operation');
        });

        app.post('/telemetry/endOperation', requireHeaders, (req: Request, res: Response) => {
            this._handleEnd(req, res);
        });

        app.post('/telemetry/startUserTask', requireHeaders, (req: Request, res: Response) => {
            this._handleStart(req, res, 'userTask', 'UserTask');
        });

        app.post('/telemetry/endUserTask', requireHeaders, (req: Request, res: Response) => {
            this._handleEnd(req, res);
        });

        app.post('/telemetry/operation', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostOperationRequest;
            const { properties, measurements } = flattenProperties(payload.Properties);
            properties.result = payload.Result;
            if (payload.ResultSummary) {
                properties.result_summary = payload.ResultSummary;
            }
            attachCorrelations(properties, payload.CorrelatedWith);
            sendTelemetryEvent(payload.EventName, properties, measurements);
            res.json(this._newCorrelation('Operation'));
        });

        app.post('/telemetry/userTask', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostOperationRequest;
            const { properties, measurements } = flattenProperties(payload.Properties);
            properties.result = payload.Result;
            if (payload.ResultSummary) {
                properties.result_summary = payload.ResultSummary;
            }
            attachCorrelations(properties, payload.CorrelatedWith);
            sendTelemetryEvent(payload.EventName, properties, measurements);
            res.json(this._newCorrelation('UserTask'));
        });

        app.post('/telemetry/fault', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostFaultRequest;
            const { properties, measurements } = flattenProperties(payload.Properties);
            properties.description = payload.Description;
            properties.fault_severity = payload.Severity;
            attachCorrelations(properties, payload.CorrelatedWith);
            sendTelemetryErrorEvent(payload.EventName, properties, measurements);
            res.json(this._newCorrelation('Fault'));
        });

        app.post('/telemetry/asset', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostAssetRequest;
            const { properties, measurements } = flattenProperties(payload.AdditionalProperties);
            properties.asset_id = payload.AssetId;
            properties.asset_event_version = String(payload.AssetEventVersion);
            attachCorrelations(properties, payload.CorrelatedWith);
            sendTelemetryEvent(payload.EventName, properties, measurements);
            res.json(this._newCorrelation('Asset'));
        });

        app.post('/telemetry/property', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostPropertyRequest;
            // The TelemetryReporter API has no "set session property" concept,
            // so we surface the property as a one-off `property/set` event.
            // Receiving teams can pivot on `property_name` to extract the
            // current session value if they need it.
            const { properties, measurements } = flattenProperties({ value: payload.PropertyValue });
            properties.property_name = payload.PropertyName;
            sendTelemetryEvent('dashboard/property/set', properties, measurements);
            res.status(200).end();
        });

        app.post('/telemetry/recurringProperty', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostPropertyRequest;
            const { properties, measurements } = flattenProperties({ value: payload.PropertyValue });
            properties.property_name = payload.PropertyName;
            sendTelemetryEvent('dashboard/property/recurring', properties, measurements);
            res.status(200).end();
        });

        app.post('/telemetry/commandLineFlags', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostCommandLineFlagsRequest;
            const { properties, measurements } = flattenProperties(payload.AdditionalProperties);
            properties.flag_prefixes = payload.FlagPrefixes.join(',');
            sendTelemetryEvent('dashboard/commandLineFlags', properties, measurements);
            res.status(200).end();
        });
    }

    /**
     * Cancels any pending abandonment timers. Safe to call multiple times.
     */
    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        for (const operation of this._pendingOperations.values()) {
            clearTimeout(operation.timer);
        }
        this._pendingOperations.clear();
    }

    private _handleStart(req: Request, res: Response, kind: 'operation' | 'userTask', correlationType: TelemetryEventCorrelation['eventType']): void {
        const payload = req.body as StartOperationRequest;
        const operationId = randomUUID();
        const correlation = this._newCorrelation(correlationType);

        const { properties, measurements } = flattenProperties(payload.Settings?.StartEventProperties);
        const postStartEvent = payload.Settings?.PostStartEvent !== false;

        const pending: PendingOperation = {
            eventName: payload.EventName,
            kind,
            correlation,
            startTime: Date.now(),
            startProperties: properties,
            startMeasurements: measurements,
            timer: setTimeout(() => {
                // Abandoned: drop without emitting an end event. The reporter
                // already received a start event (if requested), so the
                // missing end is the signal that something went wrong.
                this._pendingOperations.delete(operationId);
                extensionLogOutputChannel.warn(`Dashboard telemetry ${kind} '${payload.EventName}' (${operationId}) abandoned after ${DashboardTelemetryPassthrough._abandonedOperationTtlMs}ms with no end`);
            }, DashboardTelemetryPassthrough._abandonedOperationTtlMs),
        };
        this._pendingOperations.set(operationId, pending);

        if (postStartEvent) {
            const startProps = { ...properties, operation_id: operationId, kind: `${kind}.start` };
            attachCorrelations(startProps, payload.Settings?.Correlations);
            sendTelemetryEvent(`${payload.EventName}/start`, startProps, measurements);
        }

        res.json({ OperationId: operationId, Correlation: correlation });
    }

    private _handleEnd(req: Request, res: Response): void {
        const payload = req.body as EndOperationRequest;
        const pending = this._pendingOperations.get(payload.Id);
        if (!pending) {
            // Either the matching start was abandoned, or the dashboard sent
            // an end without a matching start (programmer error on the
            // dashboard side). Either way: drop and respond 200; failing the
            // request would just generate noise.
            res.status(200).end();
            return;
        }

        this._pendingOperations.delete(payload.Id);
        clearTimeout(pending.timer);

        const durationMs = Date.now() - pending.startTime;
        const endProperties: { [key: string]: string } = {
            ...pending.startProperties,
            operation_id: payload.Id,
            result: payload.Result,
            kind: `${pending.kind}.end`,
        };
        if (payload.ErrorMessage) {
            endProperties.error_message = payload.ErrorMessage;
        }
        const endMeasurements: { [key: string]: number } = {
            ...pending.startMeasurements,
            duration_ms: durationMs,
        };
        attachCorrelations(endProperties, [pending.correlation]);

        // Failure results are surfaced as error events so they participate in
        // the more aggressive error-event sanitization pass. UserCancel is
        // routine UX and stays in the standard channel.
        const isFault = payload.Result === 'Failure' || payload.Result === 'UserFault';
        if (isFault) {
            sendTelemetryErrorEvent(`${pending.eventName}/end`, endProperties, endMeasurements);
        }
        else {
            sendTelemetryEvent(`${pending.eventName}/end`, endProperties, endMeasurements);
        }

        res.status(200).end();
    }

    private _newCorrelation(eventType: TelemetryEventCorrelation['eventType']): TelemetryEventCorrelation {
        return { id: randomUUID(), eventType };
    }
}

/**
 * Translates a dashboard property bag into the `{ properties, measurements }`
 * shape expected by `@vscode/extension-telemetry`'s TelemetryReporter.
 *
 * Routing rules:
 *  - Properties tagged `Metric` are routed to `measurements`. The dashboard
 *    serializes metric values as invariant-culture strings (see
 *    `src/Aspire.Dashboard/Components/Pages/Metrics.razor.cs:359` and
 *    `StructuredLogs.razor.cs:622` where `int.ToString(CultureInfo.InvariantCulture)`
 *    is invoked before wrapping in `AspireTelemetryProperty(..., Metric)`), so we
 *    parse strings as well as accept raw numbers. Anything we can't coerce to a
 *    finite number falls through to the string-property path.
 *  - Properties tagged `Pii` are dropped. The dashboard does not actually tag
 *    anything as `Pii` today, but honoring the discriminator keeps the README's
 *    "no resource names or workspace contents are reported" guarantee enforced
 *    end-to-end rather than incidental.
 *  - Everything else is stringified into `properties` (objects are JSON-encoded
 *    so they survive the round trip — TelemetryReporter only supports string
 *    values, but the dashboard occasionally sends complex objects, e.g. enum
 *    descriptors).
 */
function flattenProperties(input: { [key: string]: AspireTelemetryProperty } | undefined): { properties: { [key: string]: string }, measurements: { [key: string]: number } } {
    const properties: { [key: string]: string } = {};
    const measurements: { [key: string]: number } = {};

    if (!input) {
        return { properties, measurements };
    }

    for (const [key, prop] of Object.entries(input)) {
        if (!prop || prop.Value === undefined || prop.Value === null) {
            continue;
        }
        if (prop.PropertyType === PropertyType.Pii) {
            continue;
        }
        const value = prop.Value;
        if (prop.PropertyType === PropertyType.Metric) {
            const numericValue = typeof value === 'number'
                ? value
                : typeof value === 'string'
                    ? Number(value)
                    : Number.NaN;
            if (Number.isFinite(numericValue)) {
                measurements[key] = numericValue;
                continue;
            }
            // Fall through and persist as a string so the dimension still surfaces
            // even when the value can't be coerced.
        }
        if (typeof value === 'string') {
            properties[key] = value;
        }
        else if (typeof value === 'boolean') {
            properties[key] = value ? 'true' : 'false';
        }
        else if (typeof value === 'number') {
            properties[key] = String(value);
        }
        else {
            try {
                properties[key] = JSON.stringify(value);
            }
            catch {
                properties[key] = String(value);
            }
        }
    }

    return { properties, measurements };
}

function attachCorrelations(properties: { [key: string]: string }, correlations: TelemetryEventCorrelation[] | undefined): void {
    if (!correlations || correlations.length === 0) {
        return;
    }
    properties.correlated_with = correlations.map(c => `${c.eventType}:${c.id}`).join(';');
}

// Re-exported so `getTelemetryReporter` isn't a hidden coupling — callers
// importing this module can verify the reporter is wired before mounting.
export { getTelemetryReporter };

// Exported for unit tests so the property/measurement routing rules can be
// covered without standing up an Express app or a TelemetryReporter.
export const __testOnly__ = { flattenProperties };
