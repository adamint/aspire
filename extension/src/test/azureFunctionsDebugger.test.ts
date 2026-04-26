import * as assert from 'assert';
import { getAzureFunctionsHostStartArgs } from '../debugger/languages/azureFunctions';

suite('Azure Functions Debugger Extension Tests', () => {
    test('adds no-build when suppress build is true', () => {
        assert.deepStrictEqual(
            getAzureFunctionsHostStartArgs(['--port', '52341'], true),
            ['--port', '52341', '--no-build']);
    });

    test('does not add no-build when suppress build is false', () => {
        assert.deepStrictEqual(
            getAzureFunctionsHostStartArgs(['--port', '52341'], false),
            ['--port', '52341']);
    });

    test('does not add no-build when suppress build is undefined', () => {
        assert.deepStrictEqual(
            getAzureFunctionsHostStartArgs(['--port', '52341'], undefined),
            ['--port', '52341']);
    });

    test('does not duplicate no-build', () => {
        assert.deepStrictEqual(
            getAzureFunctionsHostStartArgs(['--port', '52341', '--no-build'], true),
            ['--port', '52341', '--no-build']);
    });

    test('handles missing args', () => {
        assert.deepStrictEqual(
            getAzureFunctionsHostStartArgs(undefined, true),
            ['--no-build']);
    });
});
