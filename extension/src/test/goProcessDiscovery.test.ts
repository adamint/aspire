import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    GoRunApplicationProcessResolver,
    parsePosixProcessList,
    parseWindowsProcessList,
    SystemGoProcessQuery,
    type GoProcessCommandRunner,
    type GoProcessDiscoveryClock,
    type GoProcessInfo,
    type GoProcessQuery,
} from '../debugger/languages/goProcessDiscovery';

class TestClock implements GoProcessDiscoveryClock {
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

class SequenceProcessQuery implements GoProcessQuery {
    private _index = 0;

    constructor(private readonly _snapshots: readonly (readonly GoProcessInfo[] | Error)[]) {
    }

    async listProcesses(): Promise<readonly GoProcessInfo[]> {
        const snapshot = this._snapshots[Math.min(this._index, this._snapshots.length - 1)];
        this._index++;
        if (snapshot instanceof Error) {
            throw snapshot;
        }

        return snapshot;
    }
}

function process(pid: number, parentPid: number, executable: string, command = executable): GoProcessInfo {
    return { pid, parentPid, executable, command };
}

function goRunProcessTree(applicationPid = 42): readonly GoProcessInfo[] {
    return [
        process(10, 1, '/usr/local/go/bin/go', 'go run ./cmd/api'),
        process(22, 10, '/usr/local/go/pkg/tool/darwin_arm64/compile'),
        process(33, 22, '/usr/local/go/pkg/tool/darwin_arm64/link'),
        process(applicationPid, 33, `/private/var/folders/x/go-build123/b001/exe/api`, `/private/var/folders/x/go-build123/b001/exe/api --port 8080`),
    ];
}

suite('Go process discovery', () => {
    teardown(() => sinon.restore());

    test('parses POSIX process listings without retaining incomplete rows', () => {
        assert.deepStrictEqual(parsePosixProcessList([
            '  10     1 /usr/local/go/bin/go go run ./cmd/api',
            '  42    10 /private/var/folders/x/go-build123/b001/exe/api /private/var/folders/x/go-build123/b001/exe/api --port 8080',
            'not a process row',
        ].join('\n')), [
            process(10, 1, '/usr/local/go/bin/go', 'go run ./cmd/api'),
            process(42, 10, '/private/var/folders/x/go-build123/b001/exe/api', '/private/var/folders/x/go-build123/b001/exe/api --port 8080'),
        ]);
    });

    test('parses Windows CIM process listings', () => {
        assert.deepStrictEqual(parseWindowsProcessList(JSON.stringify([
            {
                ProcessId: 10,
                ParentProcessId: 1,
                Name: 'go.exe',
                ExecutablePath: 'C:\\Go\\bin\\go.exe',
                CommandLine: 'go run .\\cmd\\api',
            },
            {
                ProcessId: 42,
                ParentProcessId: 10,
                Name: 'api.exe',
                ExecutablePath: 'C:\\Users\\me\\AppData\\Local\\Temp\\go-build123\\b001\\exe\\api.exe',
                CommandLine: 'C:\\Users\\me\\AppData\\Local\\Temp\\go-build123\\b001\\exe\\api.exe',
            },
        ])), [
            process(10, 1, 'C:\\Go\\bin\\go.exe', 'go run .\\cmd\\api'),
            process(42, 10, 'C:\\Users\\me\\AppData\\Local\\Temp\\go-build123\\b001\\exe\\api.exe', 'C:\\Users\\me\\AppData\\Local\\Temp\\go-build123\\b001\\exe\\api.exe'),
        ]);
    });

    test('uses fixed platform-specific process discovery commands', async () => {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        const commandRunner: GoProcessCommandRunner = {
            async run(command, args): Promise<string> {
                calls.push({ command, args });
                return command === 'ps'
                    ? '10 1 /usr/local/go/bin/go go run ./cmd/api'
                    : JSON.stringify({
                        ProcessId: 10,
                        ParentProcessId: 1,
                        Name: 'go.exe',
                        ExecutablePath: 'C:\\Go\\bin\\go.exe',
                        CommandLine: 'go run .\\cmd\\api',
                    });
            },
        };

        await new SystemGoProcessQuery('linux', commandRunner).listProcesses();
        await new SystemGoProcessQuery('win32', commandRunner).listProcesses();

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
                    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
                ],
            },
        ]);
    });

    test('traverses nested children and ignores Go toolchain processes', async () => {
        const resolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([goRunProcessTree(), goRunProcessTree()]),
            new TestClock(),
            { timeoutMs: 100, retryDelayMs: 10 });

        assert.strictEqual(await resolver.resolveApplicationPid(10), 42);
    });

    test('waits for the same Go build application candidate twice', async () => {
        const resolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([
                goRunProcessTree(42),
                goRunProcessTree(43),
                goRunProcessTree(43),
            ]),
            new TestClock(),
            { timeoutMs: 100, retryDelayMs: 10 });

        assert.strictEqual(await resolver.resolveApplicationPid(10), 43);
    });

    test('fails closed when no Go build application process exists', async () => {
        const resolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([
                [process(10, 1, '/usr/local/go/bin/go', 'go run ./cmd/api')],
            ]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveApplicationPid(10));
    });

    test('fails closed when Go build application candidates are ambiguous', async () => {
        const resolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([
                [
                    ...goRunProcessTree(42),
                    process(43, 10, '/private/var/folders/x/go-build456/b001/exe/worker'),
                ],
            ]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveApplicationPid(10));
    });

    test('fails closed when the reported Go parent process was reused', async () => {
        const resolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([
                [
                    process(10, 1, '/bin/bash', 'bash build.sh'),
                    process(42, 10, '/private/var/folders/x/go-build123/b001/exe/api'),
                ],
            ]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveApplicationPid(10));
    });

    test('fails within its bounded timeout without a stable candidate', async () => {
        const resolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([
                goRunProcessTree(42),
                goRunProcessTree(43),
                goRunProcessTree(42),
            ]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        await assert.rejects(resolver.resolveApplicationPid(10));
    });

    test('propagates cancellation and process-query failures without process details', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        const failedResolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([new Error('/private/go-build123/b001/exe/api 4242')]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });
        const cancelledResolver = new GoRunApplicationProcessResolver(
            new SequenceProcessQuery([goRunProcessTree()]),
            new TestClock(),
            { timeoutMs: 20, retryDelayMs: 10 });

        try {
            await assert.rejects(
                failedResolver.resolveApplicationPid(10),
                error => error instanceof Error && !/go-build|4242/.test(error.message));
            cancellation.cancel();
            await assert.rejects(cancelledResolver.resolveApplicationPid(10, cancellation.token), vscode.CancellationError);
        }
        finally {
            cancellation.dispose();
        }
    });
});
