import * as assert from 'assert';
import * as sinon from 'sinon';
import type { AspireDebugSession } from '../debugger/AspireDebugSession';
import { createDebugSessionConfiguration, ResourceDebuggerExtension } from '../debugger/debuggerExtensions';
import { ExecutableLaunchConfiguration } from '../dcp/types';
import {
    ASPIRE_VSCODE_EXTENSION_CHANNEL_ENV_VAR,
    ASPIRE_VSCODE_EXTENSION_VERSION_ENV_VAR,
    getAspireExtensionEnvironment,
} from '../utils/cliPathEnvironment';

suite('debuggerExtensions tests', () => {
    test('uses the active prerelease extension identity over AppHost debug environment overrides', async () => {
        const platformStub = sinon.stub(process, 'platform').value('win32');
        const extensionEnvironment = getAspireExtensionEnvironment({
            version: '1.17.0',
            preRelease: true,
        });
        assert.ok(extensionEnvironment);
        const debuggerExtension: ResourceDebuggerExtension = {
            resourceType: 'project',
            debugAdapter: 'coreclr',
            extensionId: null,
            getDisplayName: () => 'AppHost',
            getProjectFile: () => '/workspace/AppHost/AppHost.csproj',
            getSupportedFileTypes: () => ['.csproj'],
        };

        try {
            const configuration = await createDebugSessionConfiguration(
                {
                    type: 'aspire',
                    request: 'launch',
                    name: 'Aspire',
                    program: '/workspace/AppHost/AppHost.csproj',
                    debuggers: {
                        apphost: {
                            env: {
                                aspire_vscode_extension_version: 'debugger-version',
                                aspire_vscode_extension_channel: 'stable',
                                CALLER_SETTING: 'preserved',
                            },
                        },
                    },
                },
                {
                    type: 'project',
                    project_path: '/workspace/AppHost/AppHost.csproj',
                } as ExecutableLaunchConfiguration,
                [],
                [
                    { name: 'aspire_vscode_extension_version', value: 'cli-version' },
                    { name: 'aspire_vscode_extension_channel', value: 'stable' },
                ],
                {
                    debug: true,
                    runId: 'apphost-run',
                    debugSessionId: 'aspire-session',
                    isApphost: true,
                    debugSession: { aspireExtensionEnvironment: extensionEnvironment } as AspireDebugSession,
                },
                debuggerExtension);

            assert.strictEqual(configuration.env?.[ASPIRE_VSCODE_EXTENSION_VERSION_ENV_VAR], '1.17.0');
            assert.strictEqual(configuration.env?.[ASPIRE_VSCODE_EXTENSION_CHANNEL_ENV_VAR], 'prerelease');
            assert.strictEqual(configuration.env?.aspire_vscode_extension_version, undefined);
            assert.strictEqual(configuration.env?.aspire_vscode_extension_channel, undefined);
            assert.strictEqual(configuration.env?.CALLER_SETTING, 'preserved');
        }
        finally {
            platformStub.restore();
        }
    });
});
