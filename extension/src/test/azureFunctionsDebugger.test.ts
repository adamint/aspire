import * as assert from 'assert';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { azureFunctionsDebuggerExtension } from '../debugger/languages/azureFunctions';
import { cleanupRun } from '../debugger/runCleanupRegistry';
import { AspireResourceExtendedDebugConfiguration, AzureFunctionsLaunchConfiguration } from '../dcp/types';
import { azureFunctionsDisplayName, azureFunctionsLabel } from '../loc/strings';

suite('Azure Functions Debugger Tests', () => {
    const fakeAspireDebugSession = {} as AspireDebugSession;

    test('attaches the C# debugger to the worker process the Azure Functions extension starts', () => {
        assert.strictEqual(azureFunctionsDebuggerExtension.resourceType, 'azure-functions');
        assert.strictEqual(azureFunctionsDebuggerExtension.debugAdapter, 'coreclr');
        assert.strictEqual(azureFunctionsDebuggerExtension.extensionId, 'ms-dotnettools.csharp');
        assert.deepStrictEqual(azureFunctionsDebuggerExtension.getSupportedFileTypes(), ['.cs', '.csproj']);
    });

    test('names the session from the project file', () => {
        const displayName = azureFunctionsDebuggerExtension.getDisplayName({
            type: 'azure-functions',
            project_path: '/workspace/Functions/Functions.csproj',
        } as AzureFunctionsLaunchConfiguration);

        assert.strictEqual(displayName, azureFunctionsDisplayName('Functions.csproj'));
    });

    test('falls back to the generic label for another resource type', () => {
        const displayName = azureFunctionsDebuggerExtension.getDisplayName({
            type: 'node',
            script_path: '/workspace/app/server.js',
        } as unknown as AzureFunctionsLaunchConfiguration);

        assert.strictEqual(displayName, azureFunctionsLabel);
    });

    test('resolves the project file from the launch configuration', () => {
        const projectFile = azureFunctionsDebuggerExtension.getProjectFile({
            type: 'azure-functions',
            project_path: '/workspace/Functions/Functions.csproj',
        } as AzureFunctionsLaunchConfiguration);

        assert.strictEqual(projectFile, '/workspace/Functions/Functions.csproj');
    });

    test('rejects a project file lookup for another resource type', () => {
        assert.throws(
            () => azureFunctionsDebuggerExtension.getProjectFile({ type: 'node', script_path: '/workspace/app/server.js' } as unknown as AzureFunctionsLaunchConfiguration),
            /Invalid launch configuration/);
    });

    test('reports a missing Azure Functions extension instead of starting a session that cannot attach', async () => {
        const debugConfig = createDebugConfig();

        try {
            await assert.rejects(
                () => azureFunctionsDebuggerExtension.createDebugSessionConfigurationCallback!(
                    { type: 'azure-functions', project_path: '/workspace/Functions/Functions.csproj' } as AzureFunctionsLaunchConfiguration,
                    [],
                    [],
                    { debug: true, runId: debugConfig.runId, debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
                    debugConfig),
                /ms-azuretools\.vscode-azurefunctions/);
        }
        finally {
            // The adapter registers its func-host cleanup before it reaches the extension lookup, so
            // the registry entry has to be drained here or it would leak into later tests.
            cleanupRun(debugConfig.runId);
        }
    });

    test('rejects a session configuration for another resource type', async () => {
        const debugConfig = createDebugConfig();

        await assert.rejects(
            () => azureFunctionsDebuggerExtension.createDebugSessionConfigurationCallback!(
                { type: 'node', script_path: '/workspace/app/server.js' } as unknown as AzureFunctionsLaunchConfiguration,
                [],
                [],
                { debug: true, runId: debugConfig.runId, debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
                debugConfig),
            /Invalid launch configuration/);
    });
});

function createDebugConfig(): AspireResourceExtendedDebugConfiguration {
    return {
        runId: `azure-functions-unit-test-${Math.random().toString(36).slice(2)}`,
        debugSessionId: '1',
        type: 'coreclr',
        name: 'Azure Functions',
        request: 'launch',
        program: '/workspace/Functions/Functions.csproj',
        args: [],
    };
}
