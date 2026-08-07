import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The E2E suite is sharded one spec per matrix row in `extension-e2e-tests.yml`, and the runner is
 * pointed at a single compiled spec through `ASPIRE_EXTENSION_E2E_SPEC`. Nothing enumerates the spec
 * directory at runtime, so a spec that never gets a matrix row is not a failure - it simply never
 * runs, and the workflow stays green while the coverage it was written for is gone.
 *
 * This runs as a unit test rather than as part of the E2E suite on purpose: the failure it detects
 * is "an E2E spec did not run", which the E2E suite by definition cannot report on itself.
 */
suite('E2E shard matrix', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const workflowPath = path.join(extensionRoot, '..', '.github', 'workflows', 'extension-e2e-tests.yml');
    const specDirectory = path.join(extensionRoot, 'src', 'test-e2e');

    test('runs every E2E spec in the CI matrix', () => {
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        // Matrix rows carry the compiled spec path:
        //       - name: Linux
        //         shardName: edge-cases
        //         spec: out/test-e2e/test-e2e/edgeCases.e2e.test.js
        // A spec can legitimately appear on more than one row (one per platform), hence the set.
        const matrixSpecs = new Set([...workflow.matchAll(/^\s*spec:\s*(\S+)\s*$/gm)].map(match => match[1]));
        const specFiles = fs.readdirSync(specDirectory)
            .filter(file => file.endsWith('.e2e.test.ts'))
            .map(file => `out/test-e2e/test-e2e/${file.replace(/\.ts$/, '.js')}`)
            .sort();

        assert.ok(specFiles.length > 0, `Expected E2E spec files under ${specDirectory}.`);
        assert.deepStrictEqual(
            specFiles.filter(spec => !matrixSpecs.has(spec)),
            [],
            'Every E2E spec must have a matrix entry in extension-e2e-tests.yml, otherwise it silently never runs in CI.');
    });

    test('points every CI matrix row at a spec that exists', () => {
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        const matrixSpecs = [...new Set([...workflow.matchAll(/^\s*spec:\s*(\S+)\s*$/gm)].map(match => match[1]))].sort();

        assert.ok(matrixSpecs.length > 0, 'Expected spec entries in the E2E workflow matrix.');
        // The runner resolves the spec with a glob, and a glob that matches nothing yields a shard
        // that runs zero tests, so a renamed or deleted spec has to be caught here as well.
        assert.deepStrictEqual(
            matrixSpecs.filter(spec => !fs.existsSync(path.join(extensionRoot, spec.replace('out/test-e2e/test-e2e/', 'src/test-e2e/').replace(/\.js$/, '.ts')))),
            [],
            'Every matrix entry must point at a spec under src/test-e2e, otherwise the shard runs nothing.');
    });
});
