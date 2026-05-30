import { Request, Response, Express, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { extensionLogOutputChannel } from '../utils/logging';
import { isExtensionTelemetryEnabled, sendTelemetryErrorEvent, sendTelemetryEvent } from '../utils/telemetry';
import { EventMeasurements, EventProperties } from '../utils/telemetryRegistry';

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
// without explicit options; that helper goes through
// `System.Net.Http.Json.JsonContent.Create<T>` whose default options come from
// `JsonHelpers.s_defaultSerializerOptions = new(JsonSerializerDefaults.Web)`
// on net8.0 (the dashboard's TFM) — see
// https://github.com/dotnet/runtime/blob/release/8.0/src/libraries/System.Net.Http.Json/src/System/Net/Http/Json/JsonHelpers.cs
// `JsonSerializerDefaults.Web` sets `PropertyNamingPolicy.CamelCase`, so a C#
// record `EndOperationRequest(string Id, TelemetryResult Result, ...)` arrives
// as `{"id":"...","result":2,...}`. Verified empirically by running
// `JsonContent.Create<T>` on net8.0 and net10.0 against the actual record
// types in `src/Aspire.Dashboard/Telemetry/`.
//
// Similarly, enums without `[JsonStringEnumConverter]` serialize as integers,
// not strings. `TelemetryResult` and `FaultSeverity` (VisualStudioTelemetryTypes.cs)
// do NOT have the attribute, so they arrive as numbers. `DataModelEventType`
// (the inner enum on `TelemetryEventCorrelation.EventType`) does have the
// attribute, so it arrives as a string. We model each enum below in its actual
// wire form and translate to readable labels at the point of emission.
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
// `startProperties` / `startMeasurements` are stored as the JSON-encoded
// strings produced by {@link bundleDashboardData} (i.e. the values that go
// straight into the `dashboard_properties` / `dashboard_measurements`
// telemetry fields). Keeping them serialized avoids re-bundling on end and
// avoids retaining the original `AspireTelemetryProperty` bag for the
// abandonment TTL.
//
// An entry can also be abandoned: if the dashboard never sends an `end`
// (e.g. the dashboard crashes mid-operation) we'd otherwise leak memory.
// Abandoned entries are reaped after `_abandonedOperationTtlMs`.
interface PendingOperation {
    eventName: string;
    kind: 'operation' | 'userTask';
    correlation: TelemetryEventCorrelation;
    startTime: number;
    startProperties: string | undefined;
    startMeasurements: string | undefined;
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
        // GET /telemetry/enabled — declares whether the extension is willing
        // to accept dashboard telemetry. We require the bearer token here too
        // (the dashboard already sends it on this call via
        // `DashboardTelemetrySender.GetIsTelemetryEnabledAsync`), so an
        // unauthenticated probe can't enumerate whether telemetry is on.
        //
        // The dashboard reads the response via
        // `ReadFromJsonAsync<TelemetryEnabledResponse>()` whose default
        // options use case-insensitive property matching, so any casing works
        // for the dashboard side. We emit PascalCase, camelCase, AND
        // snake_case as defense in depth — if some other consumer ever reads
        // this endpoint with a strict case-sensitive parser, a casing
        // mismatch shouldn't silently disable dashboard telemetry.
        app.get('/telemetry/enabled', requireHeaders, (_req, res) => {
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
            this._handlePostResultEvent(req, res, 'dashboard/operation', 'Operation');
        });

        app.post('/telemetry/userTask', requireHeaders, (req: Request, res: Response) => {
            this._handlePostResultEvent(req, res, 'dashboard/userTask', 'UserTask');
        });

        app.post('/telemetry/fault', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostFaultRequest;
            const properties: EventProperties<'dashboard/fault'> = {
                dashboard_event_name: clampDashboardKey(payload.eventName),
                description: scrubFreeformDiagnosticText(payload.description),
                fault_severity: faultSeverityLabel(payload.severity),
            };
            applyBundleAndCorrelations(properties, payload.properties, payload.correlatedWith);
            sendTelemetryErrorEvent('dashboard/fault', properties);
            res.json(this._newCorrelation('Fault'));
        });

        app.post('/telemetry/asset', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostAssetRequest;
            const properties: EventProperties<'dashboard/asset'> = {
                dashboard_event_name: clampDashboardKey(payload.eventName),
                asset_id: clampDashboardKey(payload.assetId),
                asset_event_version: String(payload.assetEventVersion),
            };
            applyBundleAndCorrelations(properties, payload.additionalProperties, payload.correlatedWith);
            sendTelemetryEvent('dashboard/asset', properties);
            res.json(this._newCorrelation('Asset'));
        });

        // Both /property and /recurringProperty have byte-identical handler
        // bodies — only the registered event name differs. Parameterize so a
        // future field change has exactly one site to touch.
        app.post('/telemetry/property', requireHeaders, this._propertyHandler('dashboard/property/set'));
        app.post('/telemetry/recurringProperty', requireHeaders, this._propertyHandler('dashboard/property/recurring'));

        app.post('/telemetry/commandLineFlags', requireHeaders, (req: Request, res: Response) => {
            const payload = req.body as PostCommandLineFlagsRequest;
            const properties: EventProperties<'dashboard/commandLineFlags'> = {
                flag_prefixes: formatFlagPrefixes(payload.flagPrefixes),
            };
            applyBundleFields(properties, payload.additionalProperties);
            sendTelemetryEvent('dashboard/commandLineFlags', properties);
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
        const eventName = clampDashboardKey(payload.eventName);
        const bundle = bundleDashboardData(payload.settings?.startEventProperties);
        const postStartEvent = payload.settings?.postStartEvent !== false;

        // Cap the in-flight set with FIFO eviction. Without this, a dashboard
        // bug that spams startOperation without ever calling endOperation
        // could retain MAX_PENDING_OPERATIONS × (eventName + bundle string +
        // timer) for the abandonment TTL and exhaust extension memory.
        if (this._pendingOperations.size >= MAX_PENDING_OPERATIONS) {
            const oldestId = this._pendingOperations.keys().next().value as string | undefined;
            if (oldestId !== undefined) {
                const oldest = this._pendingOperations.get(oldestId);
                if (oldest) {
                    clearTimeout(oldest.timer);
                    this._pendingOperations.delete(oldestId);
                    extensionLogOutputChannel.warn(`Dashboard telemetry pending-operations cap (${MAX_PENDING_OPERATIONS}) reached; evicting oldest entry '${oldest.eventName}' (${oldestId})`);
                }
            }
        }

        const pending: PendingOperation = {
            eventName,
            kind,
            correlation,
            startTime: Date.now(),
            startProperties: bundle.properties,
            startMeasurements: bundle.measurements,
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
            const startProps: EventProperties<'dashboard/scope/start'> = {
                dashboard_event_name: eventName,
                operation_id: operationId,
                scope_kind: kind,
            };
            applyBundleAndCorrelations(startProps, payload.settings?.startEventProperties, payload.settings?.correlations);
            sendTelemetryEvent('dashboard/scope/start', startProps);
        }

        // Response shape matches the dashboard's `StartOperationResponse`
        // record. camelCase here for the reason documented in the file
        // header — `JsonContent.Create<T>` defaults to Web naming, so the
        // rest of the wire is camelCase and we keep this endpoint consistent.
        res.json({ operationId, correlation });
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
        const endProperties: EventProperties<'dashboard/scope/end'> = {
            dashboard_event_name: pending.eventName,
            operation_id: payload.id,
            scope_kind: pending.kind,
            result: telemetryResultLabel(payload.result),
        };
        if (pending.startProperties !== undefined) {
            endProperties.dashboard_properties = pending.startProperties;
        }
        if (pending.startMeasurements !== undefined) {
            endProperties.dashboard_measurements = pending.startMeasurements;
        }
        if (payload.errorMessage) {
            endProperties.error_message = scrubFreeformDiagnosticText(payload.errorMessage);
        }
        // Intentionally do NOT set `dashboard_correlated_with` on scope/end.
        // `operation_id` already joins start↔end events deterministically,
        // and `dashboard_correlated_with` on every OTHER event means "this
        // event was correlated WITH the listed others". Reusing it here to
        // carry the operation's OWN minted correlation would give the same
        // property two incompatible meanings depending on event name —
        // downstream queries would have no way to tell them apart.

        const endMeasurements: EventMeasurements<'dashboard/scope/end'> = {
            duration_ms: durationMs,
        };

        // Failure results are surfaced as error events so they participate in
        // the more aggressive error-event sanitization pass. UserCancel is
        // routine UX and stays in the standard channel.
        if (isFailureResult(payload.result)) {
            sendTelemetryErrorEvent('dashboard/scope/end', endProperties, endMeasurements);
        }
        else {
            sendTelemetryEvent('dashboard/scope/end', endProperties, endMeasurements);
        }

        res.status(200).end();
    }

    /**
     * Shared body for /telemetry/operation and /telemetry/userTask, which
     * accept the same `PostOperationRequest` payload and emit byte-identical
     * event shapes (only the event name differs). Inline duplication was the
     * single largest source of drift risk in this file pre-refactor.
     */
    private _handlePostResultEvent(
        req: Request,
        res: Response,
        eventName: 'dashboard/operation' | 'dashboard/userTask',
        correlationType: 'Operation' | 'UserTask',
    ): void {
        const payload = req.body as PostOperationRequest;
        const properties: EventProperties<'dashboard/operation' | 'dashboard/userTask'> = {
            dashboard_event_name: clampDashboardKey(payload.eventName),
            result: telemetryResultLabel(payload.result),
        };
        if (payload.resultSummary) {
            properties.result_summary = scrubFreeformDiagnosticText(payload.resultSummary);
        }
        applyBundleAndCorrelations(properties, payload.properties, payload.correlatedWith);
        if (isFailureResult(payload.result)) {
            sendTelemetryErrorEvent(eventName, properties);
        }
        else {
            sendTelemetryEvent(eventName, properties);
        }
        res.json(this._newCorrelation(correlationType));
    }

    /**
     * Factory for /telemetry/property and /telemetry/recurringProperty handlers
     * — same payload, same event shape, different event name. Bundling the
     * single property value through `bundleDashboardData` is what keeps the
     * classification catalog from gaining a new row every time the dashboard
     * starts setting a new session property.
     */
    private _propertyHandler(eventName: 'dashboard/property/set' | 'dashboard/property/recurring') {
        return (req: Request, res: Response): void => {
            const payload = req.body as PostPropertyRequest;
            const properties: EventProperties<'dashboard/property/set' | 'dashboard/property/recurring'> = {
                property_name: clampDashboardKey(payload.propertyName),
            };
            applyBundleFields(properties, { value: payload.propertyValue });
            sendTelemetryEvent(eventName, properties);
            res.status(200).end();
        };
    }

    private _newCorrelation(eventType: TelemetryEventCorrelation['eventType']): TelemetryEventCorrelation {
        return { id: randomUUID(), eventType };
    }
}

