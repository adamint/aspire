import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extensionLogOutputChannel } from './logging';
import { getCmdShimSpawnCommand, isCommandShimPath, shouldWrapWithCmd } from './cmdShim';

const execFileAsync = promisify(execFile);
const fsAccessAsync = promisify(fs.access);

/**
 * Gets the default installation paths for the Aspire CLI, in priority order.
 *
 * The CLI can be installed through the bundle installer or as a .NET global
 * tool. Windows global tools expose an aspire.cmd shim and may use
 * DOTNET_CLI_HOME to redirect their install directory.
 *
 * @returns An array of default CLI paths to check, ordered by priority
 */
export function getDefaultCliInstallPaths(): string[] {
    const homeDir = os.homedir();
    const bundleInstallDirectory = path.join(homeDir, '.aspire', 'bin');

    // This fix targets Windows command shims. Keep POSIX discovery unchanged so
    // DOTNET_CLI_HOME cannot unexpectedly change its existing default path.
    if (process.platform === 'win32') {
        // .NET global tools use DOTNET_CLI_HOME as their home directory when set.
        // https://learn.microsoft.com/dotnet/core/tools/dotnet-environment-variables#dotnet_cli_home
        const dotnetCliHome = process.env.DOTNET_CLI_HOME || homeDir;
        const globalToolDirectory = path.join(dotnetCliHome, '.dotnet', 'tools');
        return [
            // Bundle install (recommended): ~/.aspire/bin/aspire.exe
            path.join(bundleInstallDirectory, 'aspire.exe'),
            // .NET global tools can expose a command shim instead of a native executable.
            path.join(globalToolDirectory, 'aspire.cmd'),
            path.join(globalToolDirectory, 'aspire.exe'),
        ];
    }

    const globalToolDirectory = path.join(homeDir, '.dotnet', 'tools');
    return [
        // Bundle install (recommended): ~/.aspire/bin/aspire
        path.join(bundleInstallDirectory, 'aspire'),
        // .NET global tool: ~/.dotnet/tools/aspire
        path.join(globalToolDirectory, 'aspire'),
    ];
}

