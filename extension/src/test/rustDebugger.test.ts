import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getSupportedCapabilities } from '../capabilities';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { getResourceDebuggerExtensions } from '../debugger/debuggerExtensions';
import { CargoCompilerArtifactMessage, collectExecutableArtifact, createRustDebuggerExtension, IRustService, selectExecutable } from '../debugger/languages/rust';
import { AspireResourceExtendedDebugConfiguration, EnvVar, RustLaunchConfiguration } from '../dcp/types';
import { ResourceDebuggerExtension } from '../debugger/debuggerExtensions';

class TestRustService implements IRustService {
    public buildAndGetExecutablePathStub: sinon.SinonStub;

    constructor(executablePathOrError: string | Error) {
        this.buildAndGetExecutablePathStub = sinon.stub();
        if (executablePathOrError instanceof Error) {
            this.buildAndGetExecutablePathStub.rejects(executablePathOrError);
        } else {
            this.buildAndGetExecutablePathStub.resolves(executablePathOrError);
        }
    }

    buildAndGetExecutablePath(workingDirectory: string, cargoArgs: string[], env: EnvVar[]): Promise<string> {
        return this.buildAndGetExecutablePathStub(workingDirectory, cargoArgs, env);
    }
}

suite('Rust Debugger Extension Tests', () => {
    const fakeAspireDebugSession = {} as AspireDebugSession;
    const rustExtensionId = process.platform === 'win32' ? 'ms-vscode.cpptools' : 'vadimcn.vscode-lldb';
    const rustDebugAdapter = process.platform === 'win32' ? 'cppvsdbg' : 'lldb';

    teardown(() => sinon.restore());

    function createExtension(executablePathOrError: string | Error): { rustService: TestRustService, extension: ResourceDebuggerExtension } {
        const rustService = new TestRustService(executablePathOrError);
        return { rustService, extension: createRustDebuggerExtension(() => rustService) };
    }

    test('advertises Rust support when the platform-specific debugger extension is installed', () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
            return extensionId === rustExtensionId ? { id: extensionId } as vscode.Extension<unknown> : undefined;
        });

        const capabilities = getSupportedCapabilities();
        assert.ok(capabilities.includes('rust'));
        assert.ok(capabilities.includes(rustExtensionId));
        assert.ok(getResourceDebuggerExtensions().some(extension => extension.resourceType === 'rust'));
    });

    test('does not advertise Rust support when the platform-specific debugger extension is missing', () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);

        const capabilities = getSupportedCapabilities();
        assert.ok(!capabilities.includes('rust'));
        assert.ok(!getResourceDebuggerExtensions().some(extension => extension.resourceType === 'rust'));
    });

    test('builds the crate and configures the platform-specific native debugger', async () => {
        const { rustService, extension } = createExtension('/workspace/api/target/debug/api');
        const launchConfig: RustLaunchConfiguration = {
            type: 'rust',
            working_directory: '/workspace/api',
            cargo: { args: ['build', '--release'] }
        };
        const debugConfig = createDebugConfig();

        await extension.createDebugSessionConfigurationCallback!(
            launchConfig,
            ['--listen', ':8080'],
            [{ name: 'RUSTFLAGS', value: '-C target-cpu=native' }],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        // The resource environment has to reach the build: it carries settings such as RUSTFLAGS and
        // CARGO_* that change what cargo produces.
        assert.ok(rustService.buildAndGetExecutablePathStub.calledWith(
            '/workspace/api',
            ['build', '--release'],
            [{ name: 'RUSTFLAGS', value: '-C target-cpu=native' }]));
        assert.strictEqual(debugConfig.program, '/workspace/api/target/debug/api');
        assert.strictEqual(debugConfig.cwd, '/workspace/api');
        assert.deepStrictEqual(debugConfig.args, ['--listen', ':8080']);

        if (rustDebugAdapter === 'cppvsdbg') {
            assert.strictEqual(debugConfig.console, 'internalConsole');
            assert.ok(Array.isArray(debugConfig.environment));
        } else {
            assert.deepStrictEqual(debugConfig.sourceLanguages, ['rust']);
        }
    });

    test('passes cargo target selection arguments through to the build', async () => {
        const { rustService, extension } = createExtension('/workspace/api/target/debug/worker');
        const launchConfig: RustLaunchConfiguration = {
            type: 'rust',
            working_directory: '/workspace/api',
            cargo: { args: ['build', '--bin', 'worker'] }
        };
        const debugConfig = createDebugConfig();

        await extension.createDebugSessionConfigurationCallback!(
            launchConfig,
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.ok(rustService.buildAndGetExecutablePathStub.calledWith('/workspace/api', ['build', '--bin', 'worker'], []));
        assert.strictEqual(debugConfig.program, '/workspace/api/target/debug/worker');
    });

    test('propagates build failures instead of starting a debug session', async () => {
        const { extension } = createExtension(new Error('cargo build failed in /workspace/api with exit code 101.'));
        const launchConfig: RustLaunchConfiguration = {
            type: 'rust',
            working_directory: '/workspace/api',
            cargo: { args: ['build'] }
        };
        const debugConfig = createDebugConfig();

        await assert.rejects(
            () => extension.createDebugSessionConfigurationCallback!(
                launchConfig,
                [],
                [],
                { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
                debugConfig),
            /cargo build failed/);
    });

    test('selects the only binary cargo produced', () => {
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'api', kind: ['bin'] }, executable: '/workspace/api/target/debug/api' },
            { reason: 'compiler-artifact', target: { name: 'api', kind: ['lib'] }, executable: null }
        ]);

        assert.strictEqual(selectExecutable('/workspace/api', executables), '/workspace/api/target/debug/api');
    });

    test('rebuilding the same target does not make the binary ambiguous', () => {
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'api', kind: ['bin'] }, executable: '/workspace/api/target/debug/api' },
            { reason: 'compiler-artifact', target: { name: 'api', kind: ['bin'] }, executable: '/workspace/api/target/debug/api' }
        ]);

        assert.strictEqual(selectExecutable('/workspace/api', executables), '/workspace/api/target/debug/api');
    });

    test('selects an example target because cargo can run examples', () => {
        // `cargo run --example demo` is a normal launch shape, and cargo reports the artifact with
        // kind ["example"] rather than ["bin"].
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'demo', kind: ['example'] }, executable: '/workspace/api/target/debug/examples/demo' }
        ]);

        assert.strictEqual(selectExecutable('/workspace/api', executables), '/workspace/api/target/debug/examples/demo');
    });

    test('ignores test and bench artifacts that are not the debug target', () => {
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'api', kind: ['bin'] }, executable: '/workspace/api/target/debug/api' },
            { reason: 'compiler-artifact', target: { name: 'integration', kind: ['test'] }, executable: '/workspace/api/target/debug/deps/integration' },
            { reason: 'compiler-artifact', target: { name: 'throughput', kind: ['bench'] }, executable: '/workspace/api/target/debug/deps/throughput' }
        ]);

        assert.strictEqual(selectExecutable('/workspace/api', executables), '/workspace/api/target/debug/api');
    });

    test('fails instead of guessing when a crate produced several binaries', () => {
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'server', kind: ['bin'] }, executable: '/workspace/api/target/debug/server' },
            { reason: 'compiler-artifact', target: { name: 'worker', kind: ['bin'] }, executable: '/workspace/api/target/debug/worker' }
        ]);

        assert.throws(() => selectExecutable('/workspace/api', executables), /bin\/server, bin\/worker/);
    });

    test('a bin and an example sharing a name are still ambiguous', () => {
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'demo', kind: ['bin'] }, executable: '/workspace/api/target/debug/demo' },
            { reason: 'compiler-artifact', target: { name: 'demo', kind: ['example'] }, executable: '/workspace/api/target/debug/examples/demo' }
        ]);

        assert.throws(() => selectExecutable('/workspace/api', executables), /bin\/demo, example\/demo/);
    });

    test('fails when the build produced no runnable binary', () => {
        const executables = collectArtifacts([
            { reason: 'compiler-artifact', target: { name: 'api', kind: ['lib'] }, executable: null }
        ]);

        assert.throws(() => selectExecutable('/workspace/api', executables), /did not produce a runnable binary/);
    });
});

function collectArtifacts(messages: CargoCompilerArtifactMessage[]): Map<string, string> {
    const executables = new Map<string, string>();
    for (const message of messages) {
        collectExecutableArtifact(executables, message);
    }

    return executables;
}

function createDebugConfig(): AspireResourceExtendedDebugConfiguration {
    return {
        runId: '1',
        debugSessionId: '1',
        type: 'rust',
        name: 'Rust',
        request: 'launch',
        program: '/workspace/api',
        args: [],
        env: {}
    };
}