/**
 * Applies `bundleDashboardData`'s output onto a telemetry event's standard
 * bundle fields. Exists to dedupe ~50 lines of `if (bundle.properties !== ...)
 * target.dashboard_properties = bundle.properties; ...` boilerplate that
 * repeats across every dashboard route.
 *
 * The target's type only constrains `dashboard_properties` /
 * `dashboard_measurements`, so it satisfies every event entry in the registry
 * that declares those two properties (which all dashboard events do).
 */
function applyBundleFields(
    target: { dashboard_properties?: string; dashboard_measurements?: string },
    properties: { [key: string]: AspireTelemetryProperty } | undefined,
): void {
    const bundle = bundleDashboardData(properties);
    if (bundle.properties !== undefined) {
        target.dashboard_properties = bundle.properties;
    }
    if (bundle.measurements !== undefined) {
        target.dashboard_measurements = bundle.measurements;
    }
}

/**
 * Like {@link applyBundleFields} but also handles `dashboard_correlated_with`
 * for routes that accept a `correlatedWith` payload field.
 */
function applyBundleAndCorrelations(
    target: {
        dashboard_properties?: string;
        dashboard_measurements?: string;
        dashboard_correlated_with?: string;
    },
    properties: { [key: string]: AspireTelemetryProperty } | undefined,
    correlations: unknown,
): void {
    applyBundleFields(target, properties);
    const correlated = formatCorrelations(correlations);
    if (correlated !== undefined) {
        target.dashboard_correlated_with = correlated;
    }
}

