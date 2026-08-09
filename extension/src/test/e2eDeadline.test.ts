import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { runWithE2eDeadline } from '../testing/e2eDeadline';

suite('E2E deadline helper', () => {
    test('rejects an external await that outlives the remaining deadline', async () => {
        await assert.rejects(
            runWithE2eDeadline('hung debugger request', Date.now() + 25, new Promise(() => undefined)),
            /Timed out after \d+ms waiting for hung debugger request\./);
    });

    test('returns an external await that completes before the deadline', async () => {
        assert.strictEqual(await runWithE2eDeadline('completed debugger request', Date.now() + 1000, Promise.resolve('done')), 'done');
    });

    test('does not start a lazy external await after the deadline has already passed', async () => {
        let started = false;

        await assert.rejects(
            runWithE2eDeadline('expired debugger request', Date.now() - 1, () => {
                started = true;
                return Promise.resolve('late');
            }),
            /the E2E deadline has already passed/);

        assert.strictEqual(started, false);
    });

    test('bounds the resource-debugger cleanup stop request by the proof deadline', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const bridge = fs.readFileSync(path.join(extensionRoot, 'src', 'testing', 'e2eStateFileBridge.ts'), 'utf8');

        assert.ok(bridge.includes('let proofFailure: unknown;'), 'Cleanup failures must not mask the startup or breakpoint failure that triggered cleanup.');
        assert.ok(bridge.includes("'resource breakpoint pause'"), 'Breakpoint pauses must share the resource-debugger proof deadline.');
        assert.ok(bridge.includes("runWithE2eDeadline(\n          'stop resource debugging request'"), 'The cleanup stopDebugging request must not outlive the resource-debugger proof deadline.');
        assert.ok(bridge.includes('() => vscode.debug.stopDebugging()'), 'The cleanup stopDebugging request must not start after the deadline has already passed.');
    });
});
