import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    LaunchedChildProcessResolver,
    parsePosixProcessList,
    parseWindowsProcessList,
    SystemLaunchedChildProcessQuery,
    type LaunchedChildProcess,
    type LaunchedChildProcessClock,
    type LaunchedChildProcessCommandRunner,
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

function process(pid: number, parentPid: number, executable: string, command = executable): LaunchedChildProcess {
    return { pid, parentPid, executable, command };
}

const identity: LaunchedChildProcessIdentity = {
    isLauncher: candidate => candidate.executable === '/tool/launcher',
    isCandidate: candidate => candidate.executable.includes('/target/'),
};

suite('Launched child process discovery', () => {
    teardown(() => sinon.restore());

    test('parses POSIX process listings without retaining incomplete rows', () => {
        assert.deepStrictEqual(parsePosixProcessList([
            '  10     1 /tool/launcher launcher --run',
            '  42    10 /target/api /target/api --port 8080',
            'not a process row',
        ].join('\n')), [
            process(10, 1, '/tool/launcher', 'launcher --run'),
            process(42, 10, '/target/api', '/target/api --port 8080'),
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

    test('uses fixed platform-specific process discovery commands', async () => {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        const commandRunner: LaunchedChildProcessCommandRunner = {
            async run(command, args): Promise<string> {
                calls.push({ command, args });
                return command === 'ps'
                    ? '10 1 /tool/launcher launcher --run'
                    : JSON.stringify({
                        ProcessId: 10,
                        ParentProcessId: 1,
                        Name: 'launcher.exe',
                        ExecutablePath: 'C:\\tool\\launcher.exe',
                        CommandLine: 'launcher --run',
                    });
            },
        };

        await new SystemLaunchedChildProcessQuery('linux', commandRunner).listProcesses();
        await new SystemLaunchedChildProcessQuery('win32', commandRunner).listProcesses();

        assert.deepStrictEqual(calls, [
            {
                command: 'ps',
                args: ['-axo', 'pid=,ppid=,comm=,args='],
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
});