/**
 * Bundles a dashboard property bag into the JSON-encoded property/measurement
 * pair that gets placed on a telemetry event. The caller decides which event
 * fields the result writes into; this helper only knows about "properties" and
 * "measurements" (the dashboard-side concepts).
 *
 * Why JSON-bundle instead of forwarding each key as its own telemetry property?
 *
 *   The data-classification catalog stores one classification row per
 *   (EntityName, PropertyName) pair. Forwarding every dashboard key as its
 *   own property would let an upstream dashboard change silently grow the
 *   classification surface every time a new key is added. Bundling collapses
 *   the entire per-event bag into two well-known property names, so the
 *   catalog footprint stays constant regardless of what the dashboard sends.
 *
 * Routing rules (within the bundle):
 *  - Properties tagged `Metric` are placed in the measurements bundle. The
 *    dashboard serializes metric values as invariant-culture strings (see
 *    `src/Aspire.Dashboard/Components/Pages/Metrics.razor.cs` and
 *    `StructuredLogs.razor.cs` where
 *    `int.ToString(CultureInfo.InvariantCulture)` is invoked before wrapping
 *    in `AspireTelemetryProperty(..., Metric)`), so we parse strings as well
 *    as accept raw numbers. Anything we can't coerce to a finite number falls
 *    through to the string-properties bundle.
 *  - Properties tagged `Pii` are dropped. The dashboard does not actually tag
 *    anything as `Pii` today, but honoring the discriminator keeps the
 *    README's "no resource names or workspace contents are reported"
 *    guarantee enforced end-to-end rather than incidental.
 *  - Everything else is stringified into the properties bundle (objects are
 *    JSON-encoded so they survive — TelemetryReporter only supports string
 *    values, but the dashboard occasionally sends complex objects, e.g. enum
 *    descriptors).
 *
 * Privacy mitigation (per-entry):
 *  - Every string value (including JSON-stringified objects) is capped at
 *    {@link MAX_DIAGNOSTIC_STRING_LENGTH} via {@link scrubFreeformDiagnosticText}.
 *    The dashboard's `TelemetryErrorRecorder` puts the exception type, the
 *    exception message, and the *full stack trace* into the properties
 *    dictionary tagged `Basic`
 *    (see `src/Aspire.Dashboard/Telemetry/TelemetryErrorRecorder.cs`). On
 *    Windows those stack traces include home-directory paths; on .NET they
 *    include type names from user assemblies. Without a per-entry cap a
 *    single property value could dump multiple KB of arbitrary workspace
 *    content through the bundle, defeating the README's "no workspace
 *    contents are reported" guarantee. The cap is applied uniformly so any
 *    future `Basic`-tagged free-form text property is automatically limited.
 *  - Every KEY is also clamped to {@link MAX_DASHBOARD_KEY_LENGTH} via
 *    {@link clampDashboardKey}. Keys come from the dashboard verbatim and
 *    could (via a bug or future telemetry refactor) end up carrying paths
 *    or similar workspace content. Same defense as for values.
 *
 * Guardrails (per-bundle):
 *  - At most {@link MAX_BUNDLE_ENTRIES} entries per bundle. Subsequent
 *    entries are dropped and the bundle is wrapped in a `{ v, t: true }`
 *    envelope so consumers can detect that data was lost.
 *  - The serialized JSON for each bundle is capped at
 *    {@link MAX_BUNDLE_CHARS}. If the cap is exceeded, the trailing entries
 *    are removed until the cap is met and the truncation marker is set.
 *  - Empty bundles return `undefined` (so the bundle field is simply omitted
 *    from the resulting telemetry event).
 *
 * Output shape: each bundle field, when present, contains a JSON-encoded
 * envelope `{ "v": { ...real entries... }, "t"?: true }`. The wrapper exists
 * specifically so a real dashboard property literally named `__truncated__`
 * (or any other marker key) cannot be confused with the truncation flag —
 * everything the dashboard sends lives strictly inside `v`.
 */
