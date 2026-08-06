import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { applyDevKitHotReloadSupport, isHotReloadSettingEnabled, logHotReloadDiagnostics, tryGetDevKitBrokeredServicePipeName } from '../debugger/hotReload';
import { AspireResourceExtendedDebugConfiguration } from '../dcp/types';

suite('Hot Reload Tests', () => {
    teardown(() => sinon.restore());

    function createDebugConfig(overrides: Partial<AspireResourceExtendedDebugConfiguration> = {}): AspireResourceExtendedDebugConfiguration {
        return {
            type: 'coreclr',
            request: 'launch',
            name: 'Debug api',
            program: '/workspace/api/bin/Debug/net10.0/api.dll',
            noDebug: false,
            runId: '1',
            debugSessionId: '1',
            ...overrides
        };
    }

    /**
     * Stubs extension lookup so only C# Dev Kit resolves, with a caller-controlled exports shape and
     * activation state. Anything else (including the C# extension) resolves to undefined.
     */
    function stubDevKit(options: { active?: boolean; exports?: unknown } = {}): void {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
            if (extensionId !== 'ms-dotnettools.csdevkit') {
                return undefined;
            }

            return {
                id: extensionId,
                isActive: options.active ?? true,
                exports: options.exports
            } as unknown as vscode.Extension<unknown>;
        });
    }

    function stubNoExtensions(): void {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
    }

    test('does not modify the debug configuration when C# Dev Kit is not installed', async () => {
        stubNoExtensions();

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, false);
        assert.strictEqual(diagnostics.devKitActive, false);
        assert.strictEqual(diagnostics.devKitServerLoaded, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('leaves the rest of the debug configuration untouched without C# Dev Kit', async () => {
        stubNoExtensions();

        const debugConfig = createDebugConfig();
        const before = JSON.stringify(debugConfig);

        await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(JSON.stringify(debugConfig), before);
    });

    test('does not activate C# Dev Kit when it has not activated itself', async () => {
        stubDevKit({
            active: false,
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'pipe-should-not-be-read'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('does not inject a pipe name before the C# Dev Kit server process has loaded', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => false,
                getBrokeredServiceServerPipeName: async () => 'pipe-should-not-be-read'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('injects the brokered service pipe name when C# Dev Kit is ready', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, 'devkit-broker-pipe');
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, true);
        assert.strictEqual(diagnostics.pipeNameInjected, true);
    });

    test('does not inject a pipe name for a no-debug session', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig({ noDebug: true });
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('preserves an existing brokered service pipe name', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig({ brokeredServicePipeName: 'already-set-pipe' });
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, 'already-set-pipe');
        assert.strictEqual(diagnostics.pipeNameInjected, true);
    });

    test('ignores an empty pipe name', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => ''
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('does not fail the launch when C# Dev Kit throws while resolving the pipe name', async () => {
        stubDevKit({
            exports: {
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => { throw new Error('broker unavailable'); }
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('tolerates an unexpected C# Dev Kit exports shape', async () => {
        stubDevKit({ exports: { somethingElse: true } });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, false);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('reports limited activation when C# Dev Kit activated for an untrusted workspace', async () => {
        // In limited activation Dev Kit returns ONLY this flag: no service broker, no pipe name.
        stubDevKit({ exports: { isLimitedActivation: true } });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitLimitedActivation, true);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('does not report limited activation for a fully activated C# Dev Kit', async () => {
        stubDevKit({
            exports: {
                isLimitedActivation: false,
                hasServerProcessLoaded: () => true,
                getBrokeredServiceServerPipeName: async () => 'devkit-broker-pipe'
            }
        });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(diagnostics.devKitLimitedActivation, false);
        assert.strictEqual(diagnostics.pipeNameInjected, true);
    });

    test('tolerates undefined C# Dev Kit exports', async () => {
        stubDevKit({ exports: undefined });

        const debugConfig = createDebugConfig();
        const diagnostics = await applyDevKitHotReloadSupport(debugConfig);

        assert.strictEqual(debugConfig.brokeredServicePipeName, undefined);
        assert.strictEqual(diagnostics.pipeNameInjected, false);
    });

    test('returns no pipe name when C# Dev Kit is not installed', async () => {
        stubNoExtensions();

        assert.strictEqual(await tryGetDevKitBrokeredServicePipeName(), undefined);
    });

    test('reads the hot reload setting from the csharp.experimental.debug section', () => {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns({
            get: (name: string) => name === 'hotReload' ? true : undefined
        } as unknown as vscode.WorkspaceConfiguration);

        assert.strictEqual(isHotReloadSettingEnabled(), true);
    });

    test('treats an unset hot reload setting as disabled', () => {
        const getConfiguration = sinon.stub(vscode.workspace, 'getConfiguration');
        getConfiguration.withArgs('csharp.experimental.debug').returns({
            get: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        assert.strictEqual(isHotReloadSettingEnabled(), false);
    });

    test('logging diagnostics never throws', () => {
        logHotReloadDiagnostics('api', {
            devKitInstalled: true,
            devKitActive: true,
            devKitLimitedActivation: false,
            devKitServerLoaded: true,
            settingEnabled: false,
            pipeNameInjected: true
        });

        logHotReloadDiagnostics('api', {
            devKitInstalled: false,
            devKitActive: false,
            devKitLimitedActivation: false,
            devKitServerLoaded: false,
            settingEnabled: false,
            pipeNameInjected: false
        });
    });
});
