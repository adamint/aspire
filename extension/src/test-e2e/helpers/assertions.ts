import * as fs from 'fs';
import * as path from 'path';
import type { AspireAppHostState as AppHostState, AspireDebugSessionState, AspireExtensionE2EControlStatus as ExtensionE2EControlStatus, AspireExtensionE2EStateFile as ExtensionE2EStateFile, AspireExtensionStateSnapshot as ExtensionStateSnapshot, AspireResourceState as ResourceState } from '../../types/extensionApi';
import { getControlFilePath, getPrimaryAppHostProjectPath, getStateFilePath, getWorkspaceRoot } from './paths';

type CommandInvocation = ExtensionE2EStateFile['commandInvocations'][number];

let controlRevision = Date.now();
let workspaceFolderOpenPromise: Promise<void> | undefined;

export async function waitForRepositoryIdle(timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => file.state.isWorkspaceAppHostDiscoveryComplete && !file.state.isRepositoryLoading, 'repository to become idle', timeoutMs);
}

export async function waitForWorkspaceAppHost(timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    await ensureWorkspaceFolderOpen();
    return await waitForExtensionState(file => file.state.workspaceAppHostCandidatePaths.some(candidate => isSamePath(candidate, getPrimaryAppHostProjectPath())), 'workspace AppHost candidate', timeoutMs);
}

export async function waitForSelectedWorkspaceAppHost(appHostPath = getPrimaryAppHostProjectPath(), timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    await ensureWorkspaceFolderOpen();
    return await waitForExtensionState(
        file => file.state.workspaceAppHostPath !== undefined && isSamePath(file.state.workspaceAppHostPath, appHostPath),
        `selected workspace AppHost '${appHostPath}'`,
        timeoutMs);
}

export async function waitForRunningAppHost(timeoutMs = 180000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => findRunningAppHost(file.state) !== undefined, 'running AppHost', timeoutMs);
}

export async function waitForNoRunningAppHost(timeoutMs = 90000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => findRunningAppHost(file.state) === undefined && file.state.launchingPaths.length === 0, 'AppHost to stop', timeoutMs);
}

export async function waitForResource(resourceName: string, timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => getResources(file.state).some(resource => (resource.displayName ?? resource.name) === resourceName), `resource '${resourceName}'`, timeoutMs);
}

export async function waitForResourceState(resourceName: string, states: readonly string[], timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => getResources(file.state).some(resource => (resource.displayName ?? resource.name) === resourceName && resource.state !== null && states.includes(resource.state)), `resource '${resourceName}' state ${states.join(' or ')}`, timeoutMs);
}

export async function waitForDashboardUrl(timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => typeof file.dashboardUrl === 'string' && file.dashboardUrl.length > 0, 'dashboard URL', timeoutMs);
}

export async function waitForDebugSessionStartup(appHostPath = getPrimaryAppHostProjectPath(), timeoutMs = 180000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => file.state.debugSessions.some(session => isDebugSessionForAppHost(session, appHostPath) && session.startupCompleted), 'debug AppHost startup', timeoutMs);
}

export async function waitForDebugDashboardUrl(appHostPath = getPrimaryAppHostProjectPath(), timeoutMs = 120000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => file.state.debugSessions.some(session => isDebugSessionForAppHost(session, appHostPath) && typeof session.dashboardUrl === 'string' && session.dashboardUrl.length > 0), 'debug dashboard URL', timeoutMs);
}

export async function waitForNoDebugSessions(timeoutMs = 90000): Promise<ExtensionE2EStateFile> {
    return await waitForExtensionState(file => file.state.debugSessions.length === 0, 'debug sessions to stop', timeoutMs);
}

export async function waitForCommandOutcome(command: string, outcome: CommandInvocation['outcome'], timeoutMs = 60000, afterInvocationCount = 0): Promise<CommandInvocation> {
    const file = await waitForExtensionState(stateFile => stateFile.commandInvocations.filter(event => event.command === command).slice(afterInvocationCount).some(event => event.outcome === outcome), `${command} ${outcome} outcome`, timeoutMs);
    const event = file.commandInvocations.filter(event => event.command === command).slice(afterInvocationCount).find(candidate => candidate.outcome === outcome);
    if (!event) {
        throw new Error(`Command '${command}' did not produce '${outcome}' even though the state predicate matched.`);
    }

    return event;
}

export function getCommandInvocationCount(command?: string): number {
    const file = readStateFile();
    return command
        ? file.commandInvocations.filter(event => event.command === command).length
        : file.commandInvocations.length;
}

export async function waitForTerminalCommand(
    predicate: (event: ExtensionE2EStateFile['terminalCommands'][number]) => boolean,
    description: string,
    timeoutMs = 60000,
    afterCommandCount = 0,
): Promise<ExtensionE2EStateFile['terminalCommands'][number]> {
    const file = await waitForExtensionState(stateFile => stateFile.terminalCommands.slice(afterCommandCount).some(predicate), description, timeoutMs);
    const event = file.terminalCommands.slice(afterCommandCount).find(predicate);
    if (!event) {
        throw new Error(`Terminal command '${description}' was not found even though the state predicate matched.`);
    }

    return event;
}

export function getTerminalCommandCount(): number {
    return readStateFile().terminalCommands.length;
}

