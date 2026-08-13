import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { addCommand } from '../commands/add';
import { newCommand } from '../commands/new';
import { AspireEditorCommandProvider } from '../editor/AspireEditorCommandProvider';
import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';

type SentCommand = {
    subcommand: string;
    additionalArgs?: string[];
};

suite('nuget source command forwarding', () => {
    let configuredNugetSource: string;
    let appHostPath: string | undefined;
    let sentCommands: SentCommand[];
    let getConfigurationStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;

    setup(() => {
        configuredNugetSource = '';
        appHostPath = '/workspace/AppHost/AppHost.csproj';
        sentCommands = [];

        getConfigurationStub = sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
            assert.strictEqual(section, 'aspire');

            return {
                get: <T>(key: string) => {
                    assert.strictEqual(key, 'nugetSource');
                    return configuredNugetSource as T;
                }
            } as vscode.WorkspaceConfiguration;
        });

        showErrorMessageStub = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    });

    teardown(() => {
        getConfigurationStub.restore();
        showErrorMessageStub.restore();
    });

    function createTerminalProvider(): AspireTerminalProvider {
        return {
            sendAspireCommandToAspireTerminal: async (subcommand: string, _showTerminal?: boolean, additionalArgs?: string[]) => {
                sentCommands.push({ subcommand, additionalArgs });
            }
        } as unknown as AspireTerminalProvider;
    }

    function createEditorCommandProvider(): AspireEditorCommandProvider {
        return {
            getAppHostPath: async () => appHostPath
        } as unknown as AspireEditorCommandProvider;
    }

    test('new preserves existing behavior when the nuget source setting is blank', async () => {
        configuredNugetSource = ' \t ';

        await newCommand(createTerminalProvider());

        assert.deepStrictEqual(sentCommands, [{ subcommand: 'new', additionalArgs: undefined }]);
        assert.strictEqual(showErrorMessageStub.called, false);
    });

    test('add preserves existing apphost behavior when the nuget source setting is blank', async () => {
        configuredNugetSource = '  ';

        await addCommand(createTerminalProvider(), createEditorCommandProvider());

        assert.deepStrictEqual(sentCommands, [{ subcommand: 'add', additionalArgs: ['--apphost', '/workspace/AppHost/AppHost.csproj'] }]);
        assert.strictEqual(showErrorMessageStub.called, false);
    });

    test('new forwards a configured nuget source', async () => {
        configuredNugetSource = 'https://pkgs.dev.azure.com/dnceng/_packaging/dotnet-public/nuget/v3/index.json';

        await newCommand(createTerminalProvider());

        assert.deepStrictEqual(sentCommands, [{ subcommand: 'new', additionalArgs: ['--source', configuredNugetSource] }]);
    });

    test('add appends a configured nuget source after the apphost arguments', async () => {
        configuredNugetSource = 'https://pkgs.dev.azure.com/dnceng/_packaging/dotnet-public/nuget/v3/index.json';

        await addCommand(createTerminalProvider(), createEditorCommandProvider());

        assert.deepStrictEqual(sentCommands, [{
            subcommand: 'add',
            additionalArgs: ['--apphost', '/workspace/AppHost/AppHost.csproj', '--source', configuredNugetSource]
        }]);
    });

    test('new keeps shell metacharacters in the configured nuget source as one raw argument', async () => {
        configuredNugetSource = 'named source "$(touch no)" ;&| $HOME';

        await newCommand(createTerminalProvider());

        assert.deepStrictEqual(sentCommands, [{
            subcommand: 'new',
            additionalArgs: ['--source', 'named source "$(touch no)" ;&| $HOME']
        }]);
    });

    test('new rejects a configured nuget source that contains URL credentials', async () => {
        configuredNugetSource = 'https://user@example.com/v3/index.json';

        await assert.rejects(() => newCommand(createTerminalProvider()), vscode.CancellationError);

        assert.deepStrictEqual(sentCommands, []);
        assert.deepStrictEqual(showErrorMessageStub.firstCall.args, [
            'The aspire.nugetSource setting cannot contain credentials. Use a NuGet credential provider instead.'
        ]);
    });
});
