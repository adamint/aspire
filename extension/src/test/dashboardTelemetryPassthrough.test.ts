import * as assert from 'assert';
import { __testOnly__ } from '../dcp/DashboardTelemetryPassthrough';

const { flattenProperties, telemetryResultLabel, faultSeverityLabel, isFailureResult, scrubFreeformDiagnosticText, MAX_DIAGNOSTIC_STRING_LENGTH } = __testOnly__;

const PropertyType = {
    Pii: 0 as const,
    Basic: 1 as const,
    Metric: 2 as const,
    UserSetting: 3 as const,
};

suite('DashboardTelemetryPassthrough.flattenProperties', () => {
    test('returns empty maps for undefined input', () => {
        const result = flattenProperties(undefined);
        assert.deepStrictEqual(result.properties, {});
        assert.deepStrictEqual(result.measurements, {});
    });

    test('parses invariant-culture string Metric values into measurements', () => {
        // Dashboard emits metric values via int.ToString(CultureInfo.InvariantCulture);
        // see src/Aspire.Dashboard/Components/Pages/Metrics.razor.cs:359 and
        // StructuredLogs.razor.cs:622. The contract is "tag is Metric, payload is a
        // string" — flattenProperties must route them to measurements.
        const result = flattenProperties({
            filter_count: { value: '3', propertyType: PropertyType.Metric },
            instrument_count: { value: '-1', propertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(result.measurements, { filter_count: 3, instrument_count: -1 });
        assert.deepStrictEqual(result.properties, {});
    });

    test('routes raw numeric Metric values into measurements', () => {
        const result = flattenProperties({
            count: { value: 42, propertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(result.measurements, { count: 42 });
        assert.deepStrictEqual(result.properties, {});
    });

    test('Metric value that cannot be coerced to a number falls through to properties', () => {
        const result = flattenProperties({
            invalid: { value: 'not-a-number', propertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(result.measurements, {});
        assert.deepStrictEqual(result.properties, { invalid: 'not-a-number' });
    });

    test('non-Metric numeric values are NOT promoted to measurements', () => {
        // Pre-fix behavior promoted any number to a measurement, which mis-bucketed
        // basic numeric dimensions; this test pins the new contract.
        const result = flattenProperties({
            answer: { value: 42, propertyType: PropertyType.Basic },
        });
        assert.deepStrictEqual(result.measurements, {});
        assert.deepStrictEqual(result.properties, { answer: '42' });
    });

    test('Pii-tagged properties are dropped', () => {
        const result = flattenProperties({
            email: { value: 'user@example.com', propertyType: PropertyType.Pii },
            count: { value: 1, propertyType: PropertyType.Metric },
        });
        assert.strictEqual(result.properties.email, undefined);
        assert.deepStrictEqual(result.measurements, { count: 1 });
    });

    test('stringifies booleans and complex objects', () => {
        const result = flattenProperties({
            enabled: { value: true, propertyType: PropertyType.Basic },
            disabled: { value: false, propertyType: PropertyType.Basic },
            settings: { value: { a: 1, b: 'two' }, propertyType: PropertyType.Basic },
        });
        assert.strictEqual(result.properties.enabled, 'true');
        assert.strictEqual(result.properties.disabled, 'false');
        assert.strictEqual(result.properties.settings, '{"a":1,"b":"two"}');
    });

    test('skips null and undefined values', () => {
        const result = flattenProperties({
            a: { value: null, propertyType: PropertyType.Basic },
            b: { value: undefined, propertyType: PropertyType.Basic },
            c: { value: 'present', propertyType: PropertyType.Basic },
        });
        assert.deepStrictEqual(result.properties, { c: 'present' });
        assert.deepStrictEqual(result.measurements, {});
    });

    test('PascalCase input (legacy assumption) is intentionally ignored', () => {
        // Dashboard's PostAsJsonAsync uses JsonSerializerOptions.Web defaults
        // since .NET 9, so the wire format is camelCase. PascalCase payloads
        // are not produced by the dashboard and we explicitly do not coerce
        // them, to avoid masking a regression that breaks the actual contract.
        const pascalInput = {
            ignored: { Value: 'no', PropertyType: PropertyType.Basic },
        } as unknown as Parameters<typeof flattenProperties>[0];
        const result = flattenProperties(pascalInput);
        assert.deepStrictEqual(result.properties, {});
        assert.deepStrictEqual(result.measurements, {});
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