export async function waitForDebugLaunch(
    predicate: (event: ExtensionE2EStateFile['debugLaunches'][number]) => boolean,
    description: string,
    timeoutMs = 60000,
    afterLaunchCount = 0,
): Promise<ExtensionE2EStateFile['debugLaunches'][number]> {
    const file = await waitForExtensionState(stateFile => stateFile.debugLaunches.slice(afterLaunchCount).some(predicate), description, timeoutMs);
    const event = file.debugLaunches.slice(afterLaunchCount).find(predicate);
    if (!event) {
        throw new Error(`Debug launch '${description}' was not found even though the state predicate matched.`);
    }

    return event;
}

export function getDebugLaunchCount(): number {
    return readStateFile().debugLaunches.length;
}

export function getTreeAppHostLabel(state: ExtensionStateSnapshot): string {
    return state.workspaceAppHostName ?? path.basename(getPrimaryAppHostProjectPath());
}

export function getResources(state: ExtensionStateSnapshot): readonly ResourceState[] {
    const runningAppHost = findRunningAppHost(state);
    return state.workspaceResources.length > 0 ? state.workspaceResources : runningAppHost?.resources ?? [];
}

export function findRunningAppHost(state: ExtensionStateSnapshot): AppHostState | undefined {
    const primaryAppHost = getPrimaryAppHostProjectPath();
    return state.workspaceAppHost && isSamePath(state.workspaceAppHost.appHostPath, primaryAppHost)
        ? state.workspaceAppHost
        : state.appHosts.find(appHost => isSamePath(appHost.appHostPath, primaryAppHost));
}

export async function waitForExtensionState(
    predicate: (file: ExtensionE2EStateFile) => boolean,
    description: string,
    timeoutMs = 60000,
): Promise<ExtensionE2EStateFile> {
    const started = Date.now();
    let lastState: string | undefined;
    let lastError: Error | undefined;

    while (Date.now() - started < timeoutMs) {
        try {
            const file = readStateFile();
            lastState = JSON.stringify(file, undefined, 2);
            if (predicate(file)) {
                return file;
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }

        await delay(200);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.\nLast error: ${lastError?.message ?? '<none>'}\nLast state: ${lastState ?? '<none>'}`);
}

export function readStateFile(): ExtensionE2EStateFile {
    return JSON.parse(fs.readFileSync(getStateFilePath(), 'utf8')) as ExtensionE2EStateFile;
}

async function ensureWorkspaceFolderOpen(): Promise<void> {
    workspaceFolderOpenPromise ??= ensureWorkspaceFolderOpenCore().catch(error => {
        workspaceFolderOpenPromise = undefined;
        throw error;
    });

    await workspaceFolderOpenPromise;
}

async function ensureWorkspaceFolderOpenCore(): Promise<void> {
    const expectedPath = getWorkspaceRoot();
    if (await tryWaitForWorkspaceFolder(expectedPath, 5000)) {
        return;
    }

    await applyE2eControl({ command: { name: 'openWorkspaceFolder', folderPath: expectedPath } }, 'started', 10000);
    if (await tryWaitForWorkspaceFolder(expectedPath, 120000)) {
        return;
    }

    const folders = await getWorkspaceFolders().catch(error => `failed to query workspace folders: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Timed out after 120000ms waiting for VS Code to open E2E workspace '${expectedPath}'. Last workspace folders: ${JSON.stringify(folders)}`);
}

async function tryWaitForWorkspaceFolder(expectedPath: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const folders = await getWorkspaceFolders().catch(() => []);
        if (folders.some(folder => folder.fileName && isSamePath(folder.fileName, expectedPath))) {
            return true;
        }

        await delay(200);
    }

    return false;
}

async function getWorkspaceFolders(): Promise<Array<{ fileName?: string }>> {
    const status = await applyE2eControl({ command: { name: 'getWorkspaceFolders' } }, 'applied', 10000);
    return Array.isArray(status.result) ? status.result as Array<{ fileName?: string }> : [];
}

export async function applyE2eControl(payload: Record<string, unknown>, waitFor: 'started' | 'applied' = 'applied', timeoutMs = 10000): Promise<ExtensionE2EControlStatus> {
    const controlFilePath = getControlFilePath();
    if (!controlFilePath) {
        return { revision: -1, status: 'applied' };
    }

    const revision = ++controlRevision;
    fs.writeFileSync(controlFilePath, JSON.stringify({ revision, ...payload }, undefined, 2));
    const stateFile = await waitForExtensionState(
        file => file.control?.revision === revision && (file.control.status === 'error' || file.control.status === 'applied' || (waitFor === 'started' && file.control.status === 'started')),
        `E2E control revision ${revision}`,
        timeoutMs);

    if (stateFile.control?.status === 'error') {
        throw new Error(`Failed to apply E2E control revision ${revision}: ${stateFile.control.errorMessage ?? '<unknown>'}`);
    }

    if (!stateFile.control) {
        throw new Error(`E2E control revision ${revision} completed without reporting status.`);
    }

    return stateFile.control;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isSamePath(left: string, right: string): boolean {
    const resolvedLeft = canonicalizePath(left);
    const resolvedRight = canonicalizePath(right);
    return process.platform === 'win32'
        ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
        : resolvedLeft === resolvedRight;
}

function canonicalizePath(value: string): string {
    const resolved = path.resolve(value);
    return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
}

function isDebugSessionForAppHost(session: AspireDebugSessionState, appHostPath: string): boolean {
    return session.appHostPath !== undefined && isSamePath(session.appHostPath, appHostPath);
}
