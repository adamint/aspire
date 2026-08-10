import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isBrowserLaunchConfiguration } from "../../dcp/types";
import { browserDisplayName, browserLabel, firefoxDebuggerNotInstalled, invalidLaunchConfiguration } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";
import { firefoxDebugAdapterType, isFirefoxDebuggerInstalled, promptToInstallFirefoxDebugger } from "../firefoxDebugger";

const browserRuntimeArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode'
];

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

        debugConfiguration.type = getBrowserDebugAdapter(launchConfig.browser);
        if (debugConfiguration.type === firefoxDebugAdapterType && !isFirefoxDebuggerInstalled()) {
            promptToInstallFirefoxDebugger();
            throw new Error(firefoxDebuggerNotInstalled);
        }
        debugConfiguration.request = 'launch';
        debugConfiguration.url = launchConfig.url;
        debugConfiguration.webRoot = launchConfig.web_root;
        debugConfiguration.sourceMaps = true;
        debugConfiguration.resolveSourceMapLocations = ['**', '!**/node_modules/**'];

        if (debugConfiguration.type === firefoxDebugAdapterType) {
            // vscode-firefox-debug uses reAttach to decide whether stopping a debug session should
            // leave Firefox running. Aspire owns this launch, so a workspace setting must not turn
            // resource termination into an adapter-only disconnect.
            debugConfiguration.reAttach = false;
            delete debugConfiguration.runtimeArgs;
            delete debugConfiguration.userDataDir;

            if (!debugConfiguration.webRoot) {
                debugConfiguration.pathMappings ??= [];
            }
        }
        else {
            // Let js-debug create and clean up the isolated profile. A workspace-provided profile
            // path or command-line override would make Aspire stop a session without necessarily
            // owning the browser instance that was launched.
            debugConfiguration.userDataDir = true;
            debugConfiguration.runtimeArgs = mergeRuntimeArgs(debugConfiguration.runtimeArgs);
        }

        // Remove program/args/cwd since browser debugging doesn't use them
        delete debugConfiguration.program;
        delete debugConfiguration.args;
        delete debugConfiguration.cwd;
    }
};

function getBrowserDebugAdapter(browser: string | undefined): string {
    const normalizedBrowser = browser?.trim().toLowerCase();

    switch (normalizedBrowser) {
        case 'firefox':
        case 'mozilla-firefox':
            return firefoxDebugAdapterType;
        case 'chrome':
        case 'google-chrome':
        case 'chromium':
            return 'pwa-chrome';
        case undefined:
        case '':
        case 'edge':
        case 'msedge':
        case 'microsoft-edge':
        case 'microsoftedge':
            return 'pwa-msedge';
        default:
            return normalizedBrowser.startsWith('pwa-') ? normalizedBrowser : `pwa-${normalizedBrowser}`;
    }
}

function mergeRuntimeArgs(runtimeArgs: unknown): string[] {
    const existing = (Array.isArray(runtimeArgs) ? runtimeArgs : typeof runtimeArgs === 'string' ? [runtimeArgs] : [])
        .filter((arg): arg is string => typeof arg === 'string');
    const merged: string[] = [];

    for (let i = 0; i < existing.length; i++) {
        const arg = existing[i];
        if (!isUserDataDirArg(arg)) {
            merged.push(arg);
            continue;
        }

        // Chromium accepts both `--user-data-dir=/path` and
        // `--user-data-dir /path`; remove the separate value as well.
        if (!arg.includes('=') && i + 1 < existing.length && !existing[i + 1].startsWith('-')) {
            i++;
        }
    }

    for (const arg of browserRuntimeArgs) {
        if (!merged.includes(arg)) {
            merged.push(arg);
        }
    }

    return merged;
}

function isUserDataDirArg(arg: string): boolean {
    const switchName = arg.split('=', 1)[0].trim();

    return switchName === '--user-data-dir' || switchName === '-user-data-dir';
}
