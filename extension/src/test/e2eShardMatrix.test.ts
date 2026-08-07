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

    /**
     * Compiled spec paths the matrix is allowed to reference, derived from the spec files on disk.
     * This is the canonical set: a matrix value is correct only if it is in here, and a spec is run
     * only if the matrix references it.
     */
    function canonicalSpecPaths(): string[] {
        return fs.readdirSync(specDirectory)
            .filter(file => file.endsWith('.e2e.test.ts'))
            .map(file => `out/test-e2e/test-e2e/${file.replace(/\.ts$/, '.js')}`)
            .sort();
    }

    /**
     * Matrix rows carry the compiled spec path:
     *       - name: Linux
     *         shardName: edge-cases
     *         spec: out/test-e2e/test-e2e/edgeCases.e2e.test.js
     * A spec legitimately appears on more than one row (one per platform), so the values are
     * deduplicated before being compared with the canonical set.
     */
    function matrixSpecPaths(): string[] {
        const workflow = fs.readFileSync(workflowPath, 'utf8');

        return [...new Set([...workflow.matchAll(/^\s*spec:\s*(\S+)\s*$/gm)].map(match => match[1]))].sort();
    }

    test('runs exactly the set of E2E specs in the CI matrix', () => {
        const specFiles = canonicalSpecPaths();
        const matrixSpecs = matrixSpecPaths();

        assert.ok(specFiles.length > 0, `Expected E2E spec files under ${specDirectory}.`);
        assert.ok(matrixSpecs.length > 0, 'Expected spec entries in the E2E workflow matrix.');
        // Deliberately full set equality rather than a containment check in either direction. A
        // missing entry means a spec silently never runs; an extra entry that is not a spec (a
        // helper module, or a spec that was renamed or deleted) means the runner's glob matches
        // nothing and the shard reports success while running zero tests. Both are invisible in a
        // green workflow, so the matrix has to equal the spec set exactly.
        assert.deepStrictEqual(
            matrixSpecs,
            specFiles,
            'The spec values in extension-e2e-tests.yml must be exactly the compiled paths of the .e2e.test.ts files under src/test-e2e.');
    });
});