function bundleDashboardData(input: { [key: string]: AspireTelemetryProperty } | undefined): {
    properties?: string;
    measurements?: string;
} {
    const result: { properties?: string; measurements?: string } = {};
    // Defensive: reject anything that isn't a plain object. Arrays would
    // iterate via Object.entries with numeric string keys, strings would
    // iterate per-character, etc. — all harmless but unexpected.
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return result;
    }

    const properties: Array<[string, string]> = [];
    const measurements: Array<[string, number]> = [];
    let propTruncatedByCount = false;
    let measTruncatedByCount = false;

    for (const [rawKey, prop] of Object.entries(input)) {
        if (!prop || prop.value === undefined || prop.value === null) {
            continue;
        }
        if (prop.propertyType === PropertyType.Pii) {
            continue;
        }
        const key = clampDashboardKey(rawKey);
        const value = prop.value;
        if (prop.propertyType === PropertyType.Metric) {
            const numericValue = typeof value === 'number'
                ? value
                : typeof value === 'string'
                    ? Number(value)
                    : Number.NaN;
            if (Number.isFinite(numericValue)) {
                if (measurements.length < MAX_BUNDLE_ENTRIES) {
                    measurements.push([key, numericValue]);
                }
                else {
                    measTruncatedByCount = true;
                }
                continue;
            }
            // Fall through and persist as a string so the dimension still
            // surfaces even when the value can't be coerced.
        }
        if (properties.length >= MAX_BUNDLE_ENTRIES) {
            propTruncatedByCount = true;
            continue;
        }
        let stringValue: string;
        if (typeof value === 'string') {
            stringValue = value;
        }
        else if (typeof value === 'boolean') {
            stringValue = value ? 'true' : 'false';
        }
        else if (typeof value === 'number') {
            stringValue = String(value);
        }
        else {
            try {
                stringValue = JSON.stringify(value);
            }
            catch {
                stringValue = String(value);
            }
        }
        // Per-entry value truncation. See the privacy mitigation note on
        // bundleDashboardData — the dashboard's TelemetryErrorRecorder
        // forwards full stack traces as Basic-tagged properties, so any
        // single entry must be bounded before it ever reaches the bundle.
        properties.push([key, scrubFreeformDiagnosticText(stringValue)]);
    }

    if (properties.length > 0 || propTruncatedByCount) {
        result.properties = serializeBundle(properties, propTruncatedByCount);
    }
    if (measurements.length > 0 || measTruncatedByCount) {
        result.measurements = serializeBundle(measurements, measTruncatedByCount);
    }
    return result;
}

