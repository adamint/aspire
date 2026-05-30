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
// lock-step — if the dashboard adds a new field, add it here too.
//
// IMPORTANT: property names use camelCase here even though the C# records
// use PascalCase. The dashboard sends requests via `HttpClient.PostAsJsonAsync`
// without explicit options, which since .NET 9 uses `JsonSerializerOptions.Web`
// by default (https://learn.microsoft.com/dotnet/api/system.net.http.json.jsoncontent.create
// — "if options is null, the JsonSerializerOptions.Web instance is used").
// Web defaults set `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`, so a
// C# record `EndOperationRequest(string Id, TelemetryResult Result, string? ErrorMessage)`
// arrives on the wire as `{ "id": "...", "result": 2, "errorMessage": "..." }`.
//
// Similarly, enums without `[JsonStringEnumConverter]` serialize as integers,
// not strings. `TelemetryResult` and `FaultSeverity` (see VisualStudioTelemetryTypes.cs)
// do NOT have the attribute, so they arrive as numbers. `DataModelEventType` (the
// inner enum on `TelemetryEventCorrelation.EventType`) does have the attribute,
// so it arrives as a string. We model each enum below in its actual wire form
// and translate to telemetry-friendly string labels at the point of emission.
//
// Verified empirically against `JsonContent.Create<T>` on .NET 10 for the actual
// record types declared in `src/Aspire.Dashboard/Telemetry/`.
// ─────────────────────────────────────────────────────────────────────────────

