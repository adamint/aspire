import * as assert from 'assert';
import { __testOnly__ } from '../dcp/DashboardTelemetryPassthrough';

const { flattenProperties } = __testOnly__;

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
            filter_count: { Value: '3', PropertyType: PropertyType.Metric },
            instrument_count: { Value: '-1', PropertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(result.measurements, { filter_count: 3, instrument_count: -1 });
        assert.deepStrictEqual(result.properties, {});
    });

    test('routes raw numeric Metric values into measurements', () => {
        const result = flattenProperties({
            count: { Value: 42, PropertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(result.measurements, { count: 42 });
        assert.deepStrictEqual(result.properties, {});
    });

    test('Metric value that cannot be coerced to a number falls through to properties', () => {
        const result = flattenProperties({
            invalid: { Value: 'not-a-number', PropertyType: PropertyType.Metric },
        });
        assert.deepStrictEqual(result.measurements, {});
        assert.deepStrictEqual(result.properties, { invalid: 'not-a-number' });
    });

    test('non-Metric numeric values are NOT promoted to measurements', () => {
        // Pre-fix behavior promoted any number to a measurement, which mis-bucketed
        // basic numeric dimensions; this test pins the new contract.
        const result = flattenProperties({
            answer: { Value: 42, PropertyType: PropertyType.Basic },
        });
        assert.deepStrictEqual(result.measurements, {});
        assert.deepStrictEqual(result.properties, { answer: '42' });
    });

    test('Pii-tagged properties are dropped', () => {
        const result = flattenProperties({
            email: { Value: 'user@example.com', PropertyType: PropertyType.Pii },
            count: { Value: 1, PropertyType: PropertyType.Metric },
        });
        assert.strictEqual(result.properties.email, undefined);
        assert.deepStrictEqual(result.measurements, { count: 1 });
    });

    test('stringifies booleans and complex objects', () => {
        const result = flattenProperties({
            enabled: { Value: true, PropertyType: PropertyType.Basic },
            disabled: { Value: false, PropertyType: PropertyType.Basic },
            settings: { Value: { a: 1, b: 'two' }, PropertyType: PropertyType.Basic },
        });
        assert.strictEqual(result.properties.enabled, 'true');
        assert.strictEqual(result.properties.disabled, 'false');
        assert.strictEqual(result.properties.settings, '{"a":1,"b":"two"}');
    });

    test('skips null and undefined values', () => {
        const result = flattenProperties({
            a: { Value: null, PropertyType: PropertyType.Basic },
            b: { Value: undefined, PropertyType: PropertyType.Basic },
            c: { Value: 'present', PropertyType: PropertyType.Basic },
        });
        assert.deepStrictEqual(result.properties, { c: 'present' });
        assert.deepStrictEqual(result.measurements, {});
    });
});