/**
 * Serializes a bundle of `[key, value]` entries into the envelope wire format
 * `{ "v": {...}, "t"?: true }`. If the resulting JSON exceeds
 * {@link MAX_BUNDLE_CHARS}, trailing entries are dropped (preserving the
 * order in which they were observed) until the encoded length fits.
 *
 * Using an entry array — rather than building an object up front — keeps the
 * truncation order deterministic. ECMAScript object iteration places
 * integer-index-like string keys (e.g. "0", "1") ahead of other string keys
 * regardless of insertion order, so building the dropped-from object via
 * `Object.fromEntries` and then iterating it would silently reorder the
 * dashboard's keys. Iterating a flat tuple array sidesteps that entirely.
 */
function serializeBundle<V extends string | number>(entries: Array<readonly [string, V]>, truncatedByCount: boolean): string {
    const buildEnvelope = (count: number, truncated: boolean): string => {
        const v: Record<string, V> = {};
        for (let i = 0; i < count; i++) {
            v[entries[i][0]] = entries[i][1];
        }
        return truncated
            ? JSON.stringify({ v, t: true })
            : JSON.stringify({ v });
    };
    let serialized = buildEnvelope(entries.length, truncatedByCount);
    if (serialized.length <= MAX_BUNDLE_CHARS) {
        return serialized;
    }
    // Over the cap: drop entries from the end until we fit. Truncation flag
    // becomes true as soon as we lose any entry, even one that wasn't already
    // dropped by the count guard.
    let count = entries.length;
    while (count > 0) {
        count--;
        serialized = buildEnvelope(count, true);
        if (serialized.length <= MAX_BUNDLE_CHARS) {
            return serialized;
        }
    }
    return JSON.stringify({ v: {}, t: true });
}