function areCliPathsEqual(left: string, right: string): boolean {
    if (process.platform !== 'win32') {
        // Preserve the existing POSIX behavior: only paths the extension wrote
        // byte-for-byte are considered auto-configured. A normalized equivalent
        // may have been an intentional user pin.
        return left === right;
    }

    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function containsCliPath(paths: readonly string[], candidate: string): boolean {
    return paths.some(defaultPath => areCliPathsEqual(defaultPath, candidate));
}

function getLegacyAutoConfiguredCliPaths(): string[] {
    const homeDir = os.homedir();
    const executableName = process.platform === 'win32' ? 'aspire.exe' : 'aspire';
    return [
        path.join(homeDir, '.aspire', 'bin', executableName),
        path.join(homeDir, '.dotnet', 'tools', executableName),
    ];
}

/**
 * Checks if a file exists and is accessible.
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fsAccessAsync(filePath, fs.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * Test seam for the process launch performed by {@link tryExecuteCli}.
 */
export type CliProbeExecutor = (
    command: string,
    args: string[],
    options: { timeout: number; windowsVerbatimArguments?: boolean },
) => Promise<unknown>;

const defaultProbeExecutor: CliProbeExecutor = (command, args, options) => execFileAsync(command, args, options);

/**
 * Tries to execute the CLI at the given path to verify it works.
 */
export async function tryExecuteCli(cliPath: string, execute: CliProbeExecutor = defaultProbeExecutor): Promise<boolean> {
    try {
        if (shouldWrapWithCmd(cliPath)) {
            // Reuse the spawn path's cmd.exe wrapper. Passing the shim as a plain argv entry
            // is not enough: libuv only auto-quotes arguments containing a space, tab, or
            // quote, so a shim under a directory such as `C:\Users\a&b\.dotnet\tools` reaches
            // cmd.exe unquoted and gets split at the `&`, rejecting a working CLI.
            const { command, args, windowsVerbatimArguments } = getCmdShimSpawnCommand(cliPath, ['--version']);
            await execute(command, args, { timeout: 5000, windowsVerbatimArguments });
        }
        else {
            await execute(cliPath, ['--version'], { timeout: 5000 });
        }

        return true;
    }
    catch {
        return false;
    }
}

/**
 * The configured path that CLI resolution most recently rejected as unusable.
 *
 * `getForwardableAspireCliPath` reads the raw setting independently of resolution, so a
 * configured file that exists but fails to execute would still be forwarded as
 * `AspireCliPath` after resolution fell back to a different CLI. `ResolveAspireCliBundle`
 * stops at an explicit `AspireCliPath` instead of probing PATH, so the AppHost would be
 * stamped with bundle paths belonging to a CLI that never ran.
 */
let rejectedConfiguredCliPath: string | undefined;

/**
 * Reports whether CLI resolution rejected this configured path and fell back to a
 * different CLI. Such a path must not be forwarded as `AspireCliPath`.
 */
export function isConfiguredCliPathRejectedForForwarding(configuredPath: string): boolean {
    return rejectedConfiguredCliPath !== undefined && rejectedConfiguredCliPath === configuredPath;
}

/** Test seam that clears the rejected-configured-path state between cases. */
export function resetRejectedConfiguredCliPathForForwarding(): void {
    rejectedConfiguredCliPath = undefined;
}

/**
 * Checks if the Aspire CLI is available on the system PATH.
 */
export async function isCliOnPath(): Promise<boolean> {
    return await tryExecuteCli('aspire');
}

/**
 * Finds the first default installation path where the Aspire CLI exists and is executable.
 *
 * @returns The path where CLI was found, or undefined if not found at any default location
 */
export async function findCliAtDefaultPath(): Promise<string | undefined> {
    for (const defaultPath of getDefaultCliInstallPaths()) {
        if (await fileExists(defaultPath) && await tryExecuteCli(defaultPath)) {
            return defaultPath;
        }
    }

    return undefined;
}

/**
 * Gets the VS Code configuration setting for the Aspire CLI path.
 */
export function getConfiguredCliPath(): string {
    return vscode.workspace.getConfiguration('aspire').get<string>('aspireCliExecutablePath', '').trim();
}

/**
 * Updates the VS Code configuration setting for the Aspire CLI path.
 * Uses ConfigurationTarget.Global to set it at the user level.
 */
export async function setConfiguredCliPath(cliPath: string): Promise<void> {
    extensionLogOutputChannel.info(`Setting aspire.aspireCliExecutablePath to: ${cliPath || '(empty)'}`);
    await vscode.workspace.getConfiguration('aspire').update(
        'aspireCliExecutablePath',
        cliPath || undefined, // Use undefined to remove the setting
        vscode.ConfigurationTarget.Global
    );
}

/**
 * Result of checking CLI availability.
 */
export interface CliPathResolutionResult {
    /** The resolved CLI path to use */
    cliPath: string;
    /** Whether the CLI is available */
    available: boolean;
    /** Where the CLI was found */
    source: 'path' | 'default-install' | 'configured' | 'not-found';
}

/**
 * Dependencies for resolveCliPath that can be overridden for testing.
 */
export interface CliPathDependencies {
    getConfiguredPath: () => string;
    getDefaultPaths: () => string[];
    isOnPath: () => Promise<boolean>;
    findAtDefaultPath: () => Promise<string | undefined>;
    tryExecute: (cliPath: string) => Promise<boolean>;
    setConfiguredPath: (cliPath: string) => Promise<void>;
}

const defaultDependencies: CliPathDependencies = {
    getConfiguredPath: getConfiguredCliPath,
    // Only paths that older extension versions could have written to the
    // setting are safe to treat as automatically configured.
    getDefaultPaths: getLegacyAutoConfiguredCliPaths,
    isOnPath: isCliOnPath,
    findAtDefaultPath: findCliAtDefaultPath,
    tryExecute: tryExecuteCli,
    setConfiguredPath: setConfiguredCliPath,
};

/**
 * Resolves the Aspire CLI path, checking multiple locations in order:
 * 1. E2E runner-provided CLI path
 * 2. User-configured path in VS Code settings
 * 3. System PATH
 * 4. Default installation directories (bundle and .NET global-tool locations)
 * 5. A still-valid legacy auto-configured path
 *
 * If the CLI is found at a native default installation path but not on PATH,
 * the VS Code setting is updated to use that path. Command shims are discovered
 * on demand instead so an explicit shim setting remains distinguishable. When
 * current discovery supersedes a legacy auto-configured setting with a path we
 * intentionally do not persist, the old setting is cleared so it cannot keep
 * forwarding a different CLI bundle through AspireCliPath.
 *
 * If the CLI is on PATH and a setting was previously auto-configured to a default path,
 * the setting is cleared to prefer PATH.
 */
export async function resolveCliPath(deps: CliPathDependencies = defaultDependencies): Promise<CliPathResolutionResult> {
    const configuredPath = deps.getConfiguredPath();
    const defaultPaths = deps.getDefaultPaths();
    const configuredPathIsLegacyDefault = configuredPath !== '' && containsCliPath(defaultPaths, configuredPath);
    const e2eCliPath = process.env.ASPIRE_EXTENSION_E2E_CLI_PATH?.trim();

    if (e2eCliPath) {
        const isValid = await deps.tryExecute(e2eCliPath);
        if (isValid) {
            return { cliPath: e2eCliPath, available: true, source: 'configured' };
        }

        extensionLogOutputChannel.warn(`E2E CLI path is invalid: ${e2eCliPath}`);
    }

    // Check if user has configured a custom path (not one of the defaults)
    if (configuredPath && (!configuredPathIsLegacyDefault || isCommandShimPath(configuredPath))) {
        const isValid = await deps.tryExecute(configuredPath);
        if (isValid) {
            rejectedConfiguredCliPath = undefined;
            return { cliPath: configuredPath, available: true, source: 'configured' };
        }

        extensionLogOutputChannel.warn(`Configured CLI path is invalid: ${configuredPath}`);
        // Everything below this point resolves a different CLI. The setting is kept so an
        // explicit user pin is not silently erased, but it must stop being forwarded as
        // AspireCliPath, otherwise MSBuild resolves bundle assets from the CLI that failed.
        extensionLogOutputChannel.warn('Suppressing AspireCliPath forwarding for the rejected configured CLI path');
        rejectedConfiguredCliPath = configuredPath;
        // Continue to check other locations
    }
    else {
        rejectedConfiguredCliPath = undefined;
    }

    // 2. Check if CLI is on PATH
    const onPath = await deps.isOnPath();
    if (onPath) {
        // If we previously auto-set the path to a default install location, clear it
        // since PATH is now working
        if (configuredPathIsLegacyDefault) {
            extensionLogOutputChannel.info('Clearing aspireCliExecutablePath setting since CLI is on PATH');
            await deps.setConfiguredPath('');
        }

        return { cliPath: 'aspire', available: true, source: 'path' };
    }

    // 3. Check default installation paths (~/.aspire/bin first, then ~/.dotnet/tools)
    const foundPath = await deps.findAtDefaultPath();
    if (foundPath) {
        // The setting does not record who wrote it, so persist only paths that
        // older versions already recognized as automatic defaults. Newly added
        // discovery locations remain distinguishable from explicit user pins.
        if (!areCliPathsEqual(configuredPath, foundPath)) {
            if (containsCliPath(defaultPaths, foundPath) && !isCommandShimPath(foundPath)) {
                extensionLogOutputChannel.info('Updating aspireCliExecutablePath setting to use default install location');
                await deps.setConfiguredPath(foundPath);
            }
            else if (configuredPathIsLegacyDefault) {
                // The extension will execute foundPath, while the configured setting is independently
                // forwarded as AspireCliPath for MSBuild bundle resolution. Leaving a legacy setting here
                // could therefore run one CLI while stamping AppHosts with another CLI's bundle paths.
                extensionLogOutputChannel.info('Clearing superseded auto-configured aspireCliExecutablePath setting');
                await deps.setConfiguredPath('');
            }
        }

        return { cliPath: foundPath, available: true, source: 'default-install' };
    }

    // A legacy extension version may have persisted a default path that is no
    // longer part of current discovery (for example after DOTNET_CLI_HOME is
    // redirected). Keep it as the final fallback without letting it outrank a
    // working PATH or current install location.
    if (configuredPathIsLegacyDefault && await deps.tryExecute(configuredPath)) {
        return { cliPath: configuredPath, available: true, source: 'default-install' };
    }

    // CLI not found anywhere
    return { cliPath: 'aspire', available: false, source: 'not-found' };
}
