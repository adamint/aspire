import * as assert from 'assert';
import { countDebugConsoleOccurrences, type DebugConsoleOutput } from '../test-e2e/helpers/assertions';

suite('AppHost logs E2E guards', () => {
    test('counts log probe markers as exact tokens rather than substrings', () => {
        const outputs: DebugConsoleOutput[] = [
            {
                sequence: 1,
                debugSessionId: 'debug-session',
                appHostPath: 'AppHost.csproj',
                category: 'stdout',
                output: 'AspireE2E.LogProbe: Warning: E2ELOGPROBEWARN first line.\nE2ELOGPROBEWARNSECOND second line.',
            },
        ];

        assert.strictEqual(countDebugConsoleOccurrences(outputs, 'E2ELOGPROBEWARN'), 1);
        assert.strictEqual(countDebugConsoleOccurrences(outputs, 'E2ELOGPROBEWARNSECOND'), 1);
    });
});
