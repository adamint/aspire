import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isBrowserLaunchConfiguration } from "../../dcp/types";
import { browserDisplayName, browserLabel, invalidLaunchConfiguration, unsupportedBrowserDebugTarget } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";

/**
 * Browsers VS Code's built-in js-debug can debug, mapped to the debug type it registers.
 *
 * `WithBrowserDebugger(browser)` on the hosting side accepts an arbitrary string, so an unmapped
 * value would otherwise be forwarded as `pwa-<value>` and fail inside VS Code with an opaque
 * "Configured debug type is not supported" once the session is already starting. js-debug only
 * contributes `pwa-chrome` and `pwa-msedge` for browsers:
 * https://github.com/microsoft/vscode-js-debug/blob/main/package.json
 *
 * A `Map` rather than an object literal because the lookup key is attacker-influenced data from the
 * AppHost: an object literal inherits `Object.prototype`, so `toString`, `constructor`, `__proto__`
 * and friends would resolve to inherited members and slip past the allowlist as a non-string debug
 * type. `Map` has no such inherited keys.
 */
const browserDebugTypesByName: ReadonlyMap<string, string> = new Map([
    ['msedge', 'pwa-msedge'],
    ['chrome', 'pwa-chrome'],
]);

export const browserDebuggerExtension: ResourceDebuggerExtension = {
    resourceType: 'browser',
    debugAdapter: 'pwa-msedge',
    extensionId: null, // built-in to VS Code via js-debug
    getDisplayName: (launchConfiguration: ExecutableLaunchConfiguration) => {
        if (isBrowserLaunchConfiguration(launchConfiguration) && launchConfiguration.url) {
            return browserDisplayName(launchConfiguration.url);
        }
        return browserLabel;
    },
    getSupportedFileTypes: () => [],
    getProjectFile: () => '',
    createDebugSessionConfigurationCallback: async (launchConfig, _args, _env, _launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<void> => {
        if (!isBrowserLaunchConfiguration(launchConfig)) {
            extensionLogOutputChannel.info(`The resource type was not browser for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        // Map browser name to VS Code js-debug adapter type (pwa- prefix required)
        // `??` rather than `||`: only an absent browser (an older AppHost that does not send the
        // field) should fall back to the default. An explicit empty string is a value the caller
        // chose, and it is no more supported than 'safari' would be, so it has to reach the
        // allowlist check and be rejected instead of silently launching Edge.
        const browser = launchConfig.browser ?? 'msedge';
        const debugType = browserDebugTypesByName.get(browser);
        if (!debugType) {
            extensionLogOutputChannel.warn(`No built-in js-debug adapter is registered for browser '${browser}'.`);
            // The toast this becomes only carries the message, and a run ID means nothing to a
            // user staring at several browser resources. The URL is the one field of a browser
            // launch configuration a user recognises; fall back to the run ID when the AppHost
            // sent no URL, which is the only identifier left.
            const resource = launchConfig.url?.trim() || debugConfiguration.runId;
            throw new Error(unsupportedBrowserDebugTarget(browser, resource, [...browserDebugTypesByName.keys()].join(', ')));
        }

        debugConfiguration.type = debugType;
        debugConfiguration.request = 'launch';
        debugConfiguration.url = launchConfig.url;
        // The hosting side defaults web_root to an empty string when the resource has no web root.
        // js-debug treats any non-empty webRoot as a real path and resolves source maps against it,
        // so a whitespace-only value is as broken as an empty one - it just happens to be truthy.
        // Trim only to decide whether the value is blank; forward the original. Leading and trailing
        // spaces are valid characters in a POSIX path, so trimming the forwarded value would silently
        // redirect a web root such as '/workspace/frontend ' to a different directory. This matches
        // how `browser` above is handled: validate what was sent, relay it unchanged.
        if (launchConfig.web_root?.trim()) {
            debugConfiguration.webRoot = launchConfig.web_root;
        }

        debugConfiguration.sourceMaps = true;
        debugConfiguration.resolveSourceMapLocations = ['**', '!**/node_modules/**'];
        // Use an auto-managed temp user data directory so multiple browser debuggers
        // can run concurrently without conflicting
        debugConfiguration.userDataDir = true;

        // Remove program/args/cwd since browser debugging doesn't use them
        delete debugConfiguration.program;
        delete debugConfiguration.args;
        delete debugConfiguration.cwd;
    }
};
