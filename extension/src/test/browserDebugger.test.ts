import * as assert from 'assert';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { browserDebuggerExtension } from '../debugger/languages/browser';
import { AspireResourceExtendedDebugConfiguration, BrowserLaunchConfiguration } from '../dcp/types';
import { unsupportedBrowserDebugTarget } from '../loc/strings';

suite('Browser Debugger Tests', () => {
    const fakeAspireDebugSession = {} as AspireDebugSession;
    const BROWSER_RESOURCE_URL = 'http://localhost:5173';

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

    // js-debug resolves source maps against any non-empty webRoot, so a whitespace-only value is
    // just as invalid a source-map root as an empty one - it is only truthy.
    for (const blankWebRoot of ['', '   ', '\t', '\n', ' \t\r\n ']) {
        test(`omits a blank web root ${JSON.stringify(blankWebRoot)} instead of forwarding it to js-debug`, async () => {
            const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173', web_root: blankWebRoot });

            assert.strictEqual('webRoot' in debugConfig, false);
        });
    }

    // Leading and trailing spaces are valid characters in a POSIX path, so a padded value is a
    // different directory rather than a sloppy spelling of the unpadded one. The trim decides only
    // whether the value is blank; rewriting what the AppHost sent would silently point js-debug at
    // a directory the AppHost never named.
    for (const paddedWebRoot of ['  /workspace/frontend/src\t', '/workspace/frontend ', ' /workspace/frontend']) {
        test(`forwards the web root ${JSON.stringify(paddedWebRoot)} unchanged instead of rewriting the path`, async () => {
            const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173', web_root: paddedWebRoot });

            assert.strictEqual(debugConfig.webRoot, paddedWebRoot);
        });
    }

    test('omits the web root when the AppHost does not send one', async () => {
        const debugConfig = await createConfiguration({ type: 'browser', url: 'http://localhost:5173' });

        assert.strictEqual('webRoot' in debugConfig, false);
    });

    test('rejects a browser that has no built-in js-debug adapter', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'browser', url: 'http://localhost:5173', browser: 'firefox' }),
            new RegExp(escapeForRegExp(unsupportedBrowserDebugTarget('firefox', BROWSER_RESOURCE_URL, 'msedge, chrome'))));
    });

    // The failure surfaces as a toast carrying only this message. An AppHost can declare several
    // browser resources, so a message naming just the offending value leaves the user with no way
    // to tell which resource to go and fix.
    test('names the resource that could not be debugged', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'browser', url: 'http://localhost:7654/admin', browser: 'firefox' }),
            (err: Error) => {
                assert.ok(
                    err.message.includes('http://localhost:7654/admin'),
                    `Unsupported-browser failure must identify the resource: ${err.message}`);
                return true;
            });
    });

    // Nothing guarantees the AppHost sends a URL. The run ID is a poor identifier, but it is the
    // only one left, and it is what the surrounding logs are keyed by.
    test('falls back to the run ID when the browser resource has no URL', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'browser', browser: 'firefox' }),
            (err: Error) => {
                assert.strictEqual(err.message, unsupportedBrowserDebugTarget('firefox', '1', 'msedge, chrome'));
                return true;
            });
    });

    // WithBrowserDebugger(string browser = "msedge") takes an arbitrary string, so an explicit
    // empty value is a caller choice and not an absent field. Falling back to the default for it
    // would silently launch Edge for a value the allowlist does not accept.
    test('rejects an explicitly empty browser instead of silently defaulting to Edge', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'browser', url: 'http://localhost:5173', browser: '' }),
            new RegExp(escapeForRegExp(unsupportedBrowserDebugTarget('', BROWSER_RESOURCE_URL, 'msedge, chrome'))));
    });

    test('rejects a whitespace-only browser', async () => {
        await assert.rejects(
            () => createConfiguration({ type: 'browser', url: 'http://localhost:5173', browser: '   ' }),
            new RegExp(escapeForRegExp(unsupportedBrowserDebugTarget('   ', BROWSER_RESOURCE_URL, 'msedge, chrome'))));
    });

    // An AppHost predating the `browser` field omits it entirely, and a null survives untyped
    // JSON. Both mean "not specified" and must keep the Edge default.
    for (const [label, absentBrowser] of [['undefined', undefined], ['null', null]] as const) {
        test(`defaults to Edge when the browser is ${label}`, async () => {
            const debugConfig = await createConfiguration({
                type: 'browser',
                url: 'http://localhost:5173',
                browser: absentBrowser as unknown as string | undefined,
            });

            assert.strictEqual(debugConfig.type, 'pwa-msedge');
        });
    }

    // The hosting side's WithBrowserDebugger accepts an arbitrary string, so the allowlist lookup must
    // not resolve inherited Object.prototype members. A plain object literal would hand back a
    // function for these names and assign it to debugConfiguration.type.
    for (const inheritedMember of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
        test(`rejects '${inheritedMember}' instead of resolving it through Object.prototype`, async () => {
            await assert.rejects(
                () => createConfiguration({ type: 'browser', url: 'http://localhost:5173', browser: inheritedMember }),
                new RegExp(escapeForRegExp(unsupportedBrowserDebugTarget(inheritedMember, BROWSER_RESOURCE_URL, 'msedge, chrome'))));
        });
    }

    test('leaves the debug type untouched when the browser is not on the allowlist', async () => {
        const debugConfig = createDebugConfig();
        const launchConfig: BrowserLaunchConfiguration = { type: 'browser', url: 'http://localhost:5173', browser: '__proto__' };

        await assert.rejects(() => browserDebuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            ['--ignored'],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig));

        assert.strictEqual(debugConfig.type, 'browser');
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
