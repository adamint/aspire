/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { countDebugConsoleOccurrences, type DebugConsoleOutput } from '../test-e2e/helpers/assertions';

suite('AppHost debug console log E2E helpers', () => {
    test('probe marker counts stay independent when continuation line shares the warning record', () => {
        const sourcePath = path.resolve(__dirname, '..', '..', 'src', 'test-e2e', 'appHostLogs.e2e.test.ts');
        const source = fs.readFileSync(sourcePath, 'utf8');
        const warningMarker = getStringConst(source, 'warningMarker');
        const warningContinuationMarker = getStringConst(source, 'warningContinuationMarker');
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
});

function getStringConst(source: string, name: string): string {
    // Parse marker declarations in the E2E source, for example:
    //   const warningMarker = 'E2ELOGPROBEWARN';
    // These probe marker literals are intentionally simple because the AppHost source
    // instrumentation interpolates them into C# string literals.
    const match = new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)';`).exec(source);
    assert.ok(match, `Expected to find ${name} in appHostLogs.e2e.test.ts.`);

    return match[1];
}
