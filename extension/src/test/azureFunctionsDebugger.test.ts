import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { azureFunctionsDebuggerExtension } from '../debugger/languages/azureFunctions';
import { AspireResourceExtendedDebugConfiguration, AzureFunctionsLaunchConfiguration } from '../dcp/types';
import { AspireDebugSession } from '../debugger/AspireDebugSession';

suite('Azure Functions Debugger Extension Tests', () => {
    teardown(() => sinon.restore());

    test('starts dotnet isolated worker with debug flags before host arguments', async () => {
        const startFuncProcess = sinon.stub().resolves({
            processId: '1234',
            success: true
        });
        const getApi = sinon.stub().returns({
            apiVersion: '1.10.0',
            startFuncProcess
        });
        sinon.stub(vscode.extensions, 'getExtension').returns({
            isActive: true,
            exports: { getApi },
            activate: sinon.stub().resolves()
        } as unknown as vscode.Extension<unknown>);

        const projectDir = path.join(process.cwd(), 'Function App With Spaces');
        const projectPath = path.join(projectDir, 'FunctionApp.csproj');
        const launchConfig: AzureFunctionsLaunchConfiguration = {
            type: 'azure-functions',
            project_path: projectPath
        };
        const debugConfig: AspireResourceExtendedDebugConfiguration = {
            runId: 'run-1',
            debugSessionId: 'debug-1',
            type: 'coreclr',
            name: 'Test Debug Config',
            request: 'launch',
            program: projectPath,
            args: ['--port', '61310'],
            cwd: projectDir,
            env: {
                SHOULD_BE_REMOVED_FOR_ATTACH: 'true'
            }
        };
        const fakeAspireDebugSession = sinon.createStubInstance(AspireDebugSession);

        await azureFunctionsDebuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            ['--port', '61310'],
            [{ name: 'ASPNETCORE_ENVIRONMENT', value: 'Development' }],
            { debug: true, runId: 'run-1', debugSessionId: 'debug-1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        sinon.assert.calledOnceWithExactly(startFuncProcess, projectDir, ['--dotnet-isolated-debug', '--enable-json-output', '--port', '61310'], {
            ASPNETCORE_ENVIRONMENT: 'Development'
        });
        assert.strictEqual(debugConfig.type, 'coreclr');
        assert.strictEqual(debugConfig.request, 'attach');
        assert.strictEqual(debugConfig.processId, '1234');
        assert.strictEqual(debugConfig.program, undefined);
        assert.strictEqual(debugConfig.args, undefined);
        assert.strictEqual(debugConfig.cwd, undefined);
        assert.strictEqual(debugConfig.env, undefined);
    });

    test('strips dotnet run process fallback arguments before starting func host', async () => {
        const startFuncProcess = sinon.stub().resolves({
            processId: '1234',
            success: true
        });
        const getApi = sinon.stub().returns({
            apiVersion: '1.10.0',
            startFuncProcess
        });
        sinon.stub(vscode.extensions, 'getExtension').returns({
            isActive: true,
            exports: { getApi },
            activate: sinon.stub().resolves()
        } as unknown as vscode.Extension<unknown>);

        const projectDir = path.join(process.cwd(), 'Function App With Spaces');
        const projectPath = path.join(projectDir, 'FunctionApp.csproj');
        const launchConfig: AzureFunctionsLaunchConfiguration = {
            type: 'azure-functions',
            project_path: projectPath
        };
        const debugConfig: AspireResourceExtendedDebugConfiguration = {
            runId: 'run-1',
            debugSessionId: 'debug-1',
            type: 'coreclr',
            name: 'Test Debug Config',
            request: 'launch',
            program: projectPath,
            cwd: projectDir
        };
        const fakeAspireDebugSession = sinon.createStubInstance(AspireDebugSession);

        await azureFunctionsDebuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            ['run', '--project', projectPath, '--no-launch-profile', '--port', '61310'],
            [],
            { debug: true, runId: 'run-1', debugSessionId: 'debug-1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        sinon.assert.calledOnceWithExactly(startFuncProcess, projectDir, ['--dotnet-isolated-debug', '--enable-json-output', '--port', '61310'], {});
    });
});
