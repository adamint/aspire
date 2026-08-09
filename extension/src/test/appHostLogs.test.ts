/// <reference types="mocha" />

import * as assert from 'assert';
import { countDebugConsoleOccurrences, type DebugConsoleOutput } from '../test-e2e/helpers/assertions';
import { appHostLogProbeMarkers, countedAppHostLogProbeMarkers } from '../test-e2e/helpers/appHostLogProbeMarkers';

type MarkerCollision =
    | { kind: 'duplicate'; marker: string }
    | { kind: 'strict-prefix'; prefix: string; marker: string };

suite('AppHost debug console log E2E helpers', () => {
    test('probe marker counts stay independent when continuation line shares the warning record', () => {
        const warningMarker = appHostLogProbeMarkers.warning;
        const warningContinuationMarker = appHostLogProbeMarkers.warningContinuation;
        const outputs: readonly DebugConsoleOutput[] = [{
            sequence: 1,
            debugSessionId: 'debug-session',
            appHostPath: '/workspace/AppHost/AppHost.csproj',
            category: 'stdout',
            output: `${warningMarker} first line.\n${warningContinuationMarker} second line.`,
        }];

        assert.strictEqual(countDebugConsoleOccurrences(outputs, warningMarker), 1);
        assert.strictEqual(countDebugConsoleOccurrences(outputs, warningContinuationMarker), 1);
    });

    test('counted probe markers have zero duplicate or prefix collisions', () => {
        const collisions = getPrefixCollisions(countedAppHostLogProbeMarkers);

        assert.strictEqual(
            collisions.length,
            0,
            `Counted AppHost log probe markers must be unique and mutually non-prefix because countDebugConsoleOccurrences uses substring splitting. Duplicate or strict-prefix marker pairs: ${formatPrefixCollisions(collisions)}`);
    });

    test('duplicate marker collisions are formatted distinctly from strict prefixes', () => {
        const collisions = getPrefixCollisions(['DUPLICATE', 'DUPLICATE']);

        assert.strictEqual(formatPrefixCollisions(collisions), "duplicate marker 'DUPLICATE' == 'DUPLICATE'");
    });
});

function getPrefixCollisions(markers: readonly string[]): MarkerCollision[] {
    const collisions: MarkerCollision[] = [];

    for (let i = 0; i < markers.length; i++) {
        for (let j = i + 1; j < markers.length; j++) {
            const left = markers[i];
            const right = markers[j];

            if (left === right) {
                collisions.push({ kind: 'duplicate', marker: left });
            }
            else if (right.startsWith(left)) {
                collisions.push({ kind: 'strict-prefix', prefix: left, marker: right });
            }
            else if (left.startsWith(right)) {
                collisions.push({ kind: 'strict-prefix', prefix: right, marker: left });
            }
        }
    }

    return collisions;
}

function formatPrefixCollisions(collisions: readonly MarkerCollision[]): string {
    return collisions.map(collision => collision.kind === 'duplicate'
        ? `duplicate marker '${collision.marker}' == '${collision.marker}'`
        : `strict prefix '${collision.prefix}' -> '${collision.marker}'`).join(', ');
}
