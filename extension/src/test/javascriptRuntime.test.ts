import * as assert from 'assert';
import { getJavaScriptRuntimeDisplayName, getJavaScriptRuntimeTargetPath, jsRuntimeBaseFileTypes, launchMethodDirect, launchMethodPackageManager, resolveJavaScriptLaunchMethod } from '../debugger/languages/javascriptRuntime';
import { JavaScriptRuntimeLaunchConfiguration } from '../dcp/types';
import { nodeDisplayName, nodeLabel } from '../loc/strings';

suite('JavaScript Runtime Tests', () => {
    function config(launchMethod?: JavaScriptRuntimeLaunchConfiguration['launch_method']): JavaScriptRuntimeLaunchConfiguration {
        return {
            type: 'node',
            script_path: '/workspace/app/server.js',
            working_directory: '/workspace/app',
            launch_method: launchMethod
        };
    }

    test('explicit "package-manager" wins over an inferLegacy that returns "direct"', () => {
        const result = resolveJavaScriptLaunchMethod(config(launchMethodPackageManager), () => launchMethodDirect);

        assert.strictEqual(result, launchMethodPackageManager);
    });

    test('explicit "direct" wins over an inferLegacy that returns "package-manager"', () => {
        const result = resolveJavaScriptLaunchMethod(config(launchMethodDirect), () => launchMethodPackageManager);

        assert.strictEqual(result, launchMethodDirect);
    });

    test('undefined launch_method falls back to inferLegacy', () => {
        let inferred = false;
        const result = resolveJavaScriptLaunchMethod(config(undefined), () => {
            inferred = true;
            return launchMethodPackageManager;
        });

        assert.strictEqual(inferred, true);
        assert.strictEqual(result, launchMethodPackageManager);
    });

    test('unrecognized non-empty launch_method falls back to inferLegacy', () => {
        let inferred = false;
        // Cast through unknown because the contract type only permits the known values; this simulates
        // version skew where the hosting side emits a value the extension does not recognize.
        const drifted = { ...config(), launch_method: 'totally-bogus' as unknown as JavaScriptRuntimeLaunchConfiguration['launch_method'] };
        const result = resolveJavaScriptLaunchMethod(drifted, () => {
            inferred = true;
            return launchMethodDirect;
        });

        assert.strictEqual(inferred, true);
        assert.strictEqual(result, launchMethodDirect);
    });

    test('prefers the script path when resolving the debug target', () => {
        assert.strictEqual(getJavaScriptRuntimeTargetPath(config()), '/workspace/app/server.js');
    });

    test('falls back to the working directory when no script path is emitted', () => {
        assert.strictEqual(
            getJavaScriptRuntimeTargetPath({ type: 'node', working_directory: '/workspace/app' }),
            '/workspace/app');
    });

    test('resolves an empty target when neither script path nor working directory is emitted', () => {
        assert.strictEqual(getJavaScriptRuntimeTargetPath({ type: 'node' }), '');
    });

    test('names a matching runtime from its target path', () => {
        const displayName = getJavaScriptRuntimeDisplayName(config(), 'node', nodeDisplayName, nodeLabel);

        assert.strictEqual(displayName, nodeDisplayName('/workspace/app/server.js'));
    });

    test('names a matching runtime with no target as unknown rather than blank', () => {
        const displayName = getJavaScriptRuntimeDisplayName({ type: 'node' }, 'node', nodeDisplayName, nodeLabel);

        assert.strictEqual(displayName, nodeDisplayName('unknown'));
    });

    test('falls back to the runtime label when the configuration is for another runtime', () => {
        const displayName = getJavaScriptRuntimeDisplayName({ type: 'bun', script_path: '/workspace/app/server.ts' } as JavaScriptRuntimeLaunchConfiguration, 'node', nodeDisplayName, nodeLabel);

        assert.strictEqual(displayName, nodeLabel);
    });

    test('supports the JavaScript and TypeScript source extensions js-debug can map', () => {
        assert.deepStrictEqual(jsRuntimeBaseFileTypes, ['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']);
    });
});
