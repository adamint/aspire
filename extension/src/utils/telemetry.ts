import { TelemetryReporter } from '@vscode/extension-telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    CommonTelemetryProperties,
    CommonTelemetryProperty,
    EventMeasurements,
    EventProperties,
    KnownTelemetryEventName,
} from './telemetryRegistry';

export type {
    KnownTelemetryEventName,
    EventProperties,
    EventMeasurements,
    CommonTelemetryProperty,
    CommonTelemetryProperties,
} from './telemetryRegistry';

// Module-private state.
// Aspire emits all telemetry through a single TelemetryReporter. We bypass
// VS Code's automatic `<extensionId>/<eventName>` prefix (added by
// `vscode.env.createTelemetryLogger`) by routing every event through
// `sendDangerousTelemetryEvent` / `sendDangerousTelemetryErrorEvent`, which
// reach the underlying sender without going through the prefix-applying
// logger. That gives us full control over the wire event name — the
// registry-declared names (e.g. `aspire/vscode/command/invoked`) ARE the
// names the telemetry backend sees.
//
// The "dangerous" variants skip the reporter's built-in telemetry-enabled
// gate, so we enforce it ourselves via `getCurrentTelemetryLevel()` below:
//   - regular events emit only when telemetry level === 'all'
//   - error events emit when level === 'all' or 'error'
//   - nothing emits when level is 'crash' or 'off'
// This mirrors what `@vscode/extension-telemetry` does for the non-dangerous
// path and matches `vscode.env.isTelemetryEnabled` for the regular channel.
//
// We keep the reporter as a module singleton because it is created at
// activation time and consumed from multiple places — the command wrapper,
// the engagement reporter, the tree view, the debug session, and the
// dashboard telemetry passthrough server.
let reporter: TelemetryReporter | undefined;
const telemetryReplacementOptions = [
    { lookup: /(?:^|_)(?:path|message|description|args?)(?:_|$)/i, replacementString: '<redacted>' },
];
const defaultTelemetryReporterFactory = (aiKey: string): TelemetryReporter => new TelemetryReporter(aiKey, telemetryReplacementOptions);
let telemetryReporterFactory = defaultTelemetryReporterFactory;
let reporterCommonProperties: Record<string, string> = {};

// `common.telemetryclientversion` is supposed to mirror what `@vscode/extension-telemetry` would
// have stamped automatically had we gone through its normal (non-"dangerous") send path. Reading
// the version straight from the dependency's own `package.json` — instead of hand-copying the
// pinned version from our `package.json` into a literal here — means a dependency bump can never
// leave this drifting: `require`d JSON is resolved at bundle time by webpack, so this stays correct
// in both the dev build and the packaged VSIX.
const defaultTelemetryClientVersionProvider = (): string =>
    (require('@vscode/extension-telemetry/package.json') as { version: string }).version;
let telemetryClientVersionProvider = defaultTelemetryClientVersionProvider;

// Aspire-specific common properties merged into every event we emit (e.g.
// detected AppHost language, run mode). Keep this key set intentionally tiny
// and registered in `telemetryRegistry.ts` because each common property
// duplicates into a row per event in the classification catalog.
// Values are kept as strings because @vscode/extension-telemetry only supports
// string-valued properties; numeric data must go through `measurements`.
const commonProperties: Partial<Record<CommonTelemetryProperty, string>> = {};

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
    // Use the ExtensionContext-provided package metadata so activation and
    // telemetry initialization read from the same extension manifest.
    const aiKey = context.extension.packageJSON.aiKey;
    if (aiKey) {
        reporterCommonProperties = getReporterCommonProperties(context);
        reporter = telemetryReporterFactory(aiKey);
        reporterIsTestInjected = false;
        context.subscriptions.push({ dispose: () => reporter?.dispose() });
    }
}

/**
 * Whether dashboard telemetry is allowed to leave the machine right now. The
 * dashboard has fault/failure events that route through the error channel, so
 * the passthrough handshake must stay enabled for VS Code's "errors only"
 * setting (`vscode.env.isTelemetryEnabled` is `false` in that mode because it
 * only reflects the *usage* channel, which is why we consult the reporter level
 * instead). Individual regular dashboard events are still gated to `'all'` at
 * send time by {@link sendTelemetryEvent}.
 *
 * We also require that telemetry is not in VS Code's "logging only" mode
 * (see {@link isTelemetryLoggingOnly}); otherwise the dashboard would start its
 * send loop and post events that our dangerous-send path would silently drop.
 */
