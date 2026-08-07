import * as assert from 'assert';
import { AppHostLogEntry, AppHostLogOutputCoordinator } from '../debugger/appHostLogOutput';

suite('AppHost log output coordinator tests', () => {
    test('correlates one backchannel record with its ConsoleLogger and DebugLogger copies', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({ sequenceNumber: 1, logLevel: 'Warning', message: 'Port is already allocated.' });

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: '\x1b[33mExample.Category: Warning: Port is already allocated.\x1b[0m\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("warn: Example.Category[7]\n      Port is already allocated.\n", 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("Example.Category: Warning: Port is already allocated.\n", 'console'),
            []);
    });

    test('correlates a backchannel copy that arrives after the debug adapter record', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({ sequenceNumber: 1, logLevel: 'Information', message: 'Application started.' });

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Application started.\n", 'stdout'),
            [{ output: 'Example.Category: Information: Application started.\n', category: 'stdout' }]);
        assert.strictEqual(coordinator.handleBackchannelEntry(entry), undefined);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("Example.Category: Information: Application started.\n", 'console'),
            []);
    });

    test('preserves repeated identical records and same text from different categories', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const first = createEntry({ sequenceNumber: 1, message: 'Repeated message.' });
        const second = createEntry({ sequenceNumber: 2, message: 'Repeated message.' });
        const otherCategory = createEntry({ sequenceNumber: 3, categoryName: 'Other.Category', message: 'Repeated message.' });

        assert.ok(coordinator.handleBackchannelEntry(first));
        assert.ok(coordinator.handleBackchannelEntry(second));
        assert.ok(coordinator.handleBackchannelEntry(otherCategory));

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Repeated message.\n", 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Repeated message.\n", 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Other.Category[7]\n      Repeated message.\n", 'stdout'),
            []);
    });

    test('maps log severity to debug console category and ANSI style', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const levels: AppHostLogEntry['logLevel'][] = ['Trace', 'Debug', 'Information', 'Warning', 'Error', 'Critical'];

        const outputs = levels.map((logLevel, index) =>
            coordinator.handleBackchannelEntry(createEntry({
                sequenceNumber: index + 1,
                logLevel,
                message: `${logLevel} message`
            })));

        assert.deepStrictEqual(outputs, [
            { output: '\x1b[2mExample.Category: Trace: Trace message\x1b[0m\n', category: 'stdout' },
            { output: '\x1b[2mExample.Category: Debug: Debug message\x1b[0m\n', category: 'stdout' },
            { output: 'Example.Category: Information: Information message\n', category: 'stdout' },
            { output: '\x1b[33mExample.Category: Warning: Warning message\x1b[0m\n', category: 'stdout' },
            { output: 'Example.Category: Error: Error message\n', category: 'stderr' },
            { output: 'Example.Category: Critical: Critical message\n', category: 'stderr' }
        ]);
    });

    test('keeps multiline messages and exceptions in one logical output record', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({
            sequenceNumber: 1,
            logLevel: 'Error',
            message: 'Request failed.\nAdditional details.',
            exception: 'System.InvalidOperationException: boom\n   at Program.Main()'
        });

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: 'Example.Category: Error: Request failed.\nAdditional details.\nSystem.InvalidOperationException: boom\n   at Program.Main()\n',
            category: 'stderr'
        });
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(
                "Example.Category: Error: Request failed.\nAdditional details.\n\nSystem.InvalidOperationException: boom\n   at Program.Main()\n",
                'console'),
            []);
    });

    test('assembles a ConsoleLogger record split across debug adapter events', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("warn: Example.Category[7]\n", 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("      Split warning.\n      Additional details.\n", 'stdout'),
            [{
                output: '\x1b[33mExample.Category: Warning: Split warning.\nAdditional details.\x1b[0m\n',
                category: 'stdout'
            }]);
    });

    test('suppresses a replayed backchannel sequence but resets between AppHost processes', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({ sequenceNumber: 42, message: 'Session-local message.' });

        assert.ok(coordinator.handleBackchannelEntry(entry));
        assert.strictEqual(coordinator.handleBackchannelEntry(entry), undefined);

        coordinator.reset();

        assert.ok(coordinator.handleBackchannelEntry(entry));
    });

    test('bounds cross-source correlation history', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        for (let index = 0; index < 1025; index++) {
            assert.ok(coordinator.handleBackchannelEntry(createEntry({
                sequenceNumber: index + 1,
                message: `Message ${index}`
            })));
        }

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Message 0\n", 'stdout'),
            [{ output: 'Example.Category: Information: Message 0\n', category: 'stdout' }]);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Message 1024\n", 'stdout'),
            []);
    });

    test('preserves output that arrives through only one source', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({
            sequenceNumber: 1,
            message: 'Backchannel only.'
        })), {
            output: 'Example.Category: Information: Backchannel only.\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("warn: Adapter.Only[3]\n      Debug adapter only.\n", 'stdout'),
            [{
                output: '\x1b[33mAdapter.Only: Warning: Debug adapter only.\x1b[0m\n',
                category: 'stdout'
            }]);
    });

    test('terminates every rendered record so consecutive records stay on separate lines', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        const rendered = [
            ...coordinator.handleDebugAdapterOutput("warn: Example.Category[7]\n      First warning.\n", 'stdout'),
            ...coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Second info.\n", 'stdout'),
            coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 3, message: 'Third from the CLI.' }))!
        ];

        // AspireDebugSession writes these verbatim, so the coordinator owns the line
        // breaks. Without them the debug console renders one run-together line.
        assert.strictEqual(
            rendered.map(output => output.output).join(''),
            '\x1b[33mExample.Category: Warning: First warning.\x1b[0m\n'
            + 'Example.Category: Information: Second info.\n'
            + 'Example.Category: Information: Third from the CLI.\n');
    });

    test('preserves arrival order when the two sources interleave', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const rendered: string[] = [];

        rendered.push(...coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Adapter first.\n", 'stdout').map(output => output.output));
        const backchannelOnly = coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 1, message: 'Backchannel second.' }));
        rendered.push(backchannelOnly!.output);
        // The correlated copy of "Adapter first." must not re-render out of order.
        assert.strictEqual(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2, message: 'Adapter first.' })), undefined);
        rendered.push(...coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Adapter third.\n", 'stdout').map(output => output.output));

        assert.deepStrictEqual(rendered, [
            'Example.Category: Information: Adapter first.\n',
            'Example.Category: Information: Backchannel second.\n',
            'Example.Category: Information: Adapter third.\n'
        ]);
    });

    test('correlates by record identity rather than message text', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        // Two records share every field except the event id, so the ConsoleLogger copy
        // must consume the record it actually belongs to and leave the other visible.
        assert.ok(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 1, eventId: 3, message: 'Same text.' })));
        assert.ok(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2, eventId: 9, message: 'Same text.' })));

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[9]\n      Same text.\n", 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[3]\n      Same text.\n", 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[4]\n      Same text.\n", 'stdout'),
            [{ output: 'Example.Category: Information: Same text.\n', category: 'stdout' }]);
    });

    test('correlates a ConsoleLogger record that carries an exception block', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(
                "fail: Example.Category[7]\n      Request failed.\n      System.InvalidOperationException: boom\n         at Program.Main()\n",
                'stdout'),
            [{
                output: 'Example.Category: Error: Request failed.\nSystem.InvalidOperationException: boom\n   at Program.Main()\n',
                category: 'stderr'
            }]);
        assert.strictEqual(coordinator.handleBackchannelEntry(createEntry({
            sequenceNumber: 1,
            logLevel: 'Error',
            message: 'Request failed.',
            exception: 'System.InvalidOperationException: boom\n   at Program.Main()'
        })), undefined);
    });

    test('does not deduplicate unstructured output by message text', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const output = 'Repeated raw stdout.\n';
        const loggerShapedOutput = 'Status: Error: connection refused\n';

        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput(output, 'stdout'), [{ output, category: 'stdout' }]);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput(output, 'stdout'), [{ output, category: 'stdout' }]);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(loggerShapedOutput, 'stdout'),
            [{ output: loggerShapedOutput, category: 'stdout' }]);
    });
    test('correlates a record whose exception the AppHost could not send separately', () => {
        // BackchannelDataTypes is source-shared and the CLI runs against older AppHosts by
        // design. An AppHost predating BackchannelLogEntry.Exception sends only the
        // formatted message, which drops the exception, while the console copy still
        // prints it. Without a wildcard the record would render twice.
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({ logLevel: 'Error', message: 'Health check failed.', exception: null });

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: 'Example.Category: Error: Health check failed.\n',
            category: 'stderr'
        });
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(
                "fail: Example.Category[7]\n      Health check failed.\n      System.InvalidOperationException: boom\n         at Probe()\n",
                'stderr'),
            []);
    });

    test('correlates an exception whose type name carries a native error code', () => {
        // Win32Exception and everything derived from it render as
        // "System.Net.Sockets.SocketException (111): Connection refused", so the exception
        // boundary has to tolerate the code between the type name and the colon.
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({
            logLevel: 'Error',
            message: 'Health check failed.',
            exception: 'System.Net.Sockets.SocketException (111): Connection refused\n   at Connect()'
        });

        assert.ok(coordinator.handleBackchannelEntry(entry));
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(
                "fail: Example.Category[7]\n      Health check failed.\n      System.Net.Sockets.SocketException (111): Connection refused\n         at Connect()\n",
                'stderr'),
            []);
    });

    test('assembles a record split mid-line across debug adapter events', () => {
        // A redirected Console.Out flushes every 256 characters, so a split lands at an
        // arbitrary offset rather than a line boundary.
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(
                "fail: Example.Category[7]\n      Boom happened.\n      System.InvalidOperationException: bo",
                'stderr'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("om\n         at Connect()\n", 'stderr'),
            [{
                output: 'Example.Category: Error: Boom happened.\nSystem.InvalidOperationException: boom\n   at Connect()\n',
                category: 'stderr'
            }]);
    });

    test('renders each record once when several arrive in a single debug adapter event', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput(
                "info: Example.Category[7]\n      First message.\ninfo: Other.Category[7]\n      Second message.\n",
                'stdout'),
            [
                { output: 'Example.Category: Information: First message.\n', category: 'stdout' },
                { output: 'Other.Category: Information: Second message.\n', category: 'stdout' }
            ]);
        assert.strictEqual(
            coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 1, message: 'First message.' })),
            undefined);
        assert.strictEqual(
            coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2, categoryName: 'Other.Category', message: 'Second message.' })),
            undefined);
    });

    test('keeps suppressing trace body lines after a record is consumed as a record', () => {
        // The fallback filter decides whether an indented line continues a suppressed
        // trace/debug record. Records handled by the correlation path never reach it, so
        // its state has to be advanced explicitly or the leftover body line leaks.
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("dbug: Example.Category[7]\n      Verbose line one.\n", 'stdout'),
            [{ output: '\x1b[2mExample.Category: Debug: Verbose line one.\x1b[0m\n', category: 'stdout' }]);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("      Verbose line two.\n", 'stdout'),
            []);
    });

    test('flush emits a record the AppHost was still writing when it exited', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("crit: Example.Category[7]\n      Fatal: could not", 'stderr'),
            []);
        assert.deepStrictEqual(coordinator.flush(), [{
            output: 'Example.Category: Critical: Fatal: could not\n',
            category: 'stderr'
        }]);
        assert.deepStrictEqual(coordinator.flush(), []);
    });

    test('correlates a message that ends with a newline', () => {
        // SimpleConsoleFormatter indents every continuation, so a trailing newline in the
        // message reaches the console as an extra padded line that the structured copy
        // does not have.
        const coordinator = new AppHostLogOutputCoordinator();

        assert.ok(coordinator.handleBackchannelEntry(createEntry({ message: 'Line one.\n' })));
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput("info: Example.Category[7]\n      Line one.\n      \n", 'stdout'),
            []);
    });

    test('passes an unterminated line straight through when no record is being assembled', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('Downloading... ', 'stdout'),
            [{ output: 'Downloading... ', category: 'stdout' }]);
    });
});

function createEntry(overrides: Partial<AppHostLogEntry> = {}): AppHostLogEntry {
    return {
        sequenceNumber: 1,
        timestamp: '2026-08-07T00:00:00.0000000+00:00',
        logLevel: 'Information',
        message: 'Message',
        categoryName: 'Example.Category',
        eventId: 7,
        eventName: null,
        exception: null,
        ...overrides
    };
}
