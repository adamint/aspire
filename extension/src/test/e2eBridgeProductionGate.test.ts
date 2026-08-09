import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

type WebpackConfigFactory = ((env: unknown, argv: { mode?: string }) => Array<{ plugins: unknown[] }>) & {
    e2eBridgeRequestPattern: RegExp;
    e2eBridgeProductionStub: string;
};

const extensionRoot = path.resolve(__dirname, '..', '..');
const e2eBridgeBuildEnvironmentVariable = 'ASPIRE_EXTENSION_E2E_INCLUDE_BRIDGE';
const loadWebpackConfig = (): WebpackConfigFactory => require(path.join(extensionRoot, 'webpack.config.js')) as WebpackConfigFactory;

/**
 * `e2eStateFileBridge.ts` is a test control channel that registers a wildcard debug adapter tracker
 * and executes commands read from a file path in an environment variable. `extension.ts` imports it
 * unconditionally, so it has to be removed at build time rather than gated at runtime, or it ships
 * inside the published extension.
 */
suite('E2E bridge production gate', () => {
    test('replaces the E2E bridge in production builds', () => {
        const configure = loadWebpackConfig();

        withE2eBridgeBuildEnvironment(undefined, () => {
            const [productionConfig] = configure({}, { mode: 'production' });

            assert.strictEqual(productionConfig.plugins.length, 1);
            assert.strictEqual((productionConfig.plugins[0] as object).constructor.name, 'NormalModuleReplacementPlugin');
        });
    });

    test('keeps the E2E bridge in development builds', () => {
        const configure = loadWebpackConfig();

        // `yarn compile` passes no mode, so local extension development keeps driving the real
        // bridge.
        assert.deepStrictEqual(configure({}, {}).map(config => config.plugins), [[]]);
        assert.deepStrictEqual(configure({}, { mode: 'none' }).map(config => config.plugins), [[]]);
    });

    test('keeps the E2E bridge in production builds only when the E2E package opts in', () => {
        const configure = loadWebpackConfig();

        withE2eBridgeBuildEnvironment('true', () => {
            assert.deepStrictEqual(configure({}, { mode: 'production' }).map(config => config.plugins), [[]]);
        });
    });

    test('packages the CI and local E2E VSIX with the bridge included', () => {
        const testsWorkflow = fs.readFileSync(path.join(extensionRoot, '..', '.github', 'workflows', 'tests.yml'), 'utf8');
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');
        const packageVsixStep = getWorkflowStep(testsWorkflow, 'Package VSIX');

        assert.ok(packageVsixStep.includes(`${e2eBridgeBuildEnvironmentVariable}: true`));
        assert.ok(runner.includes(`${e2eBridgeBuildEnvironmentVariable}: 'true'`));
    });

    test('does not accumulate plugins across repeated configuration calls', () => {
        const configure = loadWebpackConfig();

        configure({}, { mode: 'production' });

        assert.strictEqual(configure({}, { mode: 'production' })[0].plugins.length, 1);
    });

    test('matches the bridge import that extension.ts issues', () => {
        const configure = loadWebpackConfig();
        const extensionSource = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
        const bridgeImport = /from '(\.[^']*e2eStateFileBridge)'/.exec(extensionSource);

        assert.ok(bridgeImport, 'Expected extension.ts to import the E2E state file bridge.');
        assert.ok(
            configure.e2eBridgeRequestPattern.test(bridgeImport[1]),
            `The webpack replacement pattern must match the request extension.ts issues (${bridgeImport[1]}).`);
    });

    test('substitutes a stub that exports everything extension.ts imports from the bridge', () => {
        const configure = loadWebpackConfig();
        const stubSource = fs.readFileSync(configure.e2eBridgeProductionStub, 'utf8');
        const extensionSource = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
        const importedNames = /import\s*{([^}]*)}\s*from\s*'\.[^']*e2eStateFileBridge'/.exec(extensionSource)?.[1]
            .split(',')
            .map(name => name.trim())
            .filter(Boolean) ?? [];

        assert.ok(importedNames.length > 0, 'Expected extension.ts to import named bindings from the bridge.');
        assert.deepStrictEqual(
            importedNames.filter(name => !new RegExp(`export function ${name}\\b`).test(stubSource)),
            [],
            'The production stub must export every binding extension.ts imports, or the production build breaks.');
    });
});

function getWorkflowStep(workflow: string, stepName: string): string {
    const stepStart = workflow.indexOf(`      - name: ${stepName}`);
    assert.ok(stepStart >= 0, `workflow must contain step '${stepName}'`);

    const nextStepStart = workflow.indexOf('\n      - name:', stepStart + 1);
    return nextStepStart >= 0 ? workflow.slice(stepStart, nextStepStart) : workflow.slice(stepStart);
}

function withE2eBridgeBuildEnvironment(value: string | undefined, action: () => void): void {
    const original = process.env[e2eBridgeBuildEnvironmentVariable];

    try {
        if (value === undefined) {
            delete process.env[e2eBridgeBuildEnvironmentVariable];
        }
        else {
            process.env[e2eBridgeBuildEnvironmentVariable] = value;
        }

        action();
    }
    finally {
        if (original === undefined) {
            delete process.env[e2eBridgeBuildEnvironmentVariable];
        }
        else {
            process.env[e2eBridgeBuildEnvironmentVariable] = original;
        }
    }
}
