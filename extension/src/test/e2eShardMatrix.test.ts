import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('E2E shard matrix', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const workflowPath = path.join(extensionRoot, '..', '.github', 'workflows', 'extension-e2e-tests.yml');

    test('covers the resource debugger shard on Linux and Windows', () => {
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        // Matrix rows carry the platform, the shard name and the compiled spec path:
        //       - name: Linux
        //         shardName: resource-debugger
        //         spec: out/test-e2e/test-e2e/resourceDebugger.e2e.test.js
        const shardRows = [...workflow.matchAll(/-\s*name:\s*(Linux|Windows)\s*\n\s*shardName:\s*(\S+)\s*\n\s*spec:\s*(\S+)/g)]
            .filter(match => match[2] === 'resource-debugger')
            .map(match => ({ platform: match[1], spec: match[3] }));

        // Resource debugging launches a second adapter underneath the AppHost session, and process
        // tree teardown differs between the platforms, so a single-platform row would leave the
        // half of the behaviour this shard exists to prove unexercised.
        assert.deepStrictEqual(shardRows, [
            { platform: 'Linux', spec: 'out/test-e2e/test-e2e/resourceDebugger.e2e.test.js' },
            { platform: 'Windows', spec: 'out/test-e2e/test-e2e/resourceDebugger.e2e.test.js' },
        ]);
    });
});