export function isExtensionTelemetryEnabled(): boolean {
    if (reporter === undefined || isTelemetryLoggingOnly()) {
        return false;
    }

    const level = getCurrentTelemetryLevel();
    return level === 'all' || level === 'error';
}

/**
 * Returns the reporter's currently observed telemetry level. The level is
 * computed by `@vscode/extension-telemetry` from the VS Code user setting
 * (`telemetry.telemetryLevel`) and reflects state transitions over time
 * (so a user toggling telemetry off mid-session is honored immediately).
 *
 *  - `'all'`   → both usage and error events allowed
 *  - `'error'` → only error events allowed (e.g. user selected "errors only")
 *  - `'crash'` → only crash events (no usage, no errors via this API)
 *  - `'off'`   → nothing allowed
 *
 * Returns `'off'` when the reporter has not been initialized (or has been
 * disposed) so the dangerous-send path is a no-op in tests and when the
 * extension's aiKey is absent.
 */
function getCurrentTelemetryLevel(): 'all' | 'error' | 'crash' | 'off' {
    return reporter?.telemetryLevel ?? 'off';
}

// ── VS Code "telemetry logging only" detection ──────────────────────────────
// VS Code can run in a mode where telemetry is written to an output log but the
// sender is NEVER invoked — extension test hosts and OSS builds without a
// telemetry key are the common cases. `TelemetryLogger.logEvent` enforces this
// by skipping the sender when `isExtensionTelemetryLoggingOnly` is set, but the
// `sendDangerous*` APIs we use (to bypass the `<extensionId>/` name prefix) go
// straight to the sender and skip that check. Without the gate below, our
// extension tests would emit REAL telemetry to the production key.
//
// There is no public API that reports this state: verified empirically that in
// an extension test host `vscode.env.isTelemetryEnabled === true`,
// `TelemetryLogger.isUsageEnabled === true`, and `isErrorsEnabled === true`, yet
// routing an event through a real `TelemetryLogger` does NOT call the sender. So
// we detect the mode behaviorally — send a probe through a throwaway logger whose
// sender flips a flag and observe whether VS Code actually calls it. The probe
// logger has no telemetry key of its own, so probing can never itself emit.
let telemetryLoggingOnlyOverride: boolean | undefined;
let loggingModeProbeLogger: vscode.TelemetryLogger | undefined;
let loggingModeProbeSenderInvoked = false;
let cachedTelemetrySenderReachable: boolean | undefined;
// True only while a test has injected a fake reporter via `__setReporterForTests`.
// See isTelemetryLoggingOnly for why the gate is skipped for fakes.
let reporterIsTestInjected = false;

function isTelemetryLoggingOnly(): boolean {
    if (telemetryLoggingOnlyOverride !== undefined) {
        return telemetryLoggingOnlyOverride;
    }

    // A test-injected fake reporter records events in-process and never sends real
    // telemetry, so the logging-only protection (which exists to stop REAL emission
    // to the production key) does not apply. Without this, the extension test host —
    // which is itself logging-only — would suppress every emission-asserting test.
    // Production never sets this flag (only `__setReporterForTests` does).
    if (reporterIsTestInjected) {
        return false;
    }

    // Logging-only mode is fixed for the life of the extension host (it is decided
    // at launch), so cache the first definitive observation.
    if (cachedTelemetrySenderReachable !== undefined) {
        return !cachedTelemetrySenderReachable;
    }

    // The probe is only conclusive when a channel is actually enabled. At
    // 'off'/'crash' the level gate already blocks sends, so don't cache or
    // suppress anything extra here.
    const level = getCurrentTelemetryLevel();
    if (level !== 'all' && level !== 'error') {
        return false;
    }

    cachedTelemetrySenderReachable = probeTelemetrySenderReachable();
    return !cachedTelemetrySenderReachable;
}

function probeTelemetrySenderReachable(): boolean {
    if (loggingModeProbeLogger === undefined) {
        loggingModeProbeLogger = vscode.env.createTelemetryLogger({
            sendEventData: () => { loggingModeProbeSenderInvoked = true; },
            sendErrorData: () => { loggingModeProbeSenderInvoked = true; },
        }, { ignoreUnhandledErrors: true });
    }

    loggingModeProbeSenderInvoked = false;
    // Probe the error channel: it is enabled at both 'error' and 'all' levels, so a
    // real build always reaches the sender here while logging-only mode never does.
    loggingModeProbeLogger.logError('aspire/vscode/internal/telemetry-mode-probe');
    return loggingModeProbeSenderInvoked;
}