/**
 * Formats a list of dashboard event correlations into the string value carried
 * by the `dashboard_correlated_with` telemetry property. Returns `undefined`
 * when the list is empty, missing, or malformed so callers can avoid setting
 * the property at all.
 *
 * Defensively validates the input shape: a malformed payload (non-array, or
 * elements that are not objects with string `eventType` / `id`) would
 * otherwise crash `.map(...)` and bubble out of the request handler as an
 * Express 500. Reachable only by bearer-authed callers, but cheap to harden.
 *
 * Wire format: `EventType:guid;EventType:guid;...` — preserved from the
 * previous inline implementation so the field stays back-compat for any
 * existing analytics that already parse it.
 */
function formatCorrelations(correlations: unknown): string | undefined {
    if (!Array.isArray(correlations) || correlations.length === 0) {
        return undefined;
    }
    // Cap the count defensively. The dashboard rarely sends more than a few
    // correlations per event; anything beyond MAX_CORRELATIONS is almost
    // certainly a bug or a malicious sender and is dropped silently.
    const formatted: string[] = [];
    for (const c of correlations) {
        if (formatted.length >= MAX_CORRELATIONS) {
            break;
        }
        if (!c || typeof c !== 'object') {
            continue;
        }
        const obj = c as { eventType?: unknown; id?: unknown };
        if (typeof obj.eventType !== 'string' || typeof obj.id !== 'string') {
            continue;
        }
        // Strip our wire-format delimiters from values so we can't ambiguate
        // the parser on the receiving side. The dashboard only ever sends
        // well-known enum names + UUIDs, but a future change shouldn't be
        // able to break the parser by mistake.
        const eventType = obj.eventType.replace(/[;:]/g, '_');
        const id = obj.id.replace(/[;:]/g, '_');
        formatted.push(`${eventType}:${id}`);
    }
    return formatted.length === 0 ? undefined : formatted.join(';');
}

// Per-bundle limits. The bundle ends up as a single string property on a
// telemetry event, so the underlying TelemetryReporter / Application Insights
// per-property length cap (~8192 chars) is the hard upper bound. We size each
// bundle at the per-property cap rather than splitting the budget; the
// per-event payload cap is much larger (~64 KB) so two bundles still fit
// comfortably. Entry count is bounded independently as a guard against
// pathological inputs (e.g. a dashboard regression that pours hundreds of
// per-frame metrics into a single event).
const MAX_BUNDLE_CHARS = 8192;
const MAX_BUNDLE_ENTRIES = 100;

