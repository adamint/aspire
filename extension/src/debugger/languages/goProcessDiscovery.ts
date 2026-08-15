import * as childProcess from 'child_process';
import * as vscode from 'vscode';

export interface GoProcessInfo {
    readonly pid: number;
    readonly parentPid: number;
    readonly executable: string;
    readonly command: string;
}

export interface GoProcessQuery {
    listProcesses(cancellationToken?: vscode.CancellationToken, timeoutMs?: number): Promise<readonly GoProcessInfo[]>;
}

export interface GoProcessDiscoveryClock {
    now(): number;
    sleep(milliseconds: number, cancellationToken?: vscode.CancellationToken): Promise<void>;
}

export interface GoApplicationProcessResolver {
    resolveApplicationPid(goProcessId: number, cancellationToken?: vscode.CancellationToken): Promise<number>;
}

export interface GoProcessCommandRunner {
    run(command: string, args: readonly string[], cancellationToken?: vscode.CancellationToken, timeoutMs?: number): Promise<string>;
}

const goBuildExecutablePattern = /(?:^|[\\/])go-build[^\\/\s]*(?:[\\/][^\\/\s]+)*[\\/]exe[\\/][^\\/\s]+(?:\.exe)?(?:\s|$)/i;
const maxProcessListingLength = 1024 * 1024;
const windowsProcessQuery = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

export function parsePosixProcessList(output: string): readonly GoProcessInfo[] {
    const processes: GoProcessInfo[] = [];

    for (const line of output.split(/\r?\n/)) {
        // `ps -axo pid=,ppid=,comm=,args=` produces rows such as:
        //   42 10 /private/.../go-build123/b001/exe/api /private/.../go-build123/b001/exe/api --port 8080
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

export function parseWindowsProcessList(output: string): readonly GoProcessInfo[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    }
    catch {
        throw createProcessDiscoveryError();
    }

    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const processes: GoProcessInfo[] = [];
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

export class GoRunApplicationProcessResolver implements GoApplicationProcessResolver {
    private static readonly _defaultTimeoutMs = 5_000;
    private static readonly _defaultRetryDelayMs = 100;

    constructor(
        private readonly _processQuery: GoProcessQuery,
        private readonly _clock: GoProcessDiscoveryClock = systemGoProcessDiscoveryClock,
        options: { readonly timeoutMs?: number; readonly retryDelayMs?: number } = {},
    ) {
        this._timeoutMs = options.timeoutMs ?? GoRunApplicationProcessResolver._defaultTimeoutMs;
        this._retryDelayMs = options.retryDelayMs ?? GoRunApplicationProcessResolver._defaultRetryDelayMs;
    }

    private readonly _timeoutMs: number;
    private readonly _retryDelayMs: number;

    async resolveApplicationPid(goProcessId: number, cancellationToken?: vscode.CancellationToken): Promise<number> {
        if (!isValidPid(goProcessId)) {
            throw createProcessDiscoveryError();
        }

        const timeoutMs = Math.max(1, this._timeoutMs);
        const retryDelayMs = Math.max(1, this._retryDelayMs);
        const deadline = this._clock.now() + timeoutMs;
        const maximumAttempts = Math.max(2, Math.ceil(timeoutMs / retryDelayMs) + 1);
        let previousCandidate: number | undefined;

        for (let attempt = 0; attempt < maximumAttempts; attempt++) {
            throwIfCancelled(cancellationToken);

            let processes: readonly GoProcessInfo[];
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

            const candidate = findGoBuildApplicationDescendant(goProcessId, processes);
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

export class SystemGoProcessQuery implements GoProcessQuery {
    constructor(
        private readonly _platform: NodeJS.Platform = process.platform,
        private readonly _commandRunner: GoProcessCommandRunner = new SystemGoProcessCommandRunner(),
    ) {
    }

    async listProcesses(cancellationToken?: vscode.CancellationToken, timeoutMs?: number): Promise<readonly GoProcessInfo[]> {
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

class SystemGoProcessCommandRunner implements GoProcessCommandRunner {
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
            const stop = () => {
                // Discovery owns this short-lived `ps` or PowerShell child only. Never signal the
                // resource's `go run` process or any descendant while resolving an attach target.
                if (!process.killed) {
                    process.kill();
                }
            };
            const fail = () => {
                stop();
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

const systemGoProcessDiscoveryClock: GoProcessDiscoveryClock = {
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

export const goRunApplicationProcessResolver: GoApplicationProcessResolver =
    new GoRunApplicationProcessResolver(new SystemGoProcessQuery());

function createProcessInfo(pidValue: unknown, parentPidValue: unknown, executableValue: unknown, commandValue: unknown): GoProcessInfo | undefined {
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

function findGoBuildApplicationDescendant(goProcessId: number, processes: readonly GoProcessInfo[]): number | undefined {
    const processById = new Map<number, GoProcessInfo>();
    const childrenByParentId = new Map<number, GoProcessInfo[]>();
    for (const process of processes) {
        if (!isValidPid(process.pid) || !Number.isInteger(process.parentPid) || process.parentPid < 0 || processById.has(process.pid)) {
            return undefined;
        }

        processById.set(process.pid, process);
        const children = childrenByParentId.get(process.parentPid) ?? [];
        children.push(process);
        childrenByParentId.set(process.parentPid, children);
    }

    const goProcess = processById.get(goProcessId);
    if (!goProcess || !isGoToolProcess(goProcess)) {
        return undefined;
    }

    const candidates: number[] = [];
    const descendants = [...(childrenByParentId.get(goProcessId) ?? [])];
    for (let index = 0; index < descendants.length; index++) {
        const descendant = descendants[index];
        if (isGoBuildApplication(descendant)) {
            candidates.push(descendant.pid);
        }

        descendants.push(...(childrenByParentId.get(descendant.pid) ?? []));
    }

    return candidates.length === 1 ? candidates[0] : undefined;
}

function isGoBuildApplication(process: GoProcessInfo): boolean {
    return goBuildExecutablePattern.test(process.executable) || goBuildExecutablePattern.test(process.command);
}

function isGoToolProcess(process: GoProcessInfo): boolean {
    const executableName = process.executable.split(/[\\/]/).pop()?.toLowerCase();
    return executableName === 'go' || executableName === 'go.exe';
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
    return new Error('Unable to resolve the running Go application process.');
}
