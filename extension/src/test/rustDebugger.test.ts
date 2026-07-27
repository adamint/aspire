import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getSupportedCapabilities } from '../capabilities';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { getResourceDebuggerExtensions } from '../debugger/debuggerExtensions';
import { rustDebuggerExtension } from '../debugger/languages/rust';
import { AspireResourceExtendedDebugConfiguration, RustLaunchConfiguration } from '../dcp/types';

suite('Rust Debugger Extension Tests', () => {
    const fakeAspireDebugSession = {} as AspireDebugSession;

    teardown(() => sinon.restore());

    test('advertises Rust support when a Rust debugger extension is installed', () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        sinon.stub(vscode.extensions, 'all').value([{
            packageJSON: {
                contributes: {
                    debuggers: [{ type: 'codelldb' }]
                }
            }
        } as unknown as vscode.Extension<unknown>]);

        const capabilities = getSupportedCapabilities();
        assert.ok(capabilities.includes('rust'));
        assert.ok(getResourceDebuggerExtensions().some(extension => extension.resourceType === 'rust'));
    });

    test('configures VS Code Rust debugger with cargo metadata', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        sinon.stub(vscode.extensions, 'all').value([{
            packageJSON: {
                contributes: {
                    debuggers: [{ type: 'codelldb' }]
                }
            }
        } as unknown as vscode.Extension<unknown>]);

        const launchConfig: RustLaunchConfiguration = {
            type: 'rust',
            working_directory: '/workspace/rust-app',
            cargo: {
                args: ['build', '--release'],
                filter: 'rust-app'
            }
        };
        const debugConfig = createDebugConfig();

        await rustDebuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            ['--port', '8080'],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.ok(['cppvsdbg', 'cppdbg', 'codelldb', 'lldb'].includes(debugConfig.type));
        assert.strictEqual(debugConfig.request, 'launch');
        assert.strictEqual(debugConfig.cwd, '/workspace/rust-app');
        assert.deepStrictEqual(debugConfig.args, ['--port', '8080']);
        if (debugConfig.type === 'cppvsdbg' || debugConfig.type === 'cppdbg') {
            assert.strictEqual(debugConfig.cargo, undefined);
            const expectedExecutable = process.platform === 'win32' ? 'rust-app.exe' : 'rust-app';
            assert.strictEqual(debugConfig.program, path.join('/workspace/rust-app', 'target', 'debug', expectedExecutable));
        }
        else {
            assert.deepStrictEqual(debugConfig.cargo, { args: ['build', '--release'], filter: 'rust-app' });
            assert.strictEqual(debugConfig.program, undefined);
        }
        assert.strictEqual(debugConfig.noDebug, false);
    });

    test('sets noDebug when launch option disables debugging', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        sinon.stub(vscode.extensions, 'all').value([{
            packageJSON: {
                contributes: {
                    debuggers: [{ type: 'lldb' }]
                }
            }
        } as unknown as vscode.Extension<unknown>]);

        const launchConfig: RustLaunchConfiguration = {
            type: 'rust',
            working_directory: '/workspace/rust-app',
            cargo: {
                args: ['build']
            }
        };
        const debugConfig = createDebugConfig();

        await rustDebuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            [],
            [],
            { debug: false, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.noDebug, true);
    });
});

function createDebugConfig(): AspireResourceExtendedDebugConfiguration {
    return {
        runId: '1',
        debugSessionId: '1',
        type: 'rust',
        name: 'Rust',
        request: 'launch',
        program: '/workspace/rust-app',
        args: []
    };
}
