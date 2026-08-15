import * as assert from 'assert';
import type * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    LaunchedChildProcessResolver,
    parsePosixProcessList,
    parseWindowsProcessList,
    SystemLaunchedChildProcessQuery,
    SystemLaunchedChildProcessCommandRunner,
    type LaunchedChildProcess,
    type LaunchedChildProcessClock,
    type LaunchedChildProcessCommandRunner,
    type LaunchedChildProcessFileSystem,
    type LaunchedChildProcessIdentity,
    type LaunchedChildProcessQuery,
} from '../debugger/launchedChildProcessDiscovery';

class TestClock implements LaunchedChildProcessClock {
    private _now = 0;

    now(): number {
        return this._now;
    }

    async sleep(milliseconds: number, cancellationToken?: vscode.CancellationToken): Promise<void> {
        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        this._now += milliseconds;
    }
}

class SequenceProcessQuery implements LaunchedChildProcessQuery {
    private _index = 0;

    constructor(private readonly _snapshots: readonly (readonly LaunchedChildProcess[] | Error)[]) {
    }

    async listProcesses(): Promise<readonly LaunchedChildProcess[]> {
        const snapshot = this._snapshots[Math.min(this._index, this._snapshots.length - 1)];
        this._index++;
        if (snapshot instanceof Error) {
            throw snapshot;
        }

        return snapshot;
    }
}

function process(
    pid: number,
    parentPid: number,
    executable: string,
    command = executable,
    commandLineArguments?: readonly string[],
): LaunchedChildProcess {
    return {
        pid,
        parentPid,
        executable,
        command,
        ...(commandLineArguments ? { commandLineArguments } : {}),
    };
}

function createCommandProcess(): childProcess.ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as childProcess.ChildProcessWithoutNullStreams;
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => { } });
    const stderr = Object.assign(new EventEmitter(), { resume: sinon.stub() });
    Object.assign(child, {
        killed: false,
        stdout,
        stderr,
        kill: sinon.stub().callsFake(() => {
            (child as unknown as { killed: boolean }).killed = true;
            return true;
        }),
    });
    return child;
}

const identity: LaunchedChildProcessIdentity = {
    isLauncher: candidate => candidate.executable === '/tool/launcher',
    isCandidate: candidate => candidate.executable.includes('/target/'),
};

function createLinuxProcessQuery(
    commandRunner: LaunchedChildProcessCommandRunner,
    fileSystem: LaunchedChildProcessFileSystem,
): SystemLaunchedChildProcessQuery {
    return new SystemLaunchedChildProcessQuery('linux', commandRunner, fileSystem);
}

