import * as assert from 'assert';
import * as sinon from 'sinon';
import { createAspireMcpServerDefinition } from '../mcp/AspireMcpServerDefinitionProvider';

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
                'call',
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
                'call',
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
                'call',
                'C:\\Program Files\\a&b\\aspire.cmd',
                'agent',
                'mcp',
            ]);
        });
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
