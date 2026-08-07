import * as assert from 'assert';

import { getSupportedCapabilities } from '../capabilities';

suite('Capabilities', () => {
    test('AppHost build ownership advertises only the v2 capability', () => {
        const capabilities: readonly string[] = getSupportedCapabilities();

        assert.deepStrictEqual(
            capabilities.filter(capability => capability.startsWith('build-dotnet-using-cli')),
            ['build-dotnet-using-cli.v2']);
    });
});
