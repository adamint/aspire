import * as assert from 'assert';
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
});
