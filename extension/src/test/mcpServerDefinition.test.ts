import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as cliPath from '../utils/cliPath';
import { AspireMcpServerDefinitionProvider, createAspireMcpServerDefinition } from '../mcp/AspireMcpServerDefinitionProvider';
import {
    ASPIRE_VSCODE_EXTENSION_CHANNEL_ENV_VAR,
    ASPIRE_VSCODE_EXTENSION_VERSION_ENV_VAR,
    getAspireExtensionEnvironment,
} from '../utils/cliPathEnvironment';

suite('AspireMcpServerDefinitionProvider definition tests', () => {
    test('wraps Windows command shims with only prerelease identity overrides', () => {
        const platformStub = sinon.stub(process, 'platform').value('win32');
        const extensionEnvironment = getAspireExtensionEnvironment({
            version: '1.17.0',
            preRelease: true,
        });
        assert.ok(extensionEnvironment);
        const inheritedEnvironment: NodeJS.ProcessEnv = {
            ComSpec: 'C:\\Windows\\System32\\cmd.exe',
            Path: 'C:\\sensitive\\bin',
            ASPIRE_MCP_SECRET_TEST: 'secret-value',
            aspire_vscode_extension_version: 'spoofed-version',
            aspire_vscode_extension_channel: 'stable',
        };
        const originalEnvironment = { ...inheritedEnvironment };
        const processEnvironmentStub = sinon.stub(process, 'env').value(inheritedEnvironment);

        try {
            const cliPath = 'C:\\Program Files\\a&b,c;d%NAME%\\aspire.cmd';
            const definition = createAspireMcpServerDefinition(cliPath, extensionEnvironment);

            assert.strictEqual(definition.label, 'Aspire');
            assert.strictEqual(definition.command, process.env.ComSpec);
            assert.deepStrictEqual(definition.args, [
                '/d',
                '/v:off',
                '/c',
                'C:\\Program^ Files\\a^&b^,c^;d%NAME%\\aspire.cmd',
                'agent',
                'mcp',
            ]);
            assert.deepStrictEqual(definition.env, {
                [ASPIRE_VSCODE_EXTENSION_VERSION_ENV_VAR]: '1.17.0',
                [ASPIRE_VSCODE_EXTENSION_CHANNEL_ENV_VAR]: 'prerelease',
                aspire_vscode_extension_version: null,
                aspire_vscode_extension_channel: null,
            });
            assert.deepStrictEqual(process.env, originalEnvironment);
        }
        finally {
            processEnvironmentStub.restore();
            platformStub.restore();
        }
    });

    test('passes native executables through with only stable identity overrides', () => {
        const extensionEnvironment = getAspireExtensionEnvironment({
            version: '1.16.0',
        });
        assert.ok(extensionEnvironment);
        const inheritedEnvironment: NodeJS.ProcessEnv = {
            PATH: '/sensitive/bin',
            ASPIRE_MCP_SECRET_TEST: 'secret-value',
            [ASPIRE_VSCODE_EXTENSION_VERSION_ENV_VAR]: 'spoofed-version',
            [ASPIRE_VSCODE_EXTENSION_CHANNEL_ENV_VAR]: 'prerelease',
        };
        const originalEnvironment = { ...inheritedEnvironment };
        const processEnvironmentStub = sinon.stub(process, 'env').value(inheritedEnvironment);

        try {
            const definition = createAspireMcpServerDefinition('C:\\Program Files\\Aspire\\aspire.exe', extensionEnvironment);

            assert.strictEqual(definition.command, 'C:\\Program Files\\Aspire\\aspire.exe');
            assert.deepStrictEqual(definition.args, ['agent', 'mcp']);
            assert.deepStrictEqual(definition.env, {
                [ASPIRE_VSCODE_EXTENSION_VERSION_ENV_VAR]: '1.16.0',
                [ASPIRE_VSCODE_EXTENSION_CHANNEL_ENV_VAR]: 'stable',
            });
            assert.deepStrictEqual(process.env, originalEnvironment);
        }
        finally {
            processEnvironmentStub.restore();
        }
    });
});

