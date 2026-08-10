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

/** Prefix for Aspire-created browser profile directories under the OS temp directory. */
const browserProfileRootDirectoryName = 'aspire-vscode-browser-debug';

export const browserDebuggerExtension: ResourceDebuggerExtension = {
    resourceType: 'browser',
    debugAdapter: 'pwa-msedge',
    extensionId: null, // built-in to VS Code via js-debug
    // js-debug is a server-hosted adapter shared across debug sessions, so its adapter exit is not
    // a per-run signal, and it tears down child target sessions (page/worker) independently of the
    // root session. The end of the root VS Code debug session is the only reliable run lifetime
    // signal, so AspireDebugSession reports termination for browser runs.
    terminationSignal: 'debugSessionEnd',
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
        if (debugConfiguration.type === firefoxDebugAdapterType) {
            // `runtimeArgs` and `userDataDir` are js-debug (`pwa-*`) fields. The Firefox adapter
            // comes from firefox-devtools.vscode-firefox-debug, which owns its own profile
            // lifecycle when no `profile`/`profileDir` is supplied.
            //
            // They are deleted rather than merely left unset because the workspace `debuggers`
            // block is merged into this configuration before this callback runs, and unknown keys
            // are forwarded on purpose. Without this a workspace that configures Chromium options
            // would hand js-debug-only fields — including a `userDataDir` Aspire neither created
            // nor cleans up — to a foreign adapter on Firefox launches.
            delete debugConfiguration.runtimeArgs;
            delete debugConfiguration.userDataDir;

            // That adapter also refuses a launch configuration that has a `url` but neither
            // `webRoot` nor `pathMappings`:
            //   if (config.url) { if (!config.webRoot) {
            //       if ((config.request === 'launch') && !config.pathMappings) { throw `If you set
            //       "url" you also have to set "webRoot" or "pathMappings" ...`; } } }
            // https://github.com/firefox-devtools/vscode-firefox-debug/blob/master/src/adapter/configuration.ts
            // `web_root` is optional in the launch configuration Aspire receives, so without this the
            // session fails to start. An empty list satisfies the check without inventing a source root
            // that does not exist; the adapter still installs its own default `file://` mappings.
            if (!debugConfiguration.webRoot) {
                debugConfiguration.pathMappings ??= [];
            }
        }
        else {
            debugConfiguration.runtimeArgs = mergeRuntimeArgs(debugConfiguration.runtimeArgs, defaultBrowserRuntimeArgs);
            const userDataDir = await createBrowserUserDataDir(debugConfiguration.runId);
            if (userDataDir) {
                debugConfiguration.userDataDir = userDataDir;
                // Only a path that createBrowserUserDataDir() created itself, inside the temp root
                // it verified, ever reaches this recursive delete. That function is the single gate
                // for both the launch argument and the cleanup, so the two can never disagree about
                // which directory Aspire owns.
                registerRunCleanup(debugConfiguration.runId, () => {
                    void fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(error => {
                        extensionLogOutputChannel.warn(`Failed to delete browser debug profile directory '${userDataDir}': ${error instanceof Error ? error.message : String(error)}`);
                    });
                });
            }
            else {
                // Fail closed: drop any userDataDir rather than pointing the browser at, or aiming
                // a recursive delete at, a directory Aspire does not own. The delete matters
                // because the workspace `debuggers` block is merged into this configuration before
                // this callback runs: a workspace-supplied string would otherwise survive here and
                // js-debug would launch into that exact profile. With the field absent js-debug
                // creates its own isolated profile, so debugging still works and only Aspire's
                // ownership of the directory is lost.
                delete debugConfiguration.userDataDir;
                extensionLogOutputChannel.warn(`Could not create a contained browser debug profile directory for run '${debugConfiguration.runId}'; launching without an Aspire-owned profile.`);
            }
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

/**
 * Creates the isolated browser profile directory for a run, or returns `undefined` when one could
 * not be established.
 *
 * The run id is a readability prefix only. It is deliberately not what makes the path unique.
 * Today `runId` is generated in-process by `generateRunId` and `prepareDebugSession` refuses a
 * workspace-supplied value, so reducing it to a single path segment is defense in depth rather
 * than a boundary check. The post-creation realpath containment check is load-bearing for the same
 * reason: this path is later deleted recursively, so if a future change ever lets a `..` segment
 * through, the profile is refused rather than aiming cleanup at the temp directory or another run.
 */
async function createBrowserUserDataDir(runId: string): Promise<string | undefined> {
    try {
        const tempRoot = os.tmpdir();
        const created = await fs.mkdtemp(path.join(tempRoot, `${browserProfileRootDirectoryName}-${sanitizeRunIdSegment(runId)}-`));
        const tempRootRealPath = await fs.realpath(tempRoot);
        const createdRealPath = await fs.realpath(created);

        if (!isProperDescendant(tempRootRealPath, createdRealPath)) {
            extensionLogOutputChannel.warn(`Refusing to use browser debug profile directory '${created}' because its real path '${createdRealPath}' is outside '${tempRootRealPath}'.`);

            return undefined;
        }

        return created;
    }
    catch (error) {
        extensionLogOutputChannel.warn(`Failed to create a browser debug profile directory under '${os.tmpdir()}': ${error instanceof Error ? error.message : String(error)}`);

        return undefined;
    }
}

/**
 * Reduces a run id to a single safe path segment.
 *
 * Only characters that are unsafe in a path segment are replaced. `.` and `-` are deliberately kept
 * because run ids legitimately contain them, which is why sanitizing alone was never a containment
 * guarantee on its own: `..` and `.` survive this replacement untouched.
 */
function sanitizeRunIdSegment(runId: string): string {
    return runId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Returns whether `candidateRealPath` is a proper descendant of `parentRealPath`.
 *
 * `path.relative` is used rather than a string prefix test, and both inputs are real paths before
 * they get here. The parent itself is rejected as well as anything above it — the returned path is
 * deleted recursively, and deleting the parent would take every other profile directory with it.
 *
 * The comparison is lexical and case-sensitive. On a case-insensitive filesystem a differently
 * cased path would be rejected rather than accepted, which is the safe direction; both sides come
 * from `realpath`, so this does not occur in practice.
 */
function isProperDescendant(parentRealPath: string, candidateRealPath: string): boolean {
    const relative = path.relative(parentRealPath, candidateRealPath);

    return relative.length > 0
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}
