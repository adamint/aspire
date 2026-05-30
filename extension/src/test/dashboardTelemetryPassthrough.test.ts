import * as assert from 'assert';
import { __testOnly__ } from '../dcp/DashboardTelemetryPassthrough';

const {
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
} = __testOnly__;

const PropertyType = {
    Pii: 0 as const,
    Basic: 1 as const,
    Metric: 2 as const,
    UserSetting: 3 as const,
};

suite('DashboardTelemetryPassthrough.bundleDashboardData', () => {
    test('returns empty object for undefined input', () => {
        assert.deepStrictEqual(bundleDashboardData(undefined), {});
    });

    test('returns empty object when every input entry is dropped (no leaking sentinel)', () => {
        // Inputs of all Pii / null / undefined should result in no bundle
        // fields at all — we do NOT want to emit an empty `{}` blob or a
        // truncation marker, because both would falsely advertise that
        // something was sent.
        const result = bundleDashboardData({
            email: { value: 'user@example.com', propertyType: PropertyType.Pii },
            absent: { value: null, propertyType: PropertyType.Basic },
        });
        assert.deepStrictEqual(result, {});
    });

    test('bundles invariant-culture string Metric values into dashboard_measurements', () => {
        // Dashboard emits metric values via int.ToString(CultureInfo.InvariantCulture);
        // see src/Aspire.Dashboard/Components/Pages/Metrics.razor.cs and
        // StructuredLogs.razor.cs. The contract is "tag is Metric, payload is a
        // string" — the bundler must route them to the measurements bundle.
        const result = bundleDashboardData({
            filter_count: { value: '3', propertyType: PropertyType.Metric },
            instrument_count: { value: '-1', propertyType: PropertyType.Metric },
        });
        assert.strictEqual(result.properties, undefined);
        assert.deepStrictEqual(JSON.parse(result.measurements ?? ''), {
            v: { filter_count: 3, instrument_count: -1 },
        });
    });

    test('bundles raw numeric Metric values into dashboard_measurements', () => {
        const result = bundleDashboardData({
            count: { value: 42, propertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(JSON.parse(result.measurements ?? ''), { v: { count: 42 } });
        assert.strictEqual(result.properties, undefined);
    });

    test('Metric value that cannot be coerced to a number falls through to dashboard_properties', () => {
        const result = bundleDashboardData({
            invalid: { value: 'not-a-number', propertyType: PropertyType.Metric },
        });
        assert.strictEqual(result.measurements, undefined);
        assert.deepStrictEqual(JSON.parse(result.properties ?? ''), { v: { invalid: 'not-a-number' } });
    });

    test('non-Metric numeric values are NOT promoted to measurements', () => {
        // Pre-fix behavior promoted any number to a measurement, which mis-bucketed
        // basic numeric dimensions; this test pins the contract.
        const result = bundleDashboardData({
            answer: { value: 42, propertyType: PropertyType.Basic },
        });
        assert.strictEqual(result.measurements, undefined);
        assert.deepStrictEqual(JSON.parse(result.properties ?? ''), { v: { answer: '42' } });
    });

    test('Pii-tagged properties are dropped end-to-end', () => {
        // Verifies the privacy guarantee: even though the dashboard wraps
        // values in AspireTelemetryProperty(Pii=0), nothing PII-tagged makes
        // it into either bundle.
        const result = bundleDashboardData({
            email: { value: 'user@example.com', propertyType: PropertyType.Pii },
            count: { value: 1, propertyType: PropertyType.Metric },
        });
        const props = result.properties ? JSON.parse(result.properties) : { v: {} };
        const measurements = result.measurements ? JSON.parse(result.measurements) : { v: {} };
        assert.strictEqual(props.v.email, undefined);
        assert.deepStrictEqual(measurements, { v: { count: 1 } });
    });

    test('stringifies booleans and complex objects inside dashboard_properties', () => {
        const result = bundleDashboardData({
            enabled: { value: true, propertyType: PropertyType.Basic },
            disabled: { value: false, propertyType: PropertyType.Basic },
            settings: { value: { a: 1, b: 'two' }, propertyType: PropertyType.Basic },
        });
        const envelope = JSON.parse(result.properties ?? '');
        assert.strictEqual(envelope.v.enabled, 'true');
        assert.strictEqual(envelope.v.disabled, 'false');
        assert.strictEqual(envelope.v.settings, '{"a":1,"b":"two"}');
        assert.strictEqual(envelope.t, undefined);
    });

    test('skips null and undefined values', () => {
        const result = bundleDashboardData({
            a: { value: null, propertyType: PropertyType.Basic },
            b: { value: undefined, propertyType: PropertyType.Basic },
            c: { value: 'present', propertyType: PropertyType.Basic },
        });
        assert.deepStrictEqual(JSON.parse(result.properties ?? ''), { v: { c: 'present' } });
        assert.strictEqual(result.measurements, undefined);
    });

    test('PascalCase input (legacy assumption) is intentionally ignored', () => {
        // The dashboard's `PostAsJsonAsync` defaults to camelCase on the wire
        // (see DashboardTelemetryPassthrough.ts file header for the citation
        // chain). PascalCase payloads are not produced by the dashboard and
        // we explicitly do not coerce them — coercing would mask a regression
        // that broke the actual contract.
        const pascalInput = {
            ignored: { Value: 'no', PropertyType: PropertyType.Basic },
        } as unknown as Parameters<typeof bundleDashboardData>[0];
        const result = bundleDashboardData(pascalInput);
        assert.deepStrictEqual(result, {});
    });

    test('truncates by entry count and sets the t flag on the envelope', () => {
        const tooMany: { [key: string]: { value: string; propertyType: 1 } } = {};
        for (let i = 0; i < MAX_BUNDLE_ENTRIES + 5; i++) {
            tooMany[`k${i}`] = { value: `v${i}`, propertyType: PropertyType.Basic };
        }
        const result = bundleDashboardData(tooMany);
        const envelope = JSON.parse(result.properties ?? '');
        assert.strictEqual(envelope.t, true);
        // We keep the first MAX_BUNDLE_ENTRIES entries (insertion order).
        assert.strictEqual(Object.keys(envelope.v).length, MAX_BUNDLE_ENTRIES);
        assert.strictEqual(envelope.v.k0, 'v0');
        assert.strictEqual(envelope.v[`k${MAX_BUNDLE_ENTRIES - 1}`], `v${MAX_BUNDLE_ENTRIES - 1}`);
        assert.strictEqual(envelope.v[`k${MAX_BUNDLE_ENTRIES}`], undefined);
    });

    test('per-entry truncation caps a single huge value before it reaches the bundle', () => {
        // The per-entry cap (MAX_DIAGNOSTIC_STRING_LENGTH) is applied
        // uniformly to every string value before bundling — see the privacy
        // mitigation note on bundleDashboardData. So a single huge value
        // doesn't trigger bundle-level char-cap truncation; it gets capped
        // to ~1KB + the truncation marker and lands in the bundle normally.
        const huge = 'x'.repeat(MAX_BUNDLE_CHARS * 2);
        const result = bundleDashboardData({
            small: { value: 'ok', propertyType: PropertyType.Basic },
            big: { value: huge, propertyType: PropertyType.Basic },
        });
        const blob = result.properties ?? '';
        assert.ok(blob.length <= MAX_BUNDLE_CHARS, `expected blob ≤ ${MAX_BUNDLE_CHARS} chars, got ${blob.length}`);
        const envelope = JSON.parse(blob);
        // No bundle-level truncation: both entries are present and `t` is unset.
        assert.strictEqual(envelope.t, undefined);
        assert.strictEqual(envelope.v.small, 'ok');
        assert.ok(typeof envelope.v.big === 'string', 'big value should be present in bundle');
        // But the value was truncated per-entry — it has the per-entry
        // truncation marker appended.
        assert.ok((envelope.v.big as string).endsWith('...[truncated]'),
            `expected per-entry truncation marker on big value, got ${(envelope.v.big as string).slice(-30)}`);
    });

    test('bundle char-cap truncation kicks in when many capped entries cumulatively exceed the budget', () => {
        // After per-entry truncation each value is at most ~1KB. The bundle
        // cap is 8KB, so several large-ish entries together can still exceed
        // the bundle budget. Verify the bundle-level char-cap loop drops
        // trailing entries and sets the envelope `t` flag.
        const flood: { [key: string]: { value: string; propertyType: 1 } } = {};
        for (let i = 0; i < 12; i++) {
            flood[`k${i}`] = { value: 'x'.repeat(MAX_BUNDLE_CHARS * 2), propertyType: PropertyType.Basic };
        }
        const result = bundleDashboardData(flood);
        const blob = result.properties ?? '';
        assert.ok(blob.length <= MAX_BUNDLE_CHARS, `expected blob ≤ ${MAX_BUNDLE_CHARS} chars, got ${blob.length}`);
        const envelope = JSON.parse(blob);
        assert.strictEqual(envelope.t, true, 'expected envelope truncation flag');
        assert.ok(Object.keys(envelope.v).length < 12, `expected some entries dropped, got ${Object.keys(envelope.v).length}`);
        assert.ok(Object.keys(envelope.v).length > 0, 'expected at least one entry kept');
        // Truncation drops trailing entries first.
        assert.strictEqual(envelope.v.k0?.endsWith('...[truncated]'), true);
    });

    test('drops measurements past MAX_BUNDLE_ENTRIES independently from properties', () => {
        // Property and measurement caps are independent — a flood of metrics
        // must not consume the property budget and vice-versa.
        const flood: { [key: string]: { value: string; propertyType: 1 | 2 } } = {};
        for (let i = 0; i < MAX_BUNDLE_ENTRIES + 5; i++) {
            flood[`m${i}`] = { value: String(i), propertyType: PropertyType.Metric };
        }
        flood['kept_prop'] = { value: 'present', propertyType: PropertyType.Basic };
        const result = bundleDashboardData(flood);
        const measEnvelope = JSON.parse(result.measurements ?? '');
        assert.strictEqual(measEnvelope.t, true);
        const propEnvelope = JSON.parse(result.properties ?? '');
        assert.strictEqual(propEnvelope.v.kept_prop, 'present');
        assert.strictEqual(propEnvelope.t, undefined);
    });

    test('envelope isolates dashboard property literally named __truncated__ from the truncation flag', () => {
        // A real dashboard property literally named __truncated__ must not
        // be confused with our truncation marker. The envelope places all
        // dashboard data inside `v`, so a property called "__truncated__"
        // lives at envelope.v.__truncated__ and never at envelope.t.
        const result = bundleDashboardData({
            __truncated__: { value: 'looks-like-marker', propertyType: PropertyType.Basic },
            other: { value: 'ok', propertyType: PropertyType.Basic },
        });
        const envelope = JSON.parse(result.properties ?? '');
        assert.strictEqual(envelope.v.__truncated__, 'looks-like-marker');
        assert.strictEqual(envelope.v.other, 'ok');
        assert.strictEqual(envelope.t, undefined);
    });

    test('preserves observed key order for integer-like keys via tuple-array truncation', () => {
        // Object-iteration places integer-index-like string keys ahead of
        // other string keys, so if we built the truncated result by writing
        // back into a plain object the dashboard's key order would be
        // silently reshuffled. Using an entries array sidesteps that.
        const input: { [key: string]: { value: string; propertyType: 1 } } = {};
        for (let i = 0; i < MAX_BUNDLE_ENTRIES + 3; i++) {
            // Use numeric-looking string keys; ECMAScript orders these
            // ascending in object iteration.
            input[String(i)] = { value: `v${i}`, propertyType: PropertyType.Basic };
        }
        const result = bundleDashboardData(input);
        const envelope = JSON.parse(result.properties ?? '');
        assert.strictEqual(envelope.t, true);
        // First MAX_BUNDLE_ENTRIES integer keys kept; last three dropped.
        assert.strictEqual(envelope.v['0'], 'v0');
        assert.strictEqual(envelope.v[String(MAX_BUNDLE_ENTRIES - 1)], `v${MAX_BUNDLE_ENTRIES - 1}`);
        assert.strictEqual(envelope.v[String(MAX_BUNDLE_ENTRIES)], undefined);
    });

    test('truncates over-long keys so a buggy dashboard cannot smuggle PII through key names', () => {
        // Defense-in-depth: every dashboard-supplied identifier (event names,
        // property names, asset ids, AND bundle keys) is clamped to
        // MAX_DASHBOARD_KEY_LENGTH so an upstream regression that places a
        // path or user-controlled string into a key can't leak it into
        // telemetry at full length.
        const longKey = 'k' + 'a'.repeat(MAX_DASHBOARD_KEY_LENGTH + 200);
        const result = bundleDashboardData({
            [longKey]: { value: 'ok', propertyType: PropertyType.Basic },
        });
        const envelope = JSON.parse(result.properties ?? '');
        const keys = Object.keys(envelope.v);
        assert.strictEqual(keys.length, 1);
        assert.ok(keys[0].endsWith('...[truncated]'), `expected truncated key, got '${keys[0].slice(0, 50)}…'`);
        assert.strictEqual(keys[0].length, MAX_DASHBOARD_KEY_LENGTH + '...[truncated]'.length);
        assert.strictEqual(envelope.v[keys[0]], 'ok');
    });

    test('rejects non-object input shapes (defensive)', () => {
        // The C# request types declare a Dictionary<string, AspireTelemetryProperty>,
        // but a malformed payload could send an array or a primitive. Either
        // would iterate via Object.entries with numeric or per-character
        // keys; treating them as empty input avoids polluting the bundle.
        assert.deepStrictEqual(bundleDashboardData([] as unknown as undefined), {});
        assert.deepStrictEqual(bundleDashboardData('oops' as unknown as undefined), {});
        assert.deepStrictEqual(bundleDashboardData(42 as unknown as undefined), {});
    });
});

suite('DashboardTelemetryPassthrough.formatCorrelations', () => {
    test('returns undefined for empty or missing list', () => {
        assert.strictEqual(formatCorrelations(undefined), undefined);
        assert.strictEqual(formatCorrelations([]), undefined);
    });

    test('returns undefined when input is not an array (defensive: payload from untrusted source)', () => {
        // The dashboard's TelemetryEventCorrelation[] is the contract, but a
        // bug or malicious sender could produce a string, an object, etc.
        // Without the Array.isArray guard, the legacy `correlations.length`
        // check would pass for strings and crash on .map(...).
        assert.strictEqual(formatCorrelations('not-an-array'), undefined);
        assert.strictEqual(formatCorrelations({ length: 1 } as unknown), undefined);
        assert.strictEqual(formatCorrelations(null), undefined);
        assert.strictEqual(formatCorrelations(42), undefined);
    });

    test('skips malformed entries (missing or non-string id/eventType)', () => {
        // The helper accepts unknown[]-ish input and must drop anything that
        // doesn't match the wire shape rather than crashing or emitting
        // `undefined:undefined`.
        const result = formatCorrelations([
            { id: 'a', eventType: 'Operation' },
            null,
            { id: 'b' },                            // missing eventType
            { eventType: 'UserTask' },              // missing id
            { id: 1, eventType: 'Operation' },      // non-string id
            { id: 'c', eventType: 42 },             // non-string eventType
            'oops',                                  // primitive
            { id: 'd', eventType: 'UserTask' },
        ]);
        assert.strictEqual(result, 'Operation:a;UserTask:d');
    });

    test('joins eventType:id pairs with semicolons in input order', () => {
        // This is the wire format we emit for the `dashboard_correlated_with`
        // property. Changing it is a breaking change for any downstream
        // analytics that parses the field, so pin it here.
        const result = formatCorrelations([
            { id: 'a', eventType: 'Operation' },
            { id: 'b', eventType: 'UserTask' },
        ]);
        assert.strictEqual(result, 'Operation:a;UserTask:b');
    });

    test('caps the formatted list at MAX_CORRELATIONS to prevent unbounded growth', () => {
        // A malicious sender could otherwise pour 100k correlations into a
        // single event and bypass the per-bundle caps (correlations are not
        // bundled — they sit directly on the property value).
        const input = Array.from({ length: MAX_CORRELATIONS + 50 }, (_, i) => ({
            id: `id-${i}`,
            eventType: 'Operation' as const,
        }));
        const result = formatCorrelations(input);
        const pairs = (result ?? '').split(';');
        assert.strictEqual(pairs.length, MAX_CORRELATIONS);
        assert.strictEqual(pairs[0], 'Operation:id-0');
        assert.strictEqual(pairs[MAX_CORRELATIONS - 1], `Operation:id-${MAX_CORRELATIONS - 1}`);
    });

    test('strips wire-format delimiters from element values', () => {
        // If the dashboard ever sent an id containing ';' or ':', the parser
        // on the receiving side would mis-split. Strip them so the format
        // stays unambiguous.
        const result = formatCorrelations([
            { id: 'a:b;c', eventType: 'Op:eration;X' as unknown as 'Operation' },
        ]);
        assert.strictEqual(result, 'Op_eration_X:a_b_c');
    });
});

suite('DashboardTelemetryPassthrough.clampDashboardKey', () => {
    test('returns short strings unchanged', () => {
        assert.strictEqual(clampDashboardKey('short.key'), 'short.key');
        assert.strictEqual(clampDashboardKey(''), '');
    });

    test('truncates over-long strings and appends marker', () => {
        const long = 'a'.repeat(MAX_DASHBOARD_KEY_LENGTH + 100);
        const result = clampDashboardKey(long);
        assert.ok(result.endsWith('...[truncated]'), 'expected truncation marker');
        assert.strictEqual(result.length, MAX_DASHBOARD_KEY_LENGTH + '...[truncated]'.length);
    });

    test('returns empty string for non-string input (defensive)', () => {
        assert.strictEqual(clampDashboardKey(42 as unknown as string), '');
        assert.strictEqual(clampDashboardKey(null as unknown as string), '');
    });
});

suite('DashboardTelemetryPassthrough.formatFlagPrefixes', () => {
    test('returns empty string for non-array input', () => {
        // The C# request record types this as string[], but a malformed JSON
        // payload could send anything. Don't crash.
        assert.strictEqual(formatFlagPrefixes(undefined), '');
        assert.strictEqual(formatFlagPrefixes('not-an-array'), '');
        assert.strictEqual(formatFlagPrefixes(null), '');
        assert.strictEqual(formatFlagPrefixes({ length: 1 }), '');
    });

    test('joins string entries with commas', () => {
        assert.strictEqual(formatFlagPrefixes(['--foo', '--bar']), '--foo,--bar');
    });

    test('skips non-string entries', () => {
        assert.strictEqual(formatFlagPrefixes(['--foo', 42, null, '--bar']), '--foo,--bar');
    });

    test('caps the count at MAX_FLAG_PREFIXES', () => {
        const input = Array.from({ length: MAX_FLAG_PREFIXES + 25 }, (_, i) => `--flag${i}`);
        const result = formatFlagPrefixes(input);
        const items = result.split(',');
        assert.strictEqual(items.length, MAX_FLAG_PREFIXES);
        assert.strictEqual(items[0], '--flag0');
    });

    test('strips embedded commas from individual entries (anti-smuggling)', () => {
        // A single entry containing commas would otherwise let an attacker
        // synthesize extra apparent prefixes on the receiving side.
        assert.strictEqual(formatFlagPrefixes(['--a,--b', '--c']), '--a_--b,--c');
    });

    test('truncates over-long entries via clampDashboardKey', () => {
        const long = '--' + 'x'.repeat(MAX_DASHBOARD_KEY_LENGTH + 50);
        const result = formatFlagPrefixes([long]);
        assert.ok(result.endsWith('...[truncated]'));
    });
});

suite('DashboardTelemetryPassthrough enum label mappers', () => {
    test('telemetryResultLabel maps numeric wire values to readable labels', () => {
        // Mirrors `TelemetryResult` in VisualStudioTelemetryTypes.cs. The enum
        // has no [JsonStringEnumConverter], so the dashboard sends numbers.
        assert.strictEqual(telemetryResultLabel(0), 'None');
        assert.strictEqual(telemetryResultLabel(1), 'Success');
        assert.strictEqual(telemetryResultLabel(2), 'Failure');
        assert.strictEqual(telemetryResultLabel(3), 'UserFault');
        assert.strictEqual(telemetryResultLabel(4), 'UserCancel');
    });

    test('telemetryResultLabel returns Unknown sentinel for missing or out-of-range values', () => {
        assert.strictEqual(telemetryResultLabel(undefined), 'Unknown');
        assert.strictEqual(telemetryResultLabel(99 as 0), 'Unknown(99)');
    });

    test('isFailureResult routes Failure and UserFault to the error channel', () => {
        // Anchors the routing contract for sendTelemetryErrorEvent vs sendTelemetryEvent.
        // UserCancel is routine UX and should stay in the standard channel.
        assert.strictEqual(isFailureResult(0), false); // None
        assert.strictEqual(isFailureResult(1), false); // Success
        assert.strictEqual(isFailureResult(2), true);  // Failure
        assert.strictEqual(isFailureResult(3), true);  // UserFault
        assert.strictEqual(isFailureResult(4), false); // UserCancel
        assert.strictEqual(isFailureResult(undefined), false);
    });

    test('faultSeverityLabel maps numeric wire values to readable labels', () => {
        assert.strictEqual(faultSeverityLabel(0), 'Uncategorized');
        assert.strictEqual(faultSeverityLabel(1), 'Diagnostic');
        assert.strictEqual(faultSeverityLabel(2), 'General');
        assert.strictEqual(faultSeverityLabel(3), 'Critical');
        assert.strictEqual(faultSeverityLabel(4), 'Crash');
    });
});

suite('DashboardTelemetryPassthrough.scrubFreeformDiagnosticText', () => {
    test('returns empty string for undefined input', () => {
        assert.strictEqual(scrubFreeformDiagnosticText(undefined), '');
    });

    test('passes through text below the limit unchanged', () => {
        const text = 'A short error message.';
        assert.strictEqual(scrubFreeformDiagnosticText(text), text);
    });

    test('truncates long text and appends a marker so receivers can detect it', () => {
        const longText = 'x'.repeat(MAX_DIAGNOSTIC_STRING_LENGTH + 500);
        const scrubbed = scrubFreeformDiagnosticText(longText);
        assert.ok(scrubbed.endsWith('...[truncated]'), `expected truncation marker, got ${scrubbed.slice(-30)}`);
        assert.strictEqual(scrubbed.length, MAX_DIAGNOSTIC_STRING_LENGTH + '...[truncated]'.length);
    });
});
