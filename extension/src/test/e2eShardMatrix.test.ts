import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('E2E shard matrix', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const workflowPath = path.join(extensionRoot, '..', '.github', 'workflows', 'extension-e2e-tests.yml');

    function readWorkflow(): string {
        return fs.readFileSync(workflowPath, 'utf8');
    }

    function getMatrixSpecs(workflow: string): string[] {
        // Matrix rows look like:
        //   - name: Linux
        //     shardName: resource-debugger
        //     spec: out/test-e2e/test-e2e/resourceDebugger.e2e.test.js
        return [...workflow.matchAll(/^\s*spec:\s*(\S+)\s*$/gm)].map(match => match[1]);
    }

    test('runs every E2E spec in the CI matrix', () => {
        const workflow = readWorkflow();
        const matrixSpecs = new Set(getMatrixSpecs(workflow));
        const specFiles = fs.readdirSync(path.join(extensionRoot, 'src', 'test-e2e'))
            .filter(file => file.endsWith('.e2e.test.ts'))
            .map(file => `out/test-e2e/test-e2e/${file.replace(/\.ts$/, '.js')}`)
            .sort();

        assert.ok(specFiles.length > 0, 'Expected E2E spec files under src/test-e2e.');
        assert.deepStrictEqual(
            specFiles.filter(spec => !matrixSpecs.has(spec)),
            [],
            'Every E2E spec must have a matrix entry, otherwise it silently never runs in CI.');
    });

    test('covers the resource debugger shard on Linux and Windows', () => {
        const workflow = readWorkflow();
        const shardRows = [...workflow.matchAll(/-\s*name:\s*(Linux|Windows)\s*\n\s*shardName:\s*(\S+)\s*\n\s*spec:\s*(\S+)/g)]
            .filter(match => match[2] === 'resource-debugger')
            .map(match => ({ platform: match[1], spec: match[3] }));

        assert.deepStrictEqual(shardRows, [
            { platform: 'Linux', spec: 'out/test-e2e/test-e2e/resourceDebugger.e2e.test.js' },
            { platform: 'Windows', spec: 'out/test-e2e/test-e2e/resourceDebugger.e2e.test.js' },
        ]);
    });

    test('fails a shard that reports success without executing its tests', () => {
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');

        assert.ok(runner.includes("const { assertShardExecutedTests } = require('./e2e-shard-results');"));
        assert.ok(runner.includes('assertShardExecutedTests({ shardName, results: readMochaResults() });'));
        assert.ok(runner.indexOf("run-tests'") < runner.indexOf('assertShardExecutedTests({ shardName'));
    });

    test('builds the Node resource fixture only for the resource debugger shard', () => {
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');

        assert.ok(runner.includes("const includeNodeResourceFixture = shardName === 'resource-debugger';"));
        assert.ok(runner.includes('writeNodeAppFixture(nodeAppProjectName);'));
        assert.ok(runner.includes('builder.AddNodeApp("e2e-node", "../${nodeAppProjectName}", "app.js");'));
        assert.ok(runner.includes('ASPIRE_EXTENSION_E2E_NODE_APP_SCRIPT: includeNodeResourceFixture ? nodeAppScript : undefined,'));
        assert.ok(runner.includes("copyIfExists(path.join(sourceDirectory, 'app.js'), path.join(destinationDirectory, 'app.js'));"));
    });
});
