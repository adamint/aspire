import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isBrowserLaunchConfiguration } from "../../dcp/types";
import { browserDisplayName, browserLabel, firefoxDebuggerNotInstalled, invalidLaunchConfiguration } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";
import { firefoxDebugAdapterType, isFirefoxDebuggerInstalled, promptToInstallFirefoxDebugger } from "../firefoxDebugger";
import { registerRunCleanup } from "../runCleanupRegistry";

const defaultBrowserRuntimeArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode'
];

/** Root under the OS temp directory that holds one isolated browser profile per run. */
const browserProfileRootDirectoryName = 'aspire-vscode-browser-debug';

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
    createDebugSessionConfigurationCallback: async (launchConfig, _args, _env, launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<void> => {
        if (!isBrowserLaunchConfiguration(launchConfig)) {
            extensionLogOutputChannel.info(`The resource type was not browser for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        if (!launchConfig.url) {
            extensionLogOutputChannel.info(`Browser launch configuration did not include a URL for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        debugConfiguration.type = getBrowserDebugAdapter(launchConfig.browser);
        // The `firefox` adapter is not built into VS Code; it comes from the
        // firefox-devtools.vscode-firefox-debug extension. If it is missing, VS Code would
        // fail to start the session with only a generic "debug session failed to start"
        // error, so detect it here and surface an actionable install prompt instead.
        if (debugConfiguration.type === firefoxDebugAdapterType && !isFirefoxDebuggerInstalled()) {
            promptToInstallFirefoxDebugger();
            throw new Error(firefoxDebuggerNotInstalled);
        }
        debugConfiguration.request = 'launch';
        debugConfiguration.url = launchConfig.url;
        debugConfiguration.webRoot = launchConfig.web_root;
        debugConfiguration.sourceMaps = true;
        debugConfiguration.resolveSourceMapLocations = ['**', '!**/node_modules/**'];
        debugConfiguration.runtimeArgs = mergeRuntimeArgs(debugConfiguration.runtimeArgs, defaultBrowserRuntimeArgs);
        const userDataDir = getBrowserUserDataDir(debugConfiguration.runId);
        if (userDataDir) {
            debugConfiguration.userDataDir = userDataDir;
            // Only a path that getBrowserUserDataDir() proved is inside the profile root ever reaches
            // this recursive delete; that check is the single gate for both the launch argument and
            // the cleanup, so the two can never disagree about which directory Aspire owns.
            registerRunCleanup(debugConfiguration.runId, () => {
                void fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(error => {
                    extensionLogOutputChannel.warn(`Failed to delete browser debug profile directory '${userDataDir}': ${error instanceof Error ? error.message : String(error)}`);
                });
            });
        }
        else {
            // Fail closed: run without an isolated profile rather than aiming a recursive delete at a
            // directory Aspire does not own. js-debug falls back to its own default profile, so
            // debugging still works and only profile isolation is lost.
            extensionLogOutputChannel.warn(`Could not derive a contained browser debug profile directory for run '${debugConfiguration.runId}'; launching without an isolated profile.`);
        }
        // Browser/js-debug child sessions do not provide a reliable DAP onExit
        // lifetime signal. Keep debugSessionId so adapterTracker still forwards
        // browser output as service logs, and let AspireDebugSession send the DCP
        // termination notification from the VS Code root session end event.
        debugConfiguration.sessionTermination = { kind: 'debugSessionEnd', dcpId: launchOptions.debugSessionId };

        // Remove program/args/cwd since browser debugging doesn't use them
        delete debugConfiguration.program;
        delete debugConfiguration.args;
        delete debugConfiguration.cwd;
    }
};

function getBrowserDebugAdapter(browser: string | undefined): string {
    const normalizedBrowser = browser?.trim().toLowerCase();
    switch (normalizedBrowser) {
        case undefined:
        case '':
        case 'edge':
        case 'msedge':
        case 'microsoft-edge':
        case 'microsoftedge':
            return 'pwa-msedge';
        case 'chrome':
        case 'google-chrome':
        case 'chromium':
            return 'pwa-chrome';
        case 'firefox':
        case 'mozilla-firefox':
            return firefoxDebugAdapterType;
        default:
            return normalizedBrowser.startsWith('pwa-') ? normalizedBrowser : `pwa-${normalizedBrowser}`;
    }
}

function mergeRuntimeArgs(existingRuntimeArgs: unknown, argsToAdd: string[]): string[] {
    const runtimeArgs = Array.isArray(existingRuntimeArgs)
        ? existingRuntimeArgs.filter((arg): arg is string => typeof arg === 'string')
        : typeof existingRuntimeArgs === 'string' ? [existingRuntimeArgs] : [];

    for (const arg of argsToAdd) {
        if (!runtimeArgs.includes(arg)) {
            runtimeArgs.push(arg);
        }
    }

    return runtimeArgs;
}

function getBrowserUserDataDir(runId: string): string | undefined {
    // Only reject characters that are unsafe in a path segment. `.` and `-` are deliberately kept
    // because run ids legitimately contain them, which is exactly why sanitizing alone is not a
    // containment guarantee: `..` and `.` survive this replacement untouched.
    const runSegment = runId.replace(/[^a-zA-Z0-9._-]/g, '-');
    const candidate = path.resolve(getBrowserProfileRoot(), runSegment);
    if (!isWithinBrowserProfileRoot(candidate)) {
        return undefined;
    }

    return candidate;
}

function getBrowserProfileRoot(): string {
    return path.resolve(os.tmpdir(), browserProfileRootDirectoryName);
}

/**
 * Returns whether `candidate` is a strict descendant of the browser profile root.
 *
 * This directory tree is deleted recursively when a run ends, so the path handed to `fs.rm` has to
 * be provably inside the directory Aspire owns. `path.relative` is used rather than a string prefix
 * test so `..` segments are resolved instead of merely matched, and the root itself is rejected as
 * well as anything above it — deleting the root would wipe the profiles of other concurrent runs.
 *
 * Two deliberate limits:
 * - The comparison is lexical and case-sensitive. On a case-insensitive filesystem a differently
 *   cased path would be rejected rather than accepted, which is the safe direction; both sides are
 *   built from the same `os.tmpdir()` and the same constant, so this does not occur in practice.
 * - Symlinks are not resolved (the directory usually does not exist yet when the configuration is
 *   built, so `fs.realpath` is not an option). That is safe here because `fs.rm` does not follow a
 *   symlink at the path it is given: removing a symlinked directory entry removes the link and
 *   leaves the target intact. See https://nodejs.org/api/fs.html#fspromisesrmpath-options.
 */
function isWithinBrowserProfileRoot(candidate: string): boolean {
    const relative = path.relative(getBrowserProfileRoot(), candidate);

    return relative.length > 0
        && !relative.startsWith(`..${path.sep}`)
        && relative !== '..'
        && !path.isAbsolute(relative);
}