interface AspireTelemetryProperty {
    value: unknown;
    propertyType?: AspireTelemetryPropertyType;
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

// Matches `TelemetryResult` enum in VisualStudioTelemetryTypes.cs. No
// `[JsonStringEnumConverter]` is applied, so the wire form is the underlying
// int. We map to readable labels at the point of emission.
type TelemetryResult = 0 | 1 | 2 | 3 | 4;
const TelemetryResultLabel: { readonly [K in TelemetryResult]: string } = {
    0: 'None',
    1: 'Success',
    2: 'Failure',
    3: 'UserFault',
    4: 'UserCancel',
};
function telemetryResultLabel(value: TelemetryResult | undefined): string {
    if (value === undefined) {
        return 'Unknown';
    }
    return TelemetryResultLabel[value] ?? `Unknown(${value})`;
}
// Failure / UserFault are routed through `sendTelemetryErrorEvent` so they
// participate in the reporter's stricter scrubbing pass.
function isFailureResult(value: TelemetryResult | undefined): boolean {
    return value === 2 || value === 3;
}

// Matches `FaultSeverity` enum in VisualStudioTelemetryTypes.cs. Same
// reasoning as `TelemetryResult` above — numeric on the wire.
type FaultSeverity = 0 | 1 | 2 | 3 | 4;
const FaultSeverityLabel: { readonly [K in FaultSeverity]: string } = {
    0: 'Uncategorized',
    1: 'Diagnostic',
    2: 'General',
    3: 'Critical',
    4: 'Crash',
};
function faultSeverityLabel(value: FaultSeverity | undefined): string {
    if (value === undefined) {
        return 'Unknown';
    }
    return FaultSeverityLabel[value] ?? `Unknown(${value})`;
}

interface TelemetryEventCorrelation {
    id: string;
    // `DataModelEventType` has `[JsonStringEnumConverter]` on the property in
    // VisualStudioTelemetryTypes.cs, so this one IS a string on the wire.
    eventType: 'UserTask' | 'Trace' | 'Operation' | 'Fault' | 'Asset';
}

interface AspireTelemetryScopeSettings {
    startEventProperties: { [key: string]: AspireTelemetryProperty };
    severity?: number;
    isOptOutFriendly?: boolean;
    correlations?: TelemetryEventCorrelation[];
    postStartEvent?: boolean;
}

interface StartOperationRequest {
    eventName: string;
    settings?: AspireTelemetryScopeSettings;
}

interface EndOperationRequest {
    id: string;
    result: TelemetryResult;
    errorMessage?: string;
}

interface PostOperationRequest {
    eventName: string;
    result: TelemetryResult;
    resultSummary?: string;
    properties?: { [key: string]: AspireTelemetryProperty };
    correlatedWith?: TelemetryEventCorrelation[];
}

interface PostFaultRequest {
    eventName: string;
    description: string;
    severity: FaultSeverity;
    properties?: { [key: string]: AspireTelemetryProperty };
    correlatedWith?: TelemetryEventCorrelation[];
}

interface PostAssetRequest {
    eventName: string;
    assetId: string;
    assetEventVersion: number;
    additionalProperties?: { [key: string]: AspireTelemetryProperty };
    correlatedWith?: TelemetryEventCorrelation[];
}

interface PostPropertyRequest {
    propertyName: string;
    propertyValue: AspireTelemetryProperty;
}

interface PostCommandLineFlagsRequest {
    flagPrefixes: string[];
    additionalProperties: { [key: string]: AspireTelemetryProperty };
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
        // if this returns `IsEnabled: true`. We honor both the extension's reporter
        // availability AND the user's VS Code telemetry setting.
        //
        // The dashboard reads the response via `ReadFromJsonAsync<TelemetryEnabledResponse>()`
        // which (since .NET 9) uses `JsonSerializerOptions.Web` defaults —
        // case-insensitive matching, camelCase naming policy. Returning the
        // PascalCase, camelCase, and snake_case variants belt-and-suspenders
        // because older C# Dev Kit / Visual Studio hosts have used all three
        // shapes historically; the cost is a 30-byte response body.
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
            const { properties, measurements } = flattenProperties(payload.properties);
            properties.result = telemetryResultLabel(payload.result);
            if (payload.resultSummary) {
                properties.result_summary = payload.resultSummary;
            }
            attachCorrelations(properties, payload.correlatedWith);
            const emit = isFailureResult(payload.result) ? sendTelemetryErrorEvent : sendTelemetryEvent;
            emit(payload.eventName, properties, measurements);
            res.json(this._newCorrelation('Operation'));
        });

        app.post('/telemetry/userTask', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostOperationRequest;
            const { properties, measurements } = flattenProperties(payload.properties);
            properties.result = telemetryResultLabel(payload.result);
            if (payload.resultSummary) {
                properties.result_summary = payload.resultSummary;
            }
            attachCorrelations(properties, payload.correlatedWith);
            const emit = isFailureResult(payload.result) ? sendTelemetryErrorEvent : sendTelemetryEvent;
            emit(payload.eventName, properties, measurements);
            res.json(this._newCorrelation('UserTask'));
        });

        app.post('/telemetry/fault', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostFaultRequest;
            const { properties, measurements } = flattenProperties(payload.properties);
            properties.description = scrubFreeformDiagnosticText(payload.description);
            properties.fault_severity = faultSeverityLabel(payload.severity);
            attachCorrelations(properties, payload.correlatedWith);
            sendTelemetryErrorEvent(payload.eventName, properties, measurements);
            res.json(this._newCorrelation('Fault'));
        });

        app.post('/telemetry/asset', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostAssetRequest;
            const { properties, measurements } = flattenProperties(payload.additionalProperties);
            properties.asset_id = payload.assetId;
            properties.asset_event_version = String(payload.assetEventVersion);
            attachCorrelations(properties, payload.correlatedWith);
            sendTelemetryEvent(payload.eventName, properties, measurements);
            res.json(this._newCorrelation('Asset'));
        });

        app.post('/telemetry/property', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostPropertyRequest;
            // The TelemetryReporter API has no "set session property" concept,
            // so we surface the property as a one-off `property/set` event.
            // Receiving teams can pivot on `property_name` to extract the
            // current session value if they need it.
            const { properties, measurements } = flattenProperties({ value: payload.propertyValue });
            properties.property_name = payload.propertyName;
            sendTelemetryEvent('dashboard/property/set', properties, measurements);
            res.status(200).end();
        });

        app.post('/telemetry/recurringProperty', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostPropertyRequest;
            const { properties, measurements } = flattenProperties({ value: payload.propertyValue });
            properties.property_name = payload.propertyName;
            sendTelemetryEvent('dashboard/property/recurring', properties, measurements);
            res.status(200).end();
        });

        app.post('/telemetry/commandLineFlags', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostCommandLineFlagsRequest;
            const { properties, measurements } = flattenProperties(payload.additionalProperties);
            properties.flag_prefixes = (payload.flagPrefixes ?? []).join(',');
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

        // Project just the fields we need into locals so the abandonment timer
        // closure below does not retain the entire `payload` (which can include
        // an arbitrarily large `settings.startEventProperties` bag) for the
        // 1-hour TTL.
        const eventName = payload.eventName;
        const { properties, measurements } = flattenProperties(payload.settings?.startEventProperties);
        const postStartEvent = payload.settings?.postStartEvent !== false;

        const pending: PendingOperation = {
            eventName,
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
                extensionLogOutputChannel.warn(`Dashboard telemetry ${kind} '${eventName}' (${operationId}) abandoned after ${DashboardTelemetryPassthrough._abandonedOperationTtlMs}ms with no end`);
            }, DashboardTelemetryPassthrough._abandonedOperationTtlMs),
        };
        this._pendingOperations.set(operationId, pending);

        if (postStartEvent) {
            const startProps = { ...properties, operation_id: operationId, kind: `${kind}.start` };
            attachCorrelations(startProps, payload.settings?.correlations);
            sendTelemetryEvent(`${eventName}/start`, startProps, measurements);
        }

        res.json({ OperationId: operationId, Correlation: correlation });
    }

    private _handleEnd(req: Request, res: Response): void {
        const payload = req.body as EndOperationRequest;
        const pending = this._pendingOperations.get(payload.id);
        if (!pending) {
            // Either the matching start was abandoned, or the dashboard sent
            // an end without a matching start (programmer error on the
            // dashboard side). Either way: drop and respond 200; failing the
            // request would just generate noise.
            res.status(200).end();
            return;
        }

        this._pendingOperations.delete(payload.id);
        clearTimeout(pending.timer);

        const durationMs = Date.now() - pending.startTime;
        const endProperties: { [key: string]: string } = {
            ...pending.startProperties,
            operation_id: payload.id,
            result: telemetryResultLabel(payload.result),
            kind: `${pending.kind}.end`,
        };
        if (payload.errorMessage) {
            endProperties.error_message = scrubFreeformDiagnosticText(payload.errorMessage);
        }
        const endMeasurements: { [key: string]: number } = {
            ...pending.startMeasurements,
            duration_ms: durationMs,
        };
        attachCorrelations(endProperties, [pending.correlation]);

        // Failure results are surfaced as error events so they participate in
        // the more aggressive error-event sanitization pass. UserCancel is
        // routine UX and stays in the standard channel.
        if (isFailureResult(payload.result)) {
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
 *
 * Input keys are camelCase (`value`, `propertyType`) because the dashboard
 * serializes via `HttpClient.PostAsJsonAsync` whose default options are
 * `JsonSerializerOptions.Web` since .NET 9.
 */
function flattenProperties(input: { [key: string]: AspireTelemetryProperty } | undefined): { properties: { [key: string]: string }, measurements: { [key: string]: number } } {
    const properties: { [key: string]: string } = {};
    const measurements: { [key: string]: number } = {};

    if (!input) {
        return { properties, measurements };
    }

    for (const [key, prop] of Object.entries(input)) {
        if (!prop || prop.value === undefined || prop.value === null) {
            continue;
        }
        if (prop.propertyType === PropertyType.Pii) {
            continue;
        }
        const value = prop.value;
        if (prop.propertyType === PropertyType.Metric) {
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

// Maximum length of free-form diagnostic strings we forward from the dashboard
// (error_message on EndOperation, description on PostFault). Long enough to
// preserve useful framing/cause information, short enough that an accidental
// path or stack-trace fragment cannot dump the whole thing into telemetry.
// `@vscode/extension-telemetry` performs additional PII scrubbing on the
// remainder, so this cap is defense-in-depth, not the only mitigation.
const MAX_DIAGNOSTIC_STRING_LENGTH = 1024;

/**
 * Sanitizes user-facing diagnostic text we forward from the dashboard. Two
 * mitigations:
 *  - Truncate to {@link MAX_DIAGNOSTIC_STRING_LENGTH} characters so a long
 *    stack trace or rendered exception message cannot serve as a side channel
 *    for arbitrary workspace content.
 *  - The remaining content still runs through `sendTelemetryErrorEvent`, which
 *    `@vscode/extension-telemetry` scrubs more aggressively than basic events
 *    (home-directory paths, emails, well-known token shapes).
 *
 * This is intentionally not a PII filter — the dashboard's exception messages
 * can contain user-controlled strings (e.g. resource names) that aren't in
 * the reporter's pattern set. The README documents this as a known limitation
 * of the passthrough channel.
 */
function scrubFreeformDiagnosticText(text: string | undefined): string {
    if (!text) {
        return '';
    }
    if (text.length <= MAX_DIAGNOSTIC_STRING_LENGTH) {
        return text;
    }
    // Marker so receivers can recognize truncation without parsing the length.
    return text.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH) + '...[truncated]';
}

// Re-exported so `getTelemetryReporter` isn't a hidden coupling — callers
// importing this module can verify the reporter is wired before mounting.
export { getTelemetryReporter };

// Exported for unit tests so the property/measurement routing rules can be
// covered without standing up an Express app or a TelemetryReporter.
export const __testOnly__ = { flattenProperties, telemetryResultLabel, faultSeverityLabel, isFailureResult, scrubFreeformDiagnosticText, MAX_DIAGNOSTIC_STRING_LENGTH };
