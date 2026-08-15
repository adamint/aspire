import * as childProcess from 'child_process';
import * as vscode from 'vscode';

export interface LaunchedChildProcess {
    readonly pid: number;
    readonly parentPid: number;
    readonly executable: string;
    readonly command: string;
}

export interface LaunchedChildProcessQuery {
    listProcesses(cancellationToken?: vscode.CancellationToken, timeoutMs?: number): Promise<readonly LaunchedChildProcess[]>;
}

export interface LaunchedChildProcessClock {
    now(): number;
    sleep(milliseconds: number, cancellationToken?: vscode.CancellationToken): Promise<void>;
}

export interface LaunchedChildProcessIdentity {
    isLauncher(process: LaunchedChildProcess): boolean;
    isCandidate(process: LaunchedChildProcess): boolean;
}

export interface LaunchedChildProcessCommandRunner {
    run(command: string, args: readonly string[], cancellationToken?: vscode.CancellationToken, timeoutMs?: number): Promise<string>;
}

const maxProcessListingLength = 1024 * 1024;
const windowsProcessQuery = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

export function parsePosixProcessList(output: string): readonly LaunchedChildProcess[] {
    const processes: LaunchedChildProcess[] = [];

    for (const line of output.split(/\r?\n/)) {
        // `ps -axo pid=,ppid=,comm=,args=` produces rows such as:
        //   42 10 /private/.../app /private/.../app --port 8080
        // The command can contain spaces, so only split the first three fixed fields.
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?\s*$/.exec(line);
        if (!match) {
            continue;
        }

        const process = createProcessInfo(match[1], match[2], match[3], match[4] ?? match[3]);
        if (process) {
            processes.push(process);
        }
    }

    return processes;
}

export function parseWindowsProcessList(output: string): readonly LaunchedChildProcess[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    }
    catch {
        throw createProcessDiscoveryError();
    }

    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const processes: LaunchedChildProcess[] = [];
    for (const row of rows) {
        if (typeof row !== 'object' || row === null) {
            continue;
        }

        const values = row as Record<string, unknown>;
        const process = createProcessInfo(
            values.ProcessId,
            values.ParentProcessId,
            typeof values.ExecutablePath === 'string' && values.ExecutablePath.length > 0
                ? values.ExecutablePath
                : values.Name,
            values.CommandLine);
        if (process) {
            processes.push(process);
        }
    }

    return processes;
}