// Maximum length of any single key inside the bundle, or any single
// dashboard-supplied short metadata string (event name, property name,
// asset id, flag prefix). Property names from the dashboard are typically
// under 80 chars (e.g. `aspire.dashboard.componentid`); 256 is generous
// and defense-in-depth against a future dashboard regression that puts a
// path or user-controlled string into a key. Applied uniformly so an
// attacker / buggy upstream can't smuggle PII through the metadata side.
const MAX_DASHBOARD_KEY_LENGTH = 256;

// Maximum length of free-form diagnostic strings we forward from the dashboard
// (error_message on EndOperation, description on PostFault). Long enough to
// preserve useful framing/cause information, short enough that an accidental
// path or stack-trace fragment cannot dump the whole thing into telemetry.
// `@vscode/extension-telemetry` performs additional PII scrubbing on the
// remainder, so this cap is defense-in-depth, not the only mitigation.
const MAX_DIAGNOSTIC_STRING_LENGTH = 1024;

// Caps on dashboard-supplied list-shaped fields. Both are formatted into a
// single string property on the resulting telemetry event, so an unbounded
// list would either blow the per-property cap or just produce noise.
const MAX_CORRELATIONS = 100;
const MAX_FLAG_PREFIXES = 100;

// Maximum number of in-flight start/end operations we track concurrently.
// Each entry holds an eventName + bundled start data + setTimeout for up to
// {@link DashboardTelemetryPassthrough._abandonedOperationTtlMs}. Without a
// cap, a misbehaving (or malicious) dashboard that spams `/startOperation`
// without ever calling `/endOperation` could exhaust the extension process's
// memory. When full, the oldest pending entry is evicted (its end event is
// dropped — same outcome as if it had been abandoned via the TTL).
const MAX_PENDING_OPERATIONS = 10_000;

/**
 * Clamps a single dashboard-supplied key/short-metadata string to
 * {@link MAX_DASHBOARD_KEY_LENGTH}. Used for bundle keys, event names,
 * property names, asset ids, and flag prefixes — anything dashboard-supplied
 * that the bundler/value-truncation path does not already cover.
 */
function clampDashboardKey(value: string): string {
    if (typeof value !== 'string') {
        return '';
    }
    if (value.length <= MAX_DASHBOARD_KEY_LENGTH) {
        return value;
    }
    return value.slice(0, MAX_DASHBOARD_KEY_LENGTH) + '...[truncated]';
}

/**
 * Formats the dashboard-supplied `flagPrefixes` array into the comma-joined
 * string we put on `dashboard/commandLineFlags`. Validates the input shape and
 * caps both count ({@link MAX_FLAG_PREFIXES}) and per-element length
 * ({@link clampDashboardKey}) so a malformed or malicious payload cannot
 * crash the request handler or produce a huge property value.
 */
function formatFlagPrefixes(prefixes: unknown): string {
    if (!Array.isArray(prefixes)) {
        return '';
    }
    const formatted: string[] = [];
    for (const p of prefixes) {
        if (formatted.length >= MAX_FLAG_PREFIXES) {
            break;
        }
        if (typeof p !== 'string') {
            continue;
        }
        // Strip commas defensively — they are our delimiter on the joined
        // wire format and an attacker should not be able to inject extra
        // synthetic prefixes by smuggling commas into a single string.
        formatted.push(clampDashboardKey(p).replace(/,/g, '_'));
    }
    return formatted.join(',');
}

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

// Exported for unit tests so the property/measurement routing rules can be
// covered without standing up an Express app or a TelemetryReporter.
export const __testOnly__ = {
    bundleDashboardData,
    formatCorrelations,
    formatFlagPrefixes,
    clampDashboardKey,
    telemetryResultLabel,
    faultSeverityLabel,
    isFailureResult,
    scrubFreeformDiagnosticText,
    MAX_DIAGNOSTIC_STRING_LENGTH,
    MAX_BUNDLE_CHARS,
    MAX_BUNDLE_ENTRIES,
    MAX_DASHBOARD_KEY_LENGTH,
    MAX_CORRELATIONS,
    MAX_FLAG_PREFIXES,
    MAX_PENDING_OPERATIONS,
};
