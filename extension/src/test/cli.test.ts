import * as assert from 'assert';
import { withCliLogOutputChannelArgs } from '../debugger/languages/cli';

suite('debugger/languages/cli tests', () => {
    test('adds logging args when none are provided', () => {
        assert.deepStrictEqual(withCliLogOutputChannelArgs(), ['--debug', '--no-log-file']);
    });

    test('inserts logging args before the forwarded app args delimiter', () => {
        const args = ['run', '--apphost', '/repo/AppHost.csproj', '--', '--applicationArg'];

        assert.deepStrictEqual(withCliLogOutputChannelArgs(args), ['run', '--apphost', '/repo/AppHost.csproj', '--debug', '--no-log-file', '--', '--applicationArg']);
    });

    test('does not duplicate logging args that are already present before the delimiter', () => {
        const args = ['run', '--debug', '--no-log-file', '--', '--applicationArg'];

        assert.deepStrictEqual(withCliLogOutputChannelArgs(args), args);
    });

    test('adds only the missing logging arg before the delimiter', () => {
        const args = ['run', '--debug', '--', '--applicationArg'];

        assert.deepStrictEqual(withCliLogOutputChannelArgs(args), ['run', '--debug', '--no-log-file', '--', '--applicationArg']);
    });
});