export function getProcessCommandProgram(command: string): string | undefined {
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

export class LaunchedChildProcessResolver {
    private static readonly _defaultTimeoutMs = 5_000;
    private static readonly _defaultRetryDelayMs = 100;

    constructor(
        private readonly _processQuery: LaunchedChildProcessQuery,
        private readonly _clock: LaunchedChildProcessClock = systemLaunchedChildProcessClock,
        options: { readonly timeoutMs?: number; readonly retryDelayMs?: number } = {},
    ) {
        this._timeoutMs = options.timeoutMs ?? LaunchedChildProcessResolver._defaultTimeoutMs;
        this._retryDelayMs = options.retryDelayMs ?? LaunchedChildProcessResolver._defaultRetryDelayMs;
    }

    private readonly _timeoutMs: number;
    private readonly _retryDelayMs: number;

    async resolveProcessId(
        launcherPid: number,
        identity: LaunchedChildProcessIdentity,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<number> {
        if (!isValidPid(launcherPid)) {
            throw createProcessDiscoveryError();
        }

        const timeoutMs = Math.max(1, this._timeoutMs);
        const retryDelayMs = Math.max(1, this._retryDelayMs);
        const deadline = this._clock.now() + timeoutMs;
        const maximumAttempts = Math.max(2, Math.ceil(timeoutMs / retryDelayMs) + 1);
        let previousCandidate: number | undefined;

        for (let attempt = 0; attempt < maximumAttempts; attempt++) {
            throwIfCancelled(cancellationToken);

            let processes: readonly LaunchedChildProcess[];
            try {
                processes = await this._processQuery.listProcesses(
                    cancellationToken,
                    Math.max(1, deadline - this._clock.now()));
            }
            catch (error) {
                if (error instanceof vscode.CancellationError || cancellationToken?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                throw createProcessDiscoveryError();
            }

            throwIfCancelled(cancellationToken);

            let candidate: number | undefined;
            try {
                candidate = findMatchingDescendant(launcherPid, identity, processes);
            }
            catch {
                throw createProcessDiscoveryError();
            }

            if (candidate !== undefined && candidate === previousCandidate) {
                return candidate;
            }

            previousCandidate = candidate;
            const remainingTimeMs = deadline - this._clock.now();
            if (remainingTimeMs <= 0 || attempt === maximumAttempts - 1) {
                break;
            }

            try {
                await this._clock.sleep(Math.min(retryDelayMs, remainingTimeMs), cancellationToken);
            }
            catch (error) {
                if (error instanceof vscode.CancellationError || cancellationToken?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                throw createProcessDiscoveryError();
            }
        }

        throw createProcessDiscoveryError();
    }
}

export class SystemLaunchedChildProcessQuery implements LaunchedChildProcessQuery {
    constructor(
        private readonly _platform: NodeJS.Platform = process.platform,
        private readonly _commandRunner: LaunchedChildProcessCommandRunner = new SystemLaunchedChildProcessCommandRunner(),
    ) {
    }

    async listProcesses(cancellationToken?: vscode.CancellationToken, timeoutMs?: number): Promise<readonly LaunchedChildProcess[]> {
        const output = this._platform === 'win32'
            ? await this._commandRunner.run(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsProcessQuery],
                cancellationToken,
                timeoutMs)
            : await this._commandRunner.run(
                'ps',
                ['-axo', 'pid=,ppid=,comm=,args='],
                cancellationToken,
                timeoutMs);

        return this._platform === 'win32'
            ? parseWindowsProcessList(output)
            : parsePosixProcessList(output);
    }
}

class SystemLaunchedChildProcessCommandRunner implements LaunchedChildProcessCommandRunner {
    run(command: string, args: readonly string[], cancellationToken?: vscode.CancellationToken, timeoutMs = 1_000): Promise<string> {
        return new Promise((resolve, reject) => {
            let completed = false;
            let cancellationRegistration: vscode.Disposable | undefined;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let output = '';
            const process = childProcess.spawn(command, args, {
                stdio: 'pipe',
                windowsHide: true,
            });

            const complete = (action: () => void) => {
                if (completed) {
                    return;
                }

                completed = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                cancellationRegistration?.dispose();
                action();
            };
            const fail = () => {
                // Discovery owns this short-lived `ps` or PowerShell child only. Never signal the
                // launched workload or any descendant while resolving an attach target.
                if (!process.killed) {
                    process.kill();
                }
                complete(() => reject(createProcessDiscoveryError()));
            };

            process.stdout.setEncoding('utf8');
            process.stdout.on('data', (chunk: string) => {
                if (output.length + chunk.length > maxProcessListingLength) {
                    fail();
                    return;
                }

                output += chunk;
            });
            // Drain stderr so a failed fixed query cannot block on a full pipe. Its contents may
            // include command text and are intentionally neither logged nor returned.
            process.stderr.resume();
            process.on('error', fail);
            process.on('close', exitCode => {
                if (exitCode === 0) {
                    complete(() => resolve(output));
                }
                else {
                    complete(() => reject(createProcessDiscoveryError()));
                }
            });

            cancellationRegistration = cancellationToken?.onCancellationRequested(fail);
            timeout = setTimeout(fail, Math.max(1, timeoutMs));
            if (cancellationToken?.isCancellationRequested) {
                fail();
            }
        });
    }
}

const systemLaunchedChildProcessClock: LaunchedChildProcessClock = {
    now: () => Date.now(),
    sleep: (milliseconds, cancellationToken) => new Promise<void>((resolve, reject) => {
        if (cancellationToken?.isCancellationRequested) {
            reject(new vscode.CancellationError());
            return;
        }

        let cancellationRegistration: vscode.Disposable | undefined;
        const timeout = setTimeout(() => {
            cancellationRegistration?.dispose();
            resolve();
        }, milliseconds);
        cancellationRegistration = cancellationToken?.onCancellationRequested(() => {
            clearTimeout(timeout);
            cancellationRegistration?.dispose();
            reject(new vscode.CancellationError());
        });
    }),
};

export const launchedChildProcessResolver = new LaunchedChildProcessResolver(
    new SystemLaunchedChildProcessQuery());

function createProcessInfo(pidValue: unknown, parentPidValue: unknown, executableValue: unknown, commandValue: unknown): LaunchedChildProcess | undefined {
    const pid = parsePid(pidValue);
    const parentPid = parseParentPid(parentPidValue);
    const executable = typeof executableValue === 'string' ? executableValue.trim() : '';
    const command = typeof commandValue === 'string' ? commandValue.trim() : '';
    if (pid === undefined || parentPid === undefined || executable.length === 0) {
        return undefined;
    }

    return {
        pid,
        parentPid,
        executable,
        command: command.length > 0 ? command : executable,
    };
}

function findMatchingDescendant(
    launcherPid: number,
    identity: LaunchedChildProcessIdentity,
    processes: readonly LaunchedChildProcess[],
): number | undefined {
    const processById = new Map<number, LaunchedChildProcess>();
    const childrenByParentId = new Map<number, LaunchedChildProcess[]>();
    for (const process of processes) {
        if (!isValidPid(process.pid) || !Number.isInteger(process.parentPid) || process.parentPid < 0 || processById.has(process.pid)) {
            return undefined;
        }

        processById.set(process.pid, process);
        const children = childrenByParentId.get(process.parentPid) ?? [];
        children.push(process);
        childrenByParentId.set(process.parentPid, children);
    }

    const launcher = processById.get(launcherPid);
    if (!launcher || !identity.isLauncher(launcher)) {
        return undefined;
    }

    const candidates: number[] = [];
    const descendants = [...(childrenByParentId.get(launcherPid) ?? [])];
    const visitedProcessIds = new Set([launcherPid]);
    for (let index = 0; index < descendants.length; index++) {
        const descendant = descendants[index];
        if (visitedProcessIds.has(descendant.pid)) {
            return undefined;
        }

        visitedProcessIds.add(descendant.pid);
        if (identity.isCandidate(descendant)) {
            candidates.push(descendant.pid);
        }

        descendants.push(...(childrenByParentId.get(descendant.pid) ?? []));
    }

    return candidates.length === 1 ? candidates[0] : undefined;
}

function parsePid(value: unknown): number | undefined {
    if (typeof value === 'number' && isValidPid(value)) {
        return value;
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    const pid = Number(value);
    return isValidPid(pid) ? pid : undefined;
}

function parseParentPid(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        return value;
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    const pid = Number(value);
    return Number.isInteger(pid) && pid >= 0 ? pid : undefined;
}

function isValidPid(value: number): boolean {
    return Number.isInteger(value) && value > 0;
}

function throwIfCancelled(cancellationToken?: vscode.CancellationToken): void {
    if (cancellationToken?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

function createProcessDiscoveryError(): Error {
    return new Error('Unable to resolve the running application process.');
}
