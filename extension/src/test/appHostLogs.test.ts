/// <reference types="mocha" />

import * as assert from 'assert';
import { countDebugConsoleOccurrences, type DebugConsoleOutput } from '../test-e2e/helpers/assertions';
import { appHostLogProbeMarkers, countedAppHostLogProbeMarkers } from '../test-e2e/helpers/appHostLogProbeMarkers';

interface PrefixCollision {
    prefix: string;
    marker: string;
}

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

    test('counted probe markers are mutually non-prefix', () => {
        const collisions = getPrefixCollisions(countedAppHostLogProbeMarkers);

        assert.strictEqual(
            collisions.length,
            0,
            `Counted AppHost log probe markers must be mutually non-prefix because countDebugConsoleOccurrences uses substring splitting. Colliding marker pairs: ${formatPrefixCollisions(collisions)}`);
    });
});

function getPrefixCollisions(markers: readonly string[]): PrefixCollision[] {
    const collisions: PrefixCollision[] = [];

    for (const prefix of markers) {
        for (const marker of markers) {
            if (prefix !== marker && marker.startsWith(prefix)) {
                collisions.push({ prefix, marker });
            }
        }
    }

    return collisions;
}

function formatPrefixCollisions(collisions: readonly PrefixCollision[]): string {
    return collisions.map(collision => `${collision.prefix} -> ${collision.marker}`).join(', ');
}
