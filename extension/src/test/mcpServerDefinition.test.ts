import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireMcpServerDefinitionProvider, createAspireMcpServerDefinition } from '../mcp/AspireMcpServerDefinitionProvider';

function withWindows<T>(action: () => T): T {
    const platformStub = sinon.stub(process, 'platform').value('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    try {
        return action();
    }
    finally {
        platformStub.restore();

        if (originalComSpec === undefined) {
            delete process.env.ComSpec;
        }
        else {
            process.env.ComSpec = originalComSpec;
        }
    }
}

suite('AspireMcpServerDefinitionProvider definition tests', () => {
    test('wraps Windows command shims in cmd.exe so VS Code does not spawn them directly', () => {
        withWindows(() => {
            const definition = createAspireMcpServerDefinition('C:\\Users\\me\\.dotnet\\tools\\aspire.cmd');

            assert.strictEqual(definition.label, 'Aspire');
            assert.strictEqual(definition.command, 'C:\\Windows\\System32\\cmd.exe');
            assert.deepStrictEqual(definition.args, [
                '/d',
                '/v:off',
                '/c',
                'C:\\Users\\me\\.dotnet\\tools\\aspire.cmd',
                'agent',
                'mcp',
            ]);
        });
    });

    test('caret-escapes cmd.exe metacharacters that the spawn layer leaves unquoted', () => {
        withWindows(() => {
            // The MCP stdio launcher spawns without windowsVerbatimArguments, so libuv only
            // auto-quotes arguments containing a space, tab, or quote. A shim path with no
            // space reaches cmd.exe raw and must escape its own metacharacters.
            const definition = createAspireMcpServerDefinition('C:\\Users\\a&b\\.dotnet\\tools\\aspire.cmd');

            assert.deepStrictEqual(definition.args, [
                '/d',
                '/v:off',
                '/c',
                'C:\\Users\\a^&b\\.dotnet\\tools\\aspire.cmd',
                'agent',
                'mcp',
            ]);
        });
    });

    test('leaves shim paths containing spaces for the spawn layer to quote', () => {
        withWindows(() => {
            // libuv wraps this argument in quotes, which already makes '&' inert. Adding carets
            // here would leak literal '^' characters into the quoted path.
            const definition = createAspireMcpServerDefinition('C:\\Program Files\\a&b\\aspire.cmd');

            assert.deepStrictEqual(definition.args, [
                '/d',
                '/v:off',
                '/c',
                'C:\\Program Files\\a&b\\aspire.cmd',
                'agent',
                'mcp',
            ]);
        });
    });

    test('doubles percent signs before cmd.exe expands the shim path', () => {
        withWindows(() => {
            const definition = createAspireMcpServerDefinition('C:\\Users\\a%USERPROFILE%b\\.dotnet\\tools\\aspire.cmd');

            assert.deepStrictEqual(definition.args, [
                '/d',
                '/v:off',
                '/c',
                'C:\\Users\\a%%USERPROFILE%%b\\.dotnet\\tools\\aspire.cmd',
                'agent',
                'mcp',
            ]);
        });
    });

    test('executes MCP command shims from Windows metacharacter paths', function () {
        if (process.platform !== 'win32') {
            this.skip();
        }

        const variableName = 'ASPIRE_MCP_SHIM_PERCENT_TEST';
        const cases = [
            'aspire space-',
            'aspire&path-',
            'aspire^path-',
            'aspire(path)-',
            `aspire%${variableName}%-`,
        ];

        for (const prefix of cases) {
            const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
            try {
                const wrapperPath = path.join(tempDirectory, 'aspire.cmd');
                fs.writeFileSync(wrapperPath, [
                    '@echo off',
                    'if "%~1"=="agent" if "%~2"=="mcp" (',
                    '  echo MCP_OK',
                    '  exit /b 0',
                    ')',
                    'exit /b 1',
                    '',
                ].join('\r\n'));

                const definition = createAspireMcpServerDefinition(wrapperPath);
                const result = spawnSync(definition.command, definition.args, {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        [variableName]: 'EXPANDED',
                    },
                });

                assert.strictEqual(result.status, 0, `${prefix}: ${result.stderr}`);
                assert.strictEqual(result.stdout.trim(), 'MCP_OK', prefix);
            }
            finally {
                fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
            }
        }
    });

    test('passes native Windows executables through unwrapped', () => {
        withWindows(() => {
            const definition = createAspireMcpServerDefinition('C:\\Users\\me\\.aspire\\bin\\aspire.exe');

            assert.strictEqual(definition.command, 'C:\\Users\\me\\.aspire\\bin\\aspire.exe');
            assert.deepStrictEqual(definition.args, ['agent', 'mcp']);
        });
    });

    test('passes bare command names through unwrapped', () => {
        withWindows(() => {
            const definition = createAspireMcpServerDefinition('aspire');

            assert.strictEqual(definition.command, 'aspire');
            assert.deepStrictEqual(definition.args, ['agent', 'mcp']);
        });
    });

    test('does not wrap on non-Windows platforms', () => {
        const platformStub = sinon.stub(process, 'platform').value('linux');

        try {
            const definition = createAspireMcpServerDefinition('/home/me/.dotnet/tools/aspire');

            assert.strictEqual(definition.command, '/home/me/.dotnet/tools/aspire');
            assert.deepStrictEqual(definition.args, ['agent', 'mcp']);
        }
        finally {
            platformStub.restore();
        }
    });

    test('rejects shim paths containing terminal control characters', () => {
        withWindows(() => {
            assert.throws(() => createAspireMcpServerDefinition('C:\\tools\\asp\r\nire.cmd'));
        });
    });
});

suite('AspireMcpServerDefinitionProvider refresh tests', () => {
    let configChangeHandler: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    let configurationStub: sinon.SinonStub;
    let workspaceFoldersStub: sinon.SinonStub;

    setup(() => {
        configurationStub = sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(handler => {
            configChangeHandler = handler as (event: vscode.ConfigurationChangeEvent) => void;
            return { dispose: () => { } };
        });
        workspaceFoldersStub = sinon.stub(vscode.workspace, 'onDidChangeWorkspaceFolders').returns({ dispose: () => { } });
    });

    teardown(() => {
        configurationStub.restore();
        workspaceFoldersStub.restore();
    });

    test('refreshes when the configured CLI executable path changes', () => {
        const provider = new AspireMcpServerDefinitionProvider();
        const refresh = sinon.stub(provider, 'refresh').resolves();

        configChangeHandler!({
            affectsConfiguration: section => section === 'aspire.aspireCliExecutablePath',
        });

        assert.ok(refresh.calledOnce);
        provider.dispose();
    });
});