/**
 * Sets one or more common properties that will be merged into every event
 * emitted via {@link sendTelemetryEvent}, {@link sendTelemetryErrorEvent}, and
 * {@link withCommandTelemetry}. Existing values for the same keys are replaced.
 * `undefined` values clear a key.
 *
 * The key set is restricted to {@link CommonTelemetryProperty} on purpose:
 * every common property creates a (event, property) row in the classification
 * catalog for *every* event we emit, so adding one is a deliberate decision
 * that must go through `telemetryRegistry.ts`.
 */
export function setCommonTelemetryProperties(properties: CommonTelemetryProperties): void {
    for (const [key, value] of Object.entries(properties) as Array<[CommonTelemetryProperty, string | undefined]>) {
        if (value === undefined) {
            delete commonProperties[key];
        }
        else {
            commonProperties[key] = value;
        }
    }
}

export function getCommonTelemetryProperties(): Readonly<Partial<Record<CommonTelemetryProperty, string>>> {
    return commonProperties;
}

function mergeProperties<E extends KnownTelemetryEventName>(properties?: EventProperties<E>): { [key: string]: string } {
    // Spread order matters: explicit per-event properties win over commons so
    // a caller can override (e.g. tests forcing apphost_present to a known
    // value). The result is intentionally widened to `{ [key: string]: string }`
    // because that's what the underlying TelemetryReporter expects — the
    // narrow typing is enforced at the public wrapper boundary above.
    return sanitizeTelemetryProperties({
        ...reporterCommonProperties,
        ...commonProperties,
        ...((properties ?? {}) as { [key: string]: string }),
    });
}

function getReporterCommonProperties(context: vscode.ExtensionContext): Record<string, string> {
    const properties: Record<string, string> = {
        'common.extname': context.extension.id,
        'common.extversion': String(context.extension.packageJSON.version ?? ''),
        'common.vscodemachineid': vscode.env.machineId,
        'common.vscodesessionid': vscode.env.sessionId,
        'common.vscodeversion': vscode.version,
        'common.os': os.platform(),
        'common.nodeArch': os.arch(),
        'common.platformversion': os.release().replace(/^(\d+)(\.\d+)?(\.\d+)?(.*)/, '$1$2$3'),
        'common.product': vscode.env.appHost,
        'common.uikind': getUiKind(),
        'common.remotename': vscode.env.remoteName ?? 'none',
        'common.isnewappinstall': String(vscode.env.isNewAppInstall),
        'common.telemetryclientversion': telemetryClientVersionProvider(),
    };

    const commit = getVsCodeCommitHash();
    if (commit !== undefined) {
        properties['common.vscodecommithash'] = commit;
    }

    return properties;
}

function getUiKind(): string {
    switch (vscode.env.uiKind) {
        case vscode.UIKind.Desktop:
            return 'desktop';
        case vscode.UIKind.Web:
            return 'web';
        default:
            return String(vscode.env.uiKind);
    }
}

function getVsCodeCommitHash(): string | undefined {
    if (!vscode.env.appRoot) {
        return undefined;
    }

    const productJsonPath = path.join(vscode.env.appRoot, 'product.json');
    if (!fs.existsSync(productJsonPath)) {
        return undefined;
    }

    try {
        // This optional telemetry dimension must never block extension activation if VS Code's
        // product metadata is missing, unreadable, or malformed.
        const product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8')) as { commit?: unknown };
        return typeof product.commit === 'string' ? product.commit : undefined;
    }
    catch {
        return undefined;
    }
}

function sanitizeTelemetryProperties(properties: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(properties)) {
        sanitized[key] = sanitizeTelemetryValue(value, preservesStructuralTelemetryIds(key));
    }

    return sanitized;
}

function preservesStructuralTelemetryIds(key: string): boolean {
    return key === 'operation_id' ||
        key === 'asset_id' ||
        key === 'dashboard_correlated_with' ||
        key === 'common.vscodemachineid' ||
        key === 'common.vscodesessionid';
}