suite('AspireMcpServerDefinitionProvider refresh tests', () => {
    let configChangeHandler: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    let configurationStub: sinon.SinonStub;
    let getConfigurationStub: sinon.SinonStub;
    let workspaceFoldersStub: sinon.SinonStub;

    setup(() => {
        configurationStub = sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(handler => {
            configChangeHandler = handler as (event: vscode.ConfigurationChangeEvent) => void;
            return { dispose: () => { } };
        });
        workspaceFoldersStub = sinon.stub(vscode.workspace, 'onDidChangeWorkspaceFolders').returns({ dispose: () => { } });
        const workspaceConfiguration: vscode.WorkspaceConfiguration = {
            get: sinon.stub().returns(true),
            has: sinon.stub().returns(true),
            inspect: sinon.stub().returns(undefined),
            update: sinon.stub().resolves(),
        };
        getConfigurationStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(workspaceConfiguration);
    });

    teardown(() => {
        configurationStub.restore();
        getConfigurationStub.restore();
        workspaceFoldersStub.restore();
    });

    test('refreshes when the configured CLI executable path changes', () => {
        const provider = new AspireMcpServerDefinitionProvider(undefined);
        const refresh = sinon.stub(provider, 'refresh').resolves();

        configChangeHandler!({
            affectsConfiguration: section => section === 'aspire.aspireCliExecutablePath',
        });

        assert.ok(refresh.calledOnce);
        provider.dispose();
    });

    test('refreshes when CLI resolution rejects a configured path', async () => {
        cliPath.resetRejectedConfiguredCliPathForForwarding();
        const provider = new AspireMcpServerDefinitionProvider(undefined);
        const refresh = sinon.stub(provider, 'refresh').resolves();

        try {
            await cliPath.resolveCliPath({
                getConfiguredPath: () => '/invalid/aspire',
                getDefaultPaths: () => [],
                isConfiguredPathAutoConfigured: () => false,
                findOnPath: async () => 'aspire',
                findAtDefaultPath: async () => undefined,
                tryExecute: async () => false,
                setConfiguredPath: async () => { },
                updateResolvedPathForForwarding: () => { },
            });

            assert.ok(refresh.called, 'MCP definitions should refresh when another consumer rejects the configured CLI');
        }
        finally {
            provider.dispose();
            cliPath.resetRejectedConfiguredCliPathForForwarding();
        }
    });

    test('ignores an older refresh that completes after a newer result', async () => {
        const workspaceFoldersValueStub = sinon.stub(vscode.workspace, 'workspaceFolders').value([{
            index: 0,
            name: 'test',
            uri: vscode.Uri.file('/workspace'),
        }]);
        let completeOlderRefresh: ((result: cliPath.CliPathResolutionResult) => void) | undefined;
        const olderResult = new Promise<cliPath.CliPathResolutionResult>(resolve => completeOlderRefresh = resolve);
        const resolveCliPathStub = sinon.stub(cliPath, 'resolveCliPath');
        resolveCliPathStub.onFirstCall().returns(olderResult);
        resolveCliPathStub.onSecondCall().resolves({
            available: false,
            cliPath: 'aspire',
            source: 'not-found',
        });
        const provider = new AspireMcpServerDefinitionProvider(undefined);
        const cancellationSource = new vscode.CancellationTokenSource();

        try {
            const olderRefresh = provider.refresh();
            await provider.refresh();

            completeOlderRefresh!({
                available: true,
                cliPath: '/old/aspire',
                source: 'configured',
            });
            await olderRefresh;

            assert.deepStrictEqual(
                provider.provideMcpServerDefinitions(cancellationSource.token),
                [],
                'an older refresh must not restore a stale CLI path');
        }
        finally {
            cancellationSource.dispose();
            provider.dispose();
            resolveCliPathStub.restore();
            workspaceFoldersValueStub.restore();
        }
    });
});
