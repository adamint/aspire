import * as assert from 'assert';
import * as vscode from 'vscode';
import { applyDevKitHotReloadSupport, tryGetDevKitBrokeredServicePipeName } from '../debugger/hotReload';
import { AspireResourceExtendedDebugConfiguration } from '../dcp/types';

/**
 * Runs against a REAL C# Dev Kit installation (not a stub) to verify the assumptions the Hot Reload
 * integration is built on. Requires ms-dotnettools.csdevkit to be installed in the extensions
 * directory used by the test host, so it is not part of the normal unit test run.
 */
suite('C# Dev Kit Hot Reload proof', function () {
    this.timeout(300000);

    const csDevKitExtensionId = 'ms-dotnettools.csdevkit';

    async function waitFor(description: string, condition: () => boolean, timeoutMs = 180000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (condition()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
    }

    test('the real C# Dev Kit exports the API the Hot Reload integration depends on', async () => {
        const devKit = vscode.extensions.getExtension(csDevKitExtensionId);
        assert.ok(devKit, `${csDevKitExtensionId} must be installed for this proof to be meaningful`);

        console.log(`[proof] Dev Kit version: ${devKit.packageJSON.version}`);
        console.log(`[proof] Dev Kit active before activation: ${devKit.isActive}`);

        await devKit.activate();
        assert.strictEqual(devKit.isActive, true);

        const exports = devKit.exports;
        console.log(`[proof] Dev Kit export keys: ${Object.keys(exports ?? {}).join(', ')}`);

        assert.strictEqual(typeof exports?.hasServerProcessLoaded, 'function', 'hasServerProcessLoaded must exist');
        assert.strictEqual(typeof exports?.getBrokeredServiceServerPipeName, 'function', 'getBrokeredServiceServerPipeName must exist');
    });

    test('the real C# Dev Kit brokered service pipe name is resolvable', async () => {
        const devKit = vscode.extensions.getExtension(csDevKitExtensionId);
        assert.ok(devKit);
        await devKit.activate();

        await waitFor('Dev Kit server process to load', () => devKit.exports.hasServerProcessLoaded() === true);
        console.log('[proof] hasServerProcessLoaded() === true');

        const pipeName = await devKit.exports.getBrokeredServiceServerPipeName();
        console.log(`[proof] pipe name resolved: ${typeof pipeName === 'string' && pipeName.length > 0 ? `yes (length ${pipeName.length})` : `no (${JSON.stringify(pipeName)})`}`);

        assert.strictEqual(typeof pipeName, 'string');
        assert.ok(pipeName.length > 0, 'pipe name must not be empty');
    });

    test('applyDevKitHotReloadSupport injects the real pipe name onto a project debug configuration', async () => {
        const devKit = vscode.extensions.getExtension(csDevKitExtensionId);
        assert.ok(devKit);
        await devKit.activate();
        await waitFor('Dev Kit server process to load', () => devKit.exports.hasServerProcessLoaded() === true);

        const expectedPipeName = await devKit.exports.getBrokeredServiceServerPipeName();

        const debugConfiguration: AspireResourceExtendedDebugConfiguration = {
            type: 'coreclr',
            request: 'launch',
            name: 'Debug proof',
            program: '/tmp/proof/bin/Debug/net10.0/proof.dll',
            noDebug: false,
            runId: '1',
            debugSessionId: '1'
        };

        const diagnostics = await applyDevKitHotReloadSupport(debugConfiguration);

        console.log(`[proof] diagnostics: ${JSON.stringify(diagnostics)}`);
        console.log(`[proof] injected pipe matches Dev Kit pipe: ${debugConfiguration.brokeredServicePipeName === expectedPipeName}`);

        assert.strictEqual(diagnostics.devKitInstalled, true);
        assert.strictEqual(diagnostics.devKitActive, true);
        assert.strictEqual(diagnostics.devKitServerLoaded, true);
        assert.strictEqual(diagnostics.pipeNameInjected, true);
        assert.strictEqual(debugConfiguration.brokeredServicePipeName, expectedPipeName);

        assert.strictEqual(await tryGetDevKitBrokeredServicePipeName(), expectedPipeName);
    });
});
