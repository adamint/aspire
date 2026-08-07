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
    // js-debug is a server-hosted adapter shared across debug sessions, so its adapter exit is not
    // a per-run signal, and it tears down child target sessions (page/worker) independently of the
    // root session. The end of the root VS Code debug session is the only reliable run lifetime
    // signal, so AspireDebugSession reports termination for browser runs.
    terminationSignal: 'debug-session-end',
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
        const userDataDir = await createBrowserUserDataDir(debugConfiguration.runId);
        if (userDataDir) {
            debugConfiguration.userDataDir = userDataDir;
            // Only a path that createBrowserUserDataDir() created itself, inside a profile root it
            // verified, ever reaches this recursive delete. That function is the single gate for
            // both the launch argument and the cleanup, so the two can never disagree about which
            // directory Aspire owns.
            registerRunCleanup(debugConfiguration.runId, () => {
                void fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(error => {
                    extensionLogOutputChannel.warn(`Failed to delete browser debug profile directory '${userDataDir}': ${error instanceof Error ? error.message : String(error)}`);
                });
            });
        }
        else {
            // Fail closed: run without an isolated profile rather than pointing the browser at, or
            // aiming a recursive delete at, a directory Aspire does not own. js-debug falls back to
            // its own default profile, so debugging still works and only profile isolation is lost.
            extensionLogOutputChannel.warn(`Could not create a contained browser debug profile directory for run '${debugConfiguration.runId}'; launching without an isolated profile.`);
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
 * Creates the isolated browser profile directory for a run, or returns `undefined` when a directory
 * Aspire can safely own could not be established.
 *
 * The directory is created here rather than left for the browser to create lazily, because creating
 * it is what makes it safe. `os.tmpdir()` is shared and world-writable on Linux, so
 * `aspire-vscode-browser-debug` is a name any other local process can create first — including as a
 * symlink. The browser follows `userDataDir` when it writes, so a symlinked root would quietly
 * redirect profile data (which holds cookies and tokens for the app being debugged) into a
 * directory chosen by that process, and a symlink pre-created at a guessable child path would do
 * the same. Deriving and validating a path string cannot detect either, because both are decided
 * by whoever wins the race to create the directory.
 */
async function createBrowserUserDataDir(runId: string): Promise<string | undefined> {
    const root = getBrowserProfileRoot();

    try {
        // 0o700 keeps other local users out of profiles this process creates. `recursive: true` does
        // not fail when the path already exists and does not re-apply the mode to an existing entry,
        // so the inspection below is what decides whether an existing entry can be trusted.
        await fs.mkdir(root, { recursive: true, mode: 0o700 });

        // lstat, not stat: it reports on the link itself rather than following it, which is the
        // whole point of the check.
        const rootStats = await fs.lstat(root);
        if (!rootStats.isDirectory()) {
            extensionLogOutputChannel.warn(`Browser debug profile root '${root}' is not a real directory; refusing to use it.`);

            return undefined;
        }

        // process.getuid is undefined on Windows, where %TEMP% is per-user and this ownership model
        // does not apply.
        if (typeof process.getuid === 'function' && rootStats.uid !== process.getuid()) {
            extensionLogOutputChannel.warn(`Browser debug profile root '${root}' is owned by another user; refusing to use it.`);

            return undefined;
        }

        // mkdtemp creates the leaf atomically with an unpredictable suffix. A symlink pre-created at
        // the child path cannot win the race, because creation fails outright instead of following
        // an existing entry. See https://nodejs.org/api/fs.html#fspromisesmkdtempprefix-options.
        // The run id is only a readability prefix here; it is no longer what makes the path unique.
        const created = await fs.mkdtemp(path.join(root, `${sanitizeRunIdSegment(runId)}-`));

        // Defense in depth. The prefix above is sanitized and suffixed, so it cannot traverse on its
        // own, but this directory is deleted recursively when the run ends and that delete must
        // never be aimed outside the tree Aspire owns.
        if (!isWithinBrowserProfileRoot(created)) {
            extensionLogOutputChannel.warn(`Refusing to use browser debug profile directory '${created}' because it is outside '${root}'.`);

            return undefined;
        }

        return created;
    }
    catch (error) {
        extensionLogOutputChannel.warn(`Failed to create a browser debug profile directory under '${root}': ${error instanceof Error ? error.message : String(error)}`);

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
 * The comparison is lexical and case-sensitive. On a case-insensitive filesystem a differently
 * cased path would be rejected rather than accepted, which is the safe direction; both sides are
 * built from the same `os.tmpdir()` and the same constant, so this does not occur in practice.
 * Symlinks are handled by `createBrowserUserDataDir` creating the directory itself, which is
 * stronger than resolving them here would be.
 */
function isWithinBrowserProfileRoot(candidate: string): boolean {
    const relative = path.relative(getBrowserProfileRoot(), candidate);

    return relative.length > 0
        && !relative.startsWith(`..${path.sep}`)
        && relative !== '..'
        && !path.isAbsolute(relative);
}
