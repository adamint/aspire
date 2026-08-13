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
    const invalidSourceMessage = 'The aspire.nugetSource setting cannot contain credentials, a query string, or a fragment in an HTTP(S) source. Use a NuGet credential provider instead.';
    let configuredNugetSource: string;
    let appHostPath: string | undefined;
    let getAppHostPathCallCount: number;
    let sentCommands: SentCommand[];
    let getConfigurationStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;

    setup(() => {
        configuredNugetSource = '';
        appHostPath = '/workspace/AppHost/AppHost.csproj';
        getAppHostPathCallCount = 0;
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
            getAppHostPath: async () => {
                getAppHostPathCallCount++;
                return appHostPath;
            }
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

    test('add forwards a configured nuget source when no apphost is resolved', async () => {
        configuredNugetSource = 'https://pkgs.dev.azure.com/dnceng/_packaging/dotnet-public/nuget/v3/index.json';
        appHostPath = undefined;

        await addCommand(createTerminalProvider(), createEditorCommandProvider());

        assert.deepStrictEqual(sentCommands, [{ subcommand: 'add', additionalArgs: ['--source', configuredNugetSource] }]);
    });

    test('add keeps existing behavior for an empty nuget source when no apphost is resolved', async () => {
        configuredNugetSource = '';
        appHostPath = undefined;

        await addCommand(createTerminalProvider(), createEditorCommandProvider());

        assert.deepStrictEqual(sentCommands, [{ subcommand: 'add', additionalArgs: undefined }]);
        assert.strictEqual(showErrorMessageStub.called, false);
    });

    test('new forwards a configured nuget source', async () => {
        configuredNugetSource = 'https://pkgs.dev.azure.com/dnceng/_packaging/dotnet-public/nuget/v3/index.json';

        await newCommand(createTerminalProvider());

        assert.deepStrictEqual(sentCommands, [{ subcommand: 'new', additionalArgs: ['--source', configuredNugetSource] }]);
    });

    for (const [description, source] of [
        ['an IPv6 URL', 'https://[2001:db8::1]/v3/index.json'],
        ['a scoped IPv6 URL without credential material', 'https://[fe80::1%25eth0]/v3/index.json'],
        ['a local path', '/workspace/packages'],
    ]) {
        test(`new forwards ${description}`, async () => {
            configuredNugetSource = source;

            await newCommand(createTerminalProvider());

            assert.deepStrictEqual(sentCommands, [{
                subcommand: 'new',
                additionalArgs: ['--source', configuredNugetSource]
            }]);
            assert.strictEqual(showErrorMessageStub.called, false);
        });
    }

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

    for (const [description, source] of [
        ['an HTTPS query string', 'https://example.com/v3/index.json?sig=token'],
        ['an empty HTTPS query string', 'https://example.com/v3/index.json?'],
        ['an HTTP fragment', 'http://example.com/v3/index.json#token'],
        ['an empty HTTP fragment', 'http://example.com/v3/index.json#'],
        ['HTTP userinfo', 'http://user@example.com/v3/index.json'],
        ['HTTPS userinfo with a password', 'https://user:password@example.com/v3/index.json'],
    ]) {
        test(`new rejects a configured nuget source with ${description}`, async () => {
            configuredNugetSource = source;

            await assert.rejects(() => newCommand(createTerminalProvider()), vscode.CancellationError);

            assert.deepStrictEqual(sentCommands, []);
            assert.deepStrictEqual(showErrorMessageStub.firstCall.args, [invalidSourceMessage]);
        });
    }

    for (const [description, source] of [
        ['userinfo and a query string', 'https://user:pass@[fe80::1%25eth0]/v3/index.json?sig=token'],
        ['userinfo', 'https://user:pass@[fe80::1%25eth0]/v3/index.json'],
        ['a query string', 'https://[fe80::1%25eth0]/v3/index.json?sig=token'],
        ['a fragment', 'https://[fe80::1%25eth0]/v3/index.json#token'],
        ['an empty query string', 'https://[fe80::1%25eth0]/v3/index.json?'],
        ['an empty fragment', 'https://[fe80::1%25eth0]/v3/index.json#'],
    ]) {
        test(`new rejects a scoped IPv6 nuget source with ${description}`, async () => {
            configuredNugetSource = source;

            await assert.rejects(() => newCommand(createTerminalProvider()), vscode.CancellationError);

            assert.deepStrictEqual(sentCommands, []);
            assert.deepStrictEqual(showErrorMessageStub.firstCall.args, [invalidSourceMessage]);
        });
    }

    test('new allows credential material on non-HTTP sources to match the CLI policy', async () => {
        configuredNugetSource = 'ftp://user:password@example.com/v3/index.json?query#fragment';

        await newCommand(createTerminalProvider());

        assert.deepStrictEqual(sentCommands, [{
            subcommand: 'new',
            additionalArgs: ['--source', configuredNugetSource]
        }]);
        assert.strictEqual(showErrorMessageStub.called, false);
    });

    for (const source of [
        'https:example.com/v3/index.json?sig=token',
        'http:\\\\example.com\\v3\\index.json?sig=token',
        'https://[fe80::1%25eth0]:invalid/v3/index.json?sig=token',
        'https://example host/v3/index.json?sig=token',
    ]) {
        test(`new allows malformed HTTP-shaped source "${source}" to match the CLI policy`, async () => {
            configuredNugetSource = source;

            await newCommand(createTerminalProvider());

            assert.deepStrictEqual(sentCommands, [{
                subcommand: 'new',
                additionalArgs: ['--source', configuredNugetSource]
            }]);
            assert.strictEqual(showErrorMessageStub.called, false);
        });
    }

    test('add rejects an invalid nuget source before resolving the apphost', async () => {
        configuredNugetSource = 'https://example.com/v3/index.json?sig=token';

        await assert.rejects(
            () => addCommand(createTerminalProvider(), createEditorCommandProvider()),
            vscode.CancellationError);

        assert.strictEqual(getAppHostPathCallCount, 0);
        assert.deepStrictEqual(sentCommands, []);
        assert.deepStrictEqual(showErrorMessageStub.firstCall.args, [invalidSourceMessage]);
    });
});
