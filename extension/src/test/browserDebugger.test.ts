import * as assert from 'assert';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { browserDebuggerExtension } from '../debugger/languages/browser';
import { AspireResourceExtendedDebugConfiguration, BrowserLaunchConfiguration } from '../dcp/types';
import { unsupportedBrowserDebugTarget } from '../loc/strings';

suite('Browser Debugger Tests', () => {
    const fakeAspireDebugSession = {} as AspireDebugSession;

    async function createConfiguration(launchConfig: BrowserLaunchConfiguration): Promise<AspireResourceExtendedDebugConfiguration> {
        const debugConfig = createDebugConfig();
        await browserDebuggerExtension.createDebugSessionConfigurationCallback!(launchConfig, ['--ignored'], [], { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession }, debugConfig);

        return debugConfig;
    }

    test('defaults to the built-in js-debug Edge adapter', async () => {
        const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173' });

        assert.strictEqual(debugConfig.type, 'pwa-msedge');
        assert.strictEqual(debugConfig.request, 'launch');
        assert.strictEqual(debugConfig.url, 'http://localhost:5173');
        assert.strictEqual(debugConfig.sourceMaps, true);
        assert.deepStrictEqual(debugConfig.resolveSourceMapLocations, ['**', '!**/node_modules/**']);
        assert.strictEqual(debugConfig.userDataDir, true);
    });

    test('maps chrome to the built-in js-debug Chrome adapter', async () => {
        const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173', browser: 'chrome' });

        assert.strictEqual(debugConfig.type, 'pwa-chrome');
    });

    test('drops process launch properties that browser debugging cannot use', async () => {
        const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173' });

        assert.strictEqual(debugConfig.program, undefined);
        assert.strictEqual(debugConfig.args, undefined);
        assert.strictEqual(debugConfig.cwd, undefined);
    });

    test('forwards a web root when the AppHost supplies one', async () => {
        const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173', web_root: '/workspace/frontend/src' });

        assert.strictEqual(debugConfig.webRoot, '/workspace/frontend/src');
    });

    test('omits an empty web root instead of forwarding it to js-debug', async () => {
        const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173', web_root: '' });

        assert.strictEqual('webRoot' in debugConfig, false);
    });

    test('rejects a browser that has no built-in js-debug adapter', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'browser', url: 'http://localhost:5173', browser: 'firefox' }),
            new RegExp(escapeForRegExp(unsupportedBrowserDebugTarget('firefox', 'msedge, chrome'))));
    });

    test('rejects a launch configuration for another resource type', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'node', script_path: '/workspace/app/server.js' } as unknown as BrowserLaunchConfiguration),
            /Invalid launch configuration/);
    });
});

function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createDebugConfig(): AspireResourceExtendedDebugConfiguration {
    return {
        runId: '1',
        debugSessionId: '1',
        type: 'browser',
        name: 'Browser',
        request: 'launch',
        program: '',
        args: ['--ignored'],
        cwd: '/workspace',
    };
}