function sanitizeTelemetryValue(value: string, preserveGuids: boolean): string {
    // Redact, in order: emails, home directories, then secret/token assignments.
    // URL redaction runs LAST (see redactGenericFilesystemPaths' caller below) so that
    // an in-URL secret like `?sig=<value>` is first collapsed to `?sig=<redacted>` by
    // the secret pass and then the whole URL (host, path, query) is replaced by
    // `https://<redacted>`, leaving a single clean token rather than a doubled one.
    const withoutSecrets = redactHomeDirectories(value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>'))
        .replace(/\b(password|passwd|pwd|token|secret|sig|api[_-]?key|client[_-]?secret|account[_-]?key|shared[_-]?access[_-]?key|sharedaccesskey|connection[_-]?string|connectionstring|key)(\s*[:=]\s*)(?:(["'])([^"']*)\3|([^&\s"',;}]+))/gi, (_match: string, key: string, separator: string, quote: string | undefined) => `${key}${separator}${quote ?? ''}<redacted>${quote ?? ''}`)
        .replace(/([?&]sig=)(?:(["'])([^"']*)\2|([^&\s"',;}]+))/gi, (_match: string, prefix: string, quote: string | undefined) => `${prefix}${quote ?? ''}<redacted>${quote ?? ''}`)
        .replace(/\b(authorization\s*:\s*bearer\s+)[^\s"',;}]+/gi, '$1<redacted>')
        .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
    // Redact whole URLs (scheme kept, host/path/query replaced) and any remaining
    // absolute filesystem path. Running these after the secret passes keeps the
    // output a single clean token for the common `scheme://host/...?secret=...` shape.
    const sanitized = redactGenericFilesystemPaths(redactUrls(withoutSecrets));

    // GUID-shaped values can identify users, machines, or private cloud assets
    // when they appear in free-form fields. Keep dashboard correlation IDs
    // intact, though, because those structural fields are how start/end events
    // are joined downstream.
    if (preserveGuids) {
        return sanitized;
    }

    return sanitized.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<guid>');
}

function redactUrls(value: string): string {
    // VS Code's `TelemetryLogger.cleanData()` strips whole URLs; the dangerous send
    // path bypasses it, so restore equivalent redaction here. A value like
    // `https://acct.blob.core.windows.net/container/x?sig=...` would otherwise leak a
    // private host, path, and query. Redact everything after the scheme so private
    // hosts/paths/queries never leave the machine, keeping only the scheme for coarse
    // analytics (e.g. http vs file vs a custom remote scheme). The scheme grammar
    // follows RFC 3986 §3.1 (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`).
    //
    // The match body stops at whitespace and quotes (so it never crosses a JSON string
    // boundary and corrupt the surrounding structure) but deliberately allows `<` and
    // `>` so it absorbs a placeholder that an earlier secret pass already inserted in
    // the query (e.g. `.../?sig=<redacted>`), collapsing to a single `https://<redacted>`
    // instead of leaving a doubled `https://<redacted><redacted>`.
    return value.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"']+/g, (match: string) => `${match.slice(0, match.indexOf('://'))}://<redacted>`);
}

function redactGenericFilesystemPaths(value: string): string {
    // Home directories are redacted earlier; this collapses any *other* absolute
    // filesystem path (e.g. `/mnt/customer/project`, `/var/folders/xy/z`, or
    // `D:\Work\customer`) that would otherwise leak a workspace location. VS Code's
    // `cleanData()` strips these too. Relative, slash-separated strings such as the
    // dashboard event name `aspire/dashboard/component/open` are intentionally NOT
    // matched because they are not absolute paths.
    return value
        // Windows absolute paths outside the user's home tree. Segments may be
        // separated by one or more backslashes so JSON-encoded values like
        // `D:\\Work\\proj` are handled. The user's `C:\Users\<user>\...` tree is
        // already redacted, so skip it explicitly (a naive negative lookahead is
        // defeated by `\\+` backtracking across the doubled separators of a
        // JSON-encoded path, which would clobber the inserted `<user>` marker).
        .replace(/\b[A-Za-z]:\\+[^\s"'<>:;,|]*/g, (match: string) => /^[A-Za-z]:\\+Users(?:\\|$)/i.test(match) ? match : '<path>')
        // POSIX absolute paths outside the user's home tree. Require at least two
        // segments so a bare `/` or a lone `/word` (often a route or flag, not a path)
        // is left intact, and require a leading delimiter so relative event names are
        // not matched. `/Users/...` and `/home/...` are already redacted above.
        .replace(/(^|[\s"'=(:,|])\/(?!Users\/|home\/)[^/\s"'<>:;,|]+(?:\/[^/\s"'<>:;,|]*)+/g, (_match: string, prefix: string) => `${prefix}<path>`);
}

function redactHomeDirectories(value: string): string {
    const windowsPathSegment = '[^\\\\\\s"\':;,&|<>]+';
    const unixPathSegment = '[^/\\s"\':;,&|<>]+';
    const terminalUserName = '[^/\\\\\\s"\':;,&|<>-][^/\\\\\\s"\':;,&|<>]*(?: +[^/\\\\\\s"\':;,&|<>-][^/\\\\\\s"\':;,&|<>]*){0,3}?';
    const terminalBoundary = '(?=$|["\',;|]|\\s+--|\\s+-[A-Za-z0-9]|\\s+(?:&&|\\|\\||[|;,])|\\s+[A-Za-z_][A-Za-z0-9_.-]*=)';
    const windowsHomePattern = new RegExp(`\\b([A-Za-z]:)(\\\\+)Users(\\\\+)(?!<user>)(?:${windowsPathSegment}(?: +${windowsPathSegment})*(?=\\\\)|${terminalUserName}${terminalBoundary}|${windowsPathSegment})`, 'g');
    const macHomePattern = new RegExp(`(^|[^A-Za-z0-9_/-])/Users/(?!<user>)(?:${unixPathSegment}(?: +${unixPathSegment})*(?=/)|${terminalUserName}${terminalBoundary}|${unixPathSegment})`, 'g');
    const linuxHomePattern = new RegExp(`(^|[^A-Za-z0-9_/-])/home/(?!<user>)(?:${unixPathSegment}(?: +${unixPathSegment})*(?=/)|${terminalUserName}${terminalBoundary}|${unixPathSegment})`, 'g');

    return redactCurrentHomeDirectory(value)
        // Home-directory redaction. The username is a single path segment that can legitimately
        // contain spaces (e.g. `C:\Users\Alice Smith\project` or `/Users/Alice Smith/project`). Start
        // with the literal current home directory so command delimiters like `|`, `&&`, and free-form
        // words after a path do not confuse the generic best-effort patterns below. Then match either
        // a run of space-separated words that is still followed by the same-type path separator (the
        // username continues), a terminal path segment ending before a safe command boundary, OR a
        // single whitespace-free run (the historical behavior).
        //
        // Preserve the ORIGINAL backslash run lengths (captured groups) rather than emitting single
        // backslashes: a value can be a JSON-encoded blob like `"C:\\Users\\bob\\repo"`, and
        // collapsing `\\` to `\` there would corrupt the JSON so downstream consumers cannot parse it.
        .replace(/^([A-Za-z]:)(\\+)Users(\\+)[^\\\s"']+(?: +[^\\\s"']+)*$/g, (_, drive: string, usersSeparator: string, nameSeparator: string) => `${drive}${usersSeparator}Users${nameSeparator}<user>`)
        .replace(/^\/Users\/[^/\s"']+(?: +[^/\s"']+)*$/g, '/Users/<user>')
        .replace(/^\/home\/[^/\s"']+(?: +[^/\s"']+)*$/g, '/home/<user>')
        .replace(windowsHomePattern, (_match: string, drive: string, usersSeparator: string, nameSeparator: string) => `${drive}${usersSeparator}Users${nameSeparator}<user>`)
        .replace(macHomePattern, '$1/Users/<user>')
        .replace(linuxHomePattern, '$1/home/<user>');
}

function redactCurrentHomeDirectory(value: string): string {
    const homeDirectory = os.homedir().replace(/[\\/]+$/, '');
    const lastSeparatorIndex = Math.max(homeDirectory.lastIndexOf('/'), homeDirectory.lastIndexOf('\\'));
    if (lastSeparatorIndex <= 0) {
        return value;
    }

    const replacement = `${homeDirectory.slice(0, lastSeparatorIndex + 1)}<user>`;
    const flags = /^[A-Za-z]:[\\/]/.test(homeDirectory) ? 'gi' : 'g';

    return value.replace(new RegExp(`${escapeRegExp(homeDirectory)}(?=$|[\\\\/\\s"':;,&|()<>])`, flags), replacement);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Emit a telemetry event. The `eventName` is constrained to entries in
 * {@link KnownTelemetryEventName} (see telemetryRegistry.ts) and the
 * accepted `properties` / `measurements` keys are constrained to the per-event
 * union declared there. This prevents accidental introduction of new
 * (event, property) pairs that would need data classification.
 *
 * Routed through `sendDangerousTelemetryEvent` so the registry-declared event
 * name is what reaches the telemetry backend verbatim — VS Code's
 * `TelemetryLogger` would otherwise prepend `<extensionId>/` and turn
 * `aspire/vscode/command/invoked` into `microsoft-aspire.aspire-vscode/aspire/vscode/command/invoked`.
 * This path intentionally bypasses `TelemetryLogger.cleanData()`, so
 * {@link mergeProperties} applies our explicit value sanitizer before calling
 * the dangerous API.
 * Telemetry opt-in is enforced explicitly here (the dangerous API bypasses
 * the reporter's built-in gate) so we still respect the user's
 * `telemetry.telemetryLevel` setting and live changes to it, as well as VS
 * Code's "logging only" mode (see {@link isTelemetryLoggingOnly}).
 */
export function sendTelemetryEvent<E extends KnownTelemetryEventName>(
    eventName: E,
    properties?: EventProperties<E>,
    measurements?: EventMeasurements<E>
): void {
    if (reporter === undefined) {
        return;
    }

    // Regular (non-error) events require full telemetry. Mirrors the gate
    // `sendTelemetryEvent` applies internally via `TelemetryLogger.logUsage`.
    if (getCurrentTelemetryLevel() !== 'all') {
        return;
    }

    // The dangerous send path skips `TelemetryLogger`, so we must re-apply the
    // "logging only" suppression it would otherwise perform.
    if (isTelemetryLoggingOnly()) {
        return;
    }
    reporter.sendDangerousTelemetryEvent(eventName, mergeProperties(properties), measurements as { [key: string]: number } | undefined);
}

/**
 * Emits an error telemetry event. Use for faults (unexpected exceptions,
 * dashboard fault posts, etc.).
 *
 * The dangerous error path still emits an EventData/customEvent payload — in
 * `@vscode/extension-telemetry` 1.5.1 BOTH `sendDangerousTelemetryEvent` and
 * `sendDangerousTelemetryErrorEvent` call the same `telemetrySender.sendEventData`
 * (`baseType: "EventData"`), so this does NOT produce an App Insights exception
 * (`logException` / `ExceptionData`) envelope. Downstream distinguishes errors
 * by the registry-declared event name and the error-level opt-in gate below, not
 * by an envelope type. (A true exception envelope would require
 * `sendDangerousTelemetryException`, which we do not use.)
 *
 * Routed through `sendDangerousTelemetryErrorEvent` for the same reason as
 * {@link sendTelemetryEvent}: VS Code's TelemetryLogger would otherwise add
 * an extension-id prefix to the wire event name. Error events emit when the
 * user has opted into 'error' OR 'all' (i.e. anything except 'crash' / 'off'),
 * matching the standard non-dangerous error API's gate. This path intentionally
 * bypasses `TelemetryLogger.cleanData()`, so {@link mergeProperties} applies
 * our explicit value sanitizer before calling the dangerous API.
 */
export function sendTelemetryErrorEvent<E extends KnownTelemetryEventName>(
    eventName: E,
    properties?: EventProperties<E>,
    measurements?: EventMeasurements<E>
): void {
    if (reporter === undefined) {
        return;
    }

    const level = getCurrentTelemetryLevel();
    if (level !== 'all' && level !== 'error') {
        return;
    }

    // The dangerous send path skips `TelemetryLogger`, so we must re-apply the
    // "logging only" suppression it would otherwise perform.
    if (isTelemetryLoggingOnly()) {
        return;
    }
    reporter.sendDangerousTelemetryErrorEvent(eventName, mergeProperties(properties), measurements as { [key: string]: number } | undefined);
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

export interface CommandInvocationEvent {
    command: string;
    outcome: CommandOutcome;
    durationMs: number;
    source?: string;
    errorKind?: string;
}

const commandInvocationEmitter = new vscode.EventEmitter<CommandInvocationEvent>();
export const onDidInvokeCommand = commandInvocationEmitter.event;

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
    additionalProperties?: Partial<Record<'source', string>>
): Promise<T> {
    commandInvocationListener?.();
    const startTime = Date.now();
    let outcome: CommandOutcome = 'success';
    let errorKind: string | undefined;
    try {
        const result = await Promise.resolve(fn());
        if (isHandledCommandFailure(result)) {
            outcome = 'error';
            errorKind = getHandledCommandFailureKind(result);
        }

        return result;
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
        const properties: EventProperties<'aspire/vscode/command/invoked'> = {
            command: commandName,
            outcome,
            ...(additionalProperties ?? {}),
        };
        if (errorKind) {
            properties.error_kind = errorKind;
        }
        sendTelemetryEvent('aspire/vscode/command/invoked', properties, { duration_ms: durationMs });
        commandInvocationEmitter.fire({
            command: commandName,
            outcome,
            durationMs,
            source: additionalProperties?.source,
            errorKind,
        });
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

export function classifyError(err: unknown): string {
    if (err instanceof Error) {
        return normalizeErrorKind(err.name);
    }
    if (typeof err === 'string') {
        return 'String';
    }
    return typeof err;
}

function normalizeErrorKind(errorKind: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(errorKind) ? errorKind : 'Error';
}

function isHandledCommandFailure(value: unknown): value is { success: false; errorKind?: unknown } {
    if (typeof value !== 'object' || value === null || !('success' in value)) {
        return false;
    }

    // Some command implementations report handled failures as return values so VS Code does not
    // also show its generic "command failed" notification. Keep those visible in command telemetry.
    return (value as { success?: unknown }).success === false;
}

function getHandledCommandFailureKind(value: { errorKind?: unknown }): string {
    return typeof value.errorKind === 'string' && value.errorKind.length > 0
        ? normalizeErrorKind(value.errorKind)
        : 'HandledError';
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
    const previousInjected = reporterIsTestInjected;
    reporter = fake;
    reporterIsTestInjected = fake !== undefined;
    return () => { reporter = previous; reporterIsTestInjected = previousInjected; };
}

/**
 * Test seam: run the real logging-only behavioral probe directly, ignoring the
 * override and the test-fake exemption. Lets a test assert that VS Code's
 * "logging only" mode is genuinely detected in the current host (the extension
 * test host is logging-only) rather than merely trusting the override.
 */
export function __detectTelemetryLoggingOnlyForTests(): boolean {
    return !probeTelemetrySenderReachable();
}

/**
 * Test seam: force (or clear) the "telemetry logging only" detection so tests can
 * assert both the gated and ungated behavior without depending on the ambient
 * extension-host telemetry mode. Passing `undefined` restores real detection.
 * Returns a disposer that restores the previous override.
 */
export function __setTelemetryLoggingOnlyForTests(value: boolean | undefined): () => void {
    const previous = telemetryLoggingOnlyOverride;
    telemetryLoggingOnlyOverride = value;
    return () => { telemetryLoggingOnlyOverride = previous; };
}

/** Test seam: reset the logging-only override and cached probe so tests don't bleed into each other. */
export function __resetTelemetryLoggingModeForTests(): void {
    telemetryLoggingOnlyOverride = undefined;
    cachedTelemetrySenderReachable = undefined;
    loggingModeProbeLogger?.dispose();
    loggingModeProbeLogger = undefined;
}

/** Test seam: replace TelemetryReporter construction without initializing the real VS Code sender. */
export function __setTelemetryReporterFactoryForTests(factory: (aiKey: string) => TelemetryReporter): () => void {
    const previous = telemetryReporterFactory;
    telemetryReporterFactory = factory;
    return () => { telemetryReporterFactory = previous; };
}

/** Test seam: reset TelemetryReporter construction so tests don't bleed into each other. */
export function __resetTelemetryReporterFactoryForTests(): void {
    telemetryReporterFactory = defaultTelemetryReporterFactory;
}

/** Test seam: override how `common.telemetryclientversion` is resolved without touching `node_modules`. */
export function __setTelemetryClientVersionProviderForTests(provider: () => string): () => void {
    const previous = telemetryClientVersionProvider;
    telemetryClientVersionProvider = provider;
    return () => { telemetryClientVersionProvider = previous; };
}

/** Test seam: reset the telemetry client version provider so tests don't bleed into each other. */
export function __resetTelemetryClientVersionProviderForTests(): void {
    telemetryClientVersionProvider = defaultTelemetryClientVersionProvider;
}

/** Test seam: clear common properties so tests don't bleed into each other. */
export function __resetCommonPropertiesForTests(): void {
    for (const key of Object.keys(commonProperties) as CommonTelemetryProperty[]) {
        delete commonProperties[key];
    }
    reporterCommonProperties = {};
}