suite('Launched child process discovery', () => {
    teardown(() => sinon.restore());

    test('parses POSIX topology listings without process identity fields', () => {
        assert.deepStrictEqual(parsePosixProcessList([
            '  10     1',
            '  42    10',
            'not a process row',
        ].join('\n')), [
            process(10, 1, '', ''),
            process(42, 10, '', ''),
        ]);
    });

    test('parses Windows CIM process listings', () => {
        assert.deepStrictEqual(parseWindowsProcessList(JSON.stringify({
            ProcessId: 42,
            ParentProcessId: 10,
            Name: 'api.exe',
            ExecutablePath: 'C:\\target\\api.exe',
            CommandLine: 'C:\\target\\api.exe',
        })), [
            process(42, 10, 'C:\\target\\api.exe', 'C:\\target\\api.exe'),
        ]);
    });

    test('parses UTF-8 BOM-prefixed Windows CIM output with non-ASCII command text', () => {
        assert.deepStrictEqual(parseWindowsProcessList(`\uFEFF${JSON.stringify({
            ProcessId: 42,
            ParentProcessId: 10,
            Name: 'api.exe',
            ExecutablePath: 'C:\\target\\über api.exe',
            CommandLine: '"C:\\target\\über api.exe" --name "日本語"',
        })}`), [
            process(42, 10, 'C:\\target\\über api.exe', '"C:\\target\\über api.exe" --name "日本語"'),
        ]);
    });

    test('reads exact Linux process details from procfs without using truncated ps command output', async () => {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        const fileSystemCalls: string[] = [];
        const executablePath = '/repo/OneDrive - Microsoft/über-long-path/My Attach Service';
        const targetPath = '/repo/OneDrive - Microsoft/über-long-path/My Attach Service.dll';
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(command, args): Promise<string> {
                calls.push({ command, args });
                if (command === 'ps') {
                    if (args.join(' ') === '-axo pid=,ppid=') {
                        return '10 1\n42 10';
                    }

                    throw new Error(`Unexpected ps query: ${args.join(' ')}`);
                }

                return JSON.stringify({
                    ProcessId: 10,
                    ParentProcessId: 1,
                    Name: 'launcher.exe',
                    ExecutablePath: 'C:\\tool\\launcher.exe',
                    CommandLine: 'launcher --run',
                });
            },
        };
        const fileSystem: LaunchedChildProcessFileSystem = {
            async readlink(path): Promise<string> {
                fileSystemCalls.push(path);
                assert.strictEqual(path, '/proc/42/exe');
                return executablePath;
            },
            async readFile(path): Promise<Buffer> {
                fileSystemCalls.push(path);
                switch (path) {
                    case '/proc/42/cmdline':
                        return Buffer.from(['/usr/local/share/dotnet/dotnet', 'exec', targetPath, '', '--urls', 'http://localhost:5000'].join('\0') + '\0');
                    case '/proc/42/status':
                        return Buffer.from('Name:\tMy Attach Service\nPid:\t42\nPPid:\t10\nNSpid:\t42\n');
                    default:
                        throw new Error(`Unexpected procfs path: ${path}`);
                }
            },
        };

        const query = createLinuxProcessQuery(commandRunner, fileSystem);
        assert.deepStrictEqual(await query.listProcesses(), [
            process(10, 1, '', ''),
            process(42, 10, '', ''),
        ]);
        assert.deepStrictEqual(await query.getProcess(42), process(
            42,
            10,
            executablePath,
            `/usr/local/share/dotnet/dotnet exec ${targetPath}  --urls http://localhost:5000`,
            ['/usr/local/share/dotnet/dotnet', 'exec', targetPath, '', '--urls', 'http://localhost:5000']));
        await query.getProcess(42);
        await new SystemLaunchedChildProcessQuery('win32', commandRunner).listProcesses();

        assert.deepStrictEqual(calls, [
            {
                command: 'ps',
                args: ['-axo', 'pid=,ppid='],
            },
            {
                command: 'powershell.exe',
                args: [
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
                ],
            },
        ]);
        assert.deepStrictEqual(fileSystemCalls.sort(), [
            '/proc/42/cmdline',
            '/proc/42/cmdline',
            '/proc/42/exe',
            '/proc/42/exe',
            '/proc/42/status',
            '/proc/42/status',
        ]);
    });

    test('strips only the exact trailing Linux procfs deleted executable marker', async () => {
        const deletedExecutable = '/repo/bin/Debug/net10.0/Api (deleted)';
        const nonMarkerSuffix = `${deletedExecutable} after-restart`;
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(): Promise<string> {
                throw new Error('The process topology should not be queried.');
            },
        };
        const fileSystem: LaunchedChildProcessFileSystem = {
            async readlink(path): Promise<string> {
                switch (path) {
                    case '/proc/42/exe':
                        return deletedExecutable;
                    case '/proc/43/exe':
                        return nonMarkerSuffix;
                    default:
                        throw new Error(`Unexpected procfs path: ${path}`);
                }
            },
            async readFile(path): Promise<Buffer> {
                switch (path) {
                    case '/proc/42/cmdline':
                    case '/proc/43/cmdline':
                        return Buffer.from('/repo/bin/Debug/net10.0/Api\0');
                    case '/proc/42/status':
                    case '/proc/43/status':
                        return Buffer.from('Name:\tApi\nPPid:\t10\n');
                    default:
                        throw new Error(`Unexpected procfs path: ${path}`);
                }
            },
        };
        const query = createLinuxProcessQuery(commandRunner, fileSystem);

        assert.strictEqual((await query.getProcess(42))?.executable, '/repo/bin/Debug/net10.0/Api');
        assert.strictEqual((await query.getProcess(43))?.executable, nonMarkerSuffix);
    });

    test('observes rejecting procfs reads before returning an already requested cancellation', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();
        let unhandledRejection: unknown;
        const captureUnhandledRejection = (reason: unknown) => {
            unhandledRejection = reason;
        };
        globalThis.process.once('unhandledRejection', captureUnhandledRejection);
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(): Promise<string> {
                throw new Error('The process topology should not be queried.');
            },
        };
        const fileSystem: LaunchedChildProcessFileSystem = {
            readlink: () => Promise.reject(new Error('readlink failed')),
            readFile: () => Promise.reject(new Error('readFile failed')),
        };

        try {
            await assert.rejects(
                createLinuxProcessQuery(commandRunner, fileSystem).getProcess(42, cancellation.token),
                error => error instanceof vscode.CancellationError);
            await new Promise<void>(resolve => setImmediate(resolve));

            assert.strictEqual(unhandledRejection, undefined);
        }
        finally {
            globalThis.process.removeListener('unhandledRejection', captureUnhandledRejection);
            cancellation.dispose();
        }
    });

    test('resolves a macOS child with a spaced non-ASCII executable path from per-candidate ps details', async () => {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        const processDetails = new Map([
            [10, { parentPid: 1, executable: '/tool/launcher', command: '/tool/launcher --run' }],
            [42, {
                parentPid: 10,
                executable: '/repo/OneDrive - Microsoft/über-long-path/My Attach Service',
                command: '"/repo/OneDrive - Microsoft/über-long-path/My Attach Service" --urls http://localhost:5000',
            }],
        ]);
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(command, args): Promise<string> {
                calls.push({ command, args });
                assert.strictEqual(command, 'ps');
                if (args.join(' ') === '-axo pid=,ppid=') {
                    return '10 1\n42 10';
                }

                const processId = Number(args[1]);
                const details = processDetails.get(processId);
                if (!details) {
                    throw new Error(`Unexpected process ID: ${processId}`);
                }

                switch (args[args.length - 1]) {
                    case 'ppid=':
                        return String(details.parentPid);
                    case 'comm=':
                        return details.executable;
                    case 'args=':
                        return details.command;
                    default:
                        throw new Error(`Unexpected ps query: ${args.join(' ')}`);
                }
            },
        };
        const resolver = new LaunchedChildProcessResolver(
            new SystemLaunchedChildProcessQuery('darwin', commandRunner),
            new TestClock(),
            { timeoutMs: 100, retryDelayMs: 10 });
        const spacedTargetPath = '/repo/OneDrive - Microsoft/über-long-path/My Attach Service';
        const exactPathIdentity: LaunchedChildProcessIdentity = {
            requiresDirectChild: true,
            isLauncher: candidate => candidate.executable === '/tool/launcher',
            isCandidate: candidate => candidate.executable === spacedTargetPath,
        };

        assert.strictEqual(await resolver.resolveProcessId(10, exactPathIdentity), 42);
        assert.ok(calls.every(call => call.args.join(' ') !== '-axo pid=,ppid=,comm=,args='));
    });

    test('retries when a Linux candidate exits between topology and procfs reads', async () => {
        const targetPath = '/repo/OneDrive - Microsoft/über-long-path/My Attach Service.dll';
        let candidateReadAttempts = 0;
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(command, args): Promise<string> {
                assert.strictEqual(command, 'ps');
                assert.deepStrictEqual(args, ['-axo', 'pid=,ppid=']);
                return '10 1\n42 10';
            },
        };
        const fileSystem: LaunchedChildProcessFileSystem = {
            async readlink(path): Promise<string> {
                if (path === '/proc/42/exe') {
                    candidateReadAttempts++;
                    if (candidateReadAttempts === 1) {
                        throw new Error('Process exited.');
                    }

                    return '/usr/local/share/dotnet/dotnet';
                }

                assert.strictEqual(path, '/proc/10/exe');
                return '/tool/launcher';
            },
            async readFile(path): Promise<Buffer> {
                switch (path) {
                    case '/proc/10/cmdline':
                        return Buffer.from('/tool/launcher\0');
                    case '/proc/10/status':
                        return Buffer.from('Name:\tlauncher\nPPid:\t1\n');
                    case '/proc/42/cmdline':
                        return Buffer.from(`/usr/local/share/dotnet/dotnet\0exec\0${targetPath}\0`);
                    case '/proc/42/status':
                        return Buffer.from('Name:\tdotnet\nPPid:\t10\n');
                    default:
                        throw new Error(`Unexpected procfs path: ${path}`);
                }
            },
        };
        const resolver = new LaunchedChildProcessResolver(
            createLinuxProcessQuery(commandRunner, fileSystem),
            new TestClock(),
            { timeoutMs: 100, retryDelayMs: 10 });
        const frameworkDependentIdentity: LaunchedChildProcessIdentity = {
            requiresDirectChild: true,
            isLauncher: candidate => candidate.executable === '/tool/launcher',
            isCandidate: candidate => candidate.executable === '/usr/local/share/dotnet/dotnet' &&
                candidate.commandLineArguments?.includes(targetPath) === true,
        };

        assert.strictEqual(await resolver.resolveProcessId(10, frameworkDependentIdentity), 42);
        assert.ok(candidateReadAttempts >= 3);
    });

    test('fails closed after repeated Linux procfs permission errors', async () => {
        let candidateReadAttempts = 0;
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(command, args): Promise<string> {
                assert.strictEqual(command, 'ps');
                assert.deepStrictEqual(args, ['-axo', 'pid=,ppid=']);
                return '10 1\n42 10';
            },
        };
        const fileSystem: LaunchedChildProcessFileSystem = {
            async readlink(path): Promise<string> {
                if (path === '/proc/42/exe') {
                    candidateReadAttempts++;
                    throw new Error('EACCES');
                }

                assert.strictEqual(path, '/proc/10/exe');
                return '/tool/launcher';
            },
            async readFile(path): Promise<Buffer> {
                switch (path) {
                    case '/proc/10/cmdline':
                        return Buffer.from('/tool/launcher\0');
                    case '/proc/10/status':
                        return Buffer.from('Name:\tlauncher\nPPid:\t1\n');
                    case '/proc/42/cmdline':
                        return Buffer.from('/target/api\0');
                    case '/proc/42/status':
                        return Buffer.from('Name:\tapi\nPPid:\t10\n');
                    default:
                        throw new Error(`Unexpected procfs path: ${path}`);
                }
            },
        };
        const resolver = new LaunchedChildProcessResolver(
            createLinuxProcessQuery(commandRunner, fileSystem),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveProcessId(10, identity));
        assert.ok(candidateReadAttempts >= 2);
    });

    test('command runner returns UTF-8/BOM output after draining stderr', async () => {
        const child = createCommandProcess();
        const result = new SystemLaunchedChildProcessCommandRunner(() => child).run('ps', [], undefined, 100);

        child.stdout.emit('data', '\uFEFF日本語');
        child.stderr.emit('data', 'diagnostic');
        child.emit('close', 0);

        assert.strictEqual(await result, '\uFEFF日本語');
        assert.strictEqual((child.stderr.resume as sinon.SinonStub).calledOnce, true);
    });

    test('command runner rejects and cleans up on nonzero exit, cancellation, timeout, and output cap', async () => {
        const children = [createCommandProcess(), createCommandProcess(), createCommandProcess(), createCommandProcess()];
        const spawn = sinon.stub();
        spawn.onCall(0).returns(children[0]);
        spawn.onCall(1).returns(children[1]);
        spawn.onCall(2).returns(children[2]);
        spawn.onCall(3).returns(children[3]);
        const runner = new SystemLaunchedChildProcessCommandRunner(spawn);
        const cancellation = new vscode.CancellationTokenSource();

        const nonzero = runner.run('ps', [], undefined, 100);
        children[0].emit('close', 1);
        await assert.rejects(nonzero);

        const cancelled = runner.run('ps', [], cancellation.token, 100);
        cancellation.cancel();
        await assert.rejects(cancelled);

        const capped = runner.run('ps', [], undefined, 100);
        children[2].stdout.emit('data', 'x'.repeat(16 * 1024 * 1024 + 1));
        await assert.rejects(capped);

        const timedOut = runner.run('ps', [], undefined, 1);
        await assert.rejects(timedOut);
        assert.strictEqual((children[0].kill as sinon.SinonStub).called, false);
        assert.strictEqual((children[1].kill as sinon.SinonStub).calledOnce, true);
        assert.strictEqual((children[2].kill as sinon.SinonStub).calledOnce, true);
        assert.strictEqual((children[3].kill as sinon.SinonStub).calledOnce, true);
        cancellation.dispose();
    });

    test('resolves a stable nested child only beneath its launcher', async () => {
        const resolver = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([
                [
                    process(10, 1, '/tool/launcher'),
                    process(22, 10, '/tool/intermediate'),
                    process(42, 22, '/target/api'),
                    process(43, 1, '/target/unrelated'),
                ],
                [
                    process(10, 1, '/tool/launcher'),
                    process(22, 10, '/tool/intermediate'),
                    process(42, 22, '/target/api'),
                    process(43, 1, '/target/unrelated'),
                ],
            ]),
            new TestClock(),
            { timeoutMs: 100, retryDelayMs: 10 });

        assert.strictEqual(await resolver.resolveProcessId(10, identity), 42);
    });

    test('waits for the same matching child twice', async () => {
        const resolver = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([
                [process(10, 1, '/tool/launcher'), process(42, 10, '/target/old')],
                [process(10, 1, '/tool/launcher'), process(43, 10, '/target/new')],
                [process(10, 1, '/tool/launcher'), process(43, 10, '/target/new')],
            ]),
            new TestClock(),
            { timeoutMs: 100, retryDelayMs: 10 });

        assert.strictEqual(await resolver.resolveProcessId(10, identity), 43);
    });

    test('fails closed for a missing or ambiguous matching child', async () => {
        const noCandidate = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([[process(10, 1, '/tool/launcher')]]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });
        const ambiguous = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([[
                process(10, 1, '/tool/launcher'),
                process(42, 10, '/target/api'),
                process(43, 10, '/target/worker'),
            ]]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(noCandidate.resolveProcessId(10, identity));
        await assert.rejects(ambiguous.resolveProcessId(10, identity));
    });

    test('fails closed when scoped direct dotnet children are ambiguous', async () => {
        const directDotnetIdentity: LaunchedChildProcessIdentity = {
            requiresDirectChild: true,
            isLauncher: candidate => candidate.executable === '/tool/launcher',
            isCandidate: candidate => candidate.executable === '/usr/local/share/dotnet/dotnet',
        };
        const resolver = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([[
                process(10, 1, '/tool/launcher'),
                process(42, 10, '/usr/local/share/dotnet/dotnet', 'dotnet exec malformed-posix-command'),
                process(43, 10, '/usr/local/share/dotnet/dotnet', 'dotnet exec another-malformed-posix-command'),
            ]]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveProcessId(10, directDotnetIdentity));
    });

    test('fails closed for a cyclic process listing', async () => {
        const cyclic = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([[
                process(10, 42, '/tool/launcher'),
                process(42, 10, '/target/api'),
            ]]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(cyclic.resolveProcessId(10, identity));
    });

    test('re-verifies selected PID ancestry before accepting a process-list candidate', async () => {
        const injectedCandidate = process(42, 10, '/target/api', '/target/api');
        const query: LaunchedChildProcessQuery = {
            listProcesses: async () => [
                process(10, 1, '/tool/launcher'),
                injectedCandidate,
            ],
            // A newline in another process's command can forge the row above. The direct PID
            // query exposes the real parent and must prevent attaching to that unrelated process.
            getProcess: async processId => processId === 42
                ? process(42, 99, '/target/api', '/target/api')
                : process(10, 1, '/tool/launcher'),
        };
        const resolver = new LaunchedChildProcessResolver(
            query,
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveProcessId(10, identity));
    });

    test('normalizes query failures and supports cancellation', async () => {
        const failedResolver = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([new Error('/private/target/api 4242')]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });
        const cancellation = new vscode.CancellationTokenSource();
        const cancelledResolver = new LaunchedChildProcessResolver(
            new SequenceProcessQuery([[process(10, 1, '/tool/launcher')]]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        try {
            await assert.rejects(
                failedResolver.resolveProcessId(10, identity),
                error => error instanceof Error && !/target|4242/.test(error.message));
            cancellation.cancel();
            await assert.rejects(
                cancelledResolver.resolveProcessId(10, identity, cancellation.token),
                vscode.CancellationError);
        }
        finally {
            cancellation.dispose();
        }
    });

    test('propagates cancellation from a per-process identity query', async () => {
        const query: LaunchedChildProcessQuery = {
            listProcesses: async () => [
                process(10, 1, '/tool/launcher'),
                process(42, 10, '/target/api'),
            ],
            getProcess: async () => {
                throw new vscode.CancellationError();
            },
        };
        const resolver = new LaunchedChildProcessResolver(
            query,
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveProcessId(10, identity), vscode.CancellationError);
    });
});
