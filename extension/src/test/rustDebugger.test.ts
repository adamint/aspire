import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getSupportedCapabilities } from '../capabilities';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { getResourceDebuggerExtensions } from '../debugger/debuggerExtensions';
import { createRustDebuggerExtension, IRustService } from '../debugger/languages/rust';
import { AspireResourceExtendedDebugConfiguration, RustLaunchConfiguration } from '../dcp/types';
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

    buildAndGetExecutablePath(workingDirectory: string, cargoArgs: string[], filter: string | undefined): Promise<string> {
        return this.buildAndGetExecutablePathStub(workingDirectory, cargoArgs, filter);
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
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.ok(rustService.buildAndGetExecutablePathStub.calledWith('/workspace/api', ['build', '--release'], undefined));
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

    test('passes the cargo target filter through to the build', async () => {
        const { rustService, extension } = createExtension('/workspace/api/target/debug/worker');
        const launchConfig: RustLaunchConfiguration = {
            type: 'rust',
            working_directory: '/workspace/api',
            cargo: { args: ['build', '--bin', 'worker'], filter: 'worker' }
        };
        const debugConfig = createDebugConfig();

        await extension.createDebugSessionConfigurationCallback!(
            launchConfig,
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.ok(rustService.buildAndGetExecutablePathStub.calledWith('/workspace/api', ['build', '--bin', 'worker'], 'worker'));
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
});

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
