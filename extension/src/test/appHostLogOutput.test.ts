import * as assert from 'assert';
import * as sinon from 'sinon';
import {
    AppHostLogEntry,
    AppHostLogOutputCoordinator,
    AppHostParentOutput,
    AppHostParentOutputFilter
} from '../debugger/appHostLogOutput';

suite('AppHost log output coordinator', () => {
    test('deduplicates correlated records without dropping repeated messages', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 1 })), {
            output: 'Example.Category: Information: Repeated message.\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2 })), {
            output: 'Example.Category: Information: Repeated message.\n',
            category: 'stdout'
        });

        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\n      Repeated message.\n', 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\n      Repeated message.\n', 'stdout'),
            []);
    });

    test('deduplicates the backchannel, ConsoleLogger, and DebugLogger copies', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ logLevel: 'Warning', message: 'Port is busy.' })),
            {
                output: '\x1b[33mExample.Category: Warning: Port is busy.\x1b[0m\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(
            renderConsole(coordinator, 'warn: Example.Category[7]\n      Port is busy.\n', 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(coordinator, 'Example.Category: Warning: Port is busy.\n', 'console'),
            []);
    });

    test('renders parsed records consistently regardless of which source arrives first', () => {
        const entry = createEntry({ logLevel: 'Warning', message: 'Port is busy.' });
        const expected = {
            output: '\x1b[33mExample.Category: Warning: Port is busy.\x1b[0m\n',
            category: 'stdout'
        };

        const backchannelFirst = new AppHostLogOutputCoordinator();
        assert.deepStrictEqual(backchannelFirst.handleBackchannelEntry(entry), expected);

        const consoleFirst = new AppHostLogOutputCoordinator();
        assert.deepStrictEqual(
            renderConsole(consoleFirst, '2026-08-10 17:40:09 warn: Example.Category[7]\n      Port is busy.\n', 'stdout'),
            [expected]);

        const debugLoggerFirst = new AppHostLogOutputCoordinator();
        assert.deepStrictEqual(
            renderConsole(debugLoggerFirst, 'Example.Category: Warning: Port is busy.\n', 'console'),
            [expected]);
        assert.strictEqual(debugLoggerFirst.handleBackchannelEntry(entry), undefined);
    });

    test('escapes category control characters consistently across log sources', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const category = 'Unsafe\x1b[31m\tCategory\u0085';
        const escapedCategory = 'Unsafe\\u001b[31m\\u0009Category\\u0085';

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ categoryName: category })),
            {
                output: `${escapedCategory}: Information: Repeated message.\n`,
                category: 'stdout'
            });
        assert.deepStrictEqual(
            renderConsole(coordinator, `info: ${category}[7]\n      Repeated message.\n`, 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(coordinator, `${category}: Information: Repeated message.\n`, 'console'),
            []);

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({
                sequenceNumber: 2,
                categoryName: 'Forged\r\nline\x7f'
            })),
            {
                output: 'Forged\\u000d\\u000aline\\u007f: Information: Repeated message.\n',
                category: 'stdout'
            });
    });

    test('keeps low-level adapter traffic from evicting pending Information records', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        assert.ok(coordinator.handleBackchannelEntry(createEntry({ message: 'Still pending.' })));

        const lowLevelOutput = Array.from(
            { length: 1025 },
            (_, index) => `Low.Level.Category: Debug: Detail ${index}.\n`).join('');
        assert.strictEqual(
            [...coordinator.handleDebugAdapterOutput(lowLevelOutput, 'console'), ...coordinator.flush()].length,
            1025);

        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\n      Still pending.\n', 'stdout'),
            []);
    });

    test('completed low-level pairs do not evict a pending record', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            renderConsole(coordinator, 'Pending.Category: Debug: Still pending.\n', 'console'),
            [{
                output: '\x1b[2mPending.Category: Debug: Still pending.\x1b[0m\n',
                category: 'stdout'
            }]);

        for (let index = 0; index < 129; index++) {
            assert.strictEqual(
                renderConsole(
                    coordinator,
                    `Noise.Category.${index}: Debug: Detail ${index}.\n`,
                    'console').length,
                1);
            assert.deepStrictEqual(
                renderConsole(
                    coordinator,
                    `dbug: Noise.Category.${index}[7]\n      Detail ${index}.\n`,
                    'stdout'),
                []);
        }

        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'dbug: Pending.Category[7]\n      Still pending.\n',
                'stdout'),
            []);
    });

    test('colors warnings and preserves error stream identity', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ logLevel: 'Warning', message: 'Careful.' })),
            {
                output: '\x1b[33mExample.Category: Warning: Careful.\x1b[0m\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2, logLevel: 'Error', message: 'Failed.' })),
            {
                output: 'Example.Category: Error: Failed.\n',
                category: 'stderr'
            });
    });

    test('reassembles partial and interleaved stream chunks before correlation', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        assert.ok(coordinator.handleBackchannelEntry(createEntry({
            logLevel: 'Error',
            message: 'Request failed.',
            exception: 'System.InvalidOperationException: boom'
        })));

        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('fail: Example.Cate', 'stdout'), []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('Unhandled exception. System.Exception: native\n', 'stderr'),
            [{ output: 'Unhandled exception. System.Exception: native\n', category: 'stderr' }]);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('gory[7]\r', 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('\n      Request fai', 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('led.\r\n      System.InvalidOperation', 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('Exception: boom\r\n', 'stdout'), []);
        assert.deepStrictEqual(coordinator.flush(), []);
    });

    test('replays a captured AppHost transcript with one output per log record', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const outputs: AppHostParentOutput[] = [];
        const append = (items: AppHostParentOutput[]) => outputs.push(...items);
        const appendEntry = (entry: AppHostLogEntry) => {
            const output = coordinator.handleBackchannelEntry(entry);
            if (output) {
                outputs.push(output);
            }
        };

        appendEntry(createEntry({ sequenceNumber: 1, message: 'Application started.' }));
        append(coordinator.handleDebugAdapterOutput('info: Example.Cate', 'stdout'));
        append(coordinator.handleDebugAdapterOutput('gory[7]\r\n      Application started.\r\n', 'stdout'));
        append(coordinator.handleDebugAdapterOutput('Example.Category: Information: Application started.\r\n', 'console'));

        append(coordinator.handleDebugAdapterOutput('Example.Category: Warning: Port is busy.\r\n', 'console'));
        appendEntry(createEntry({ sequenceNumber: 2, logLevel: 'Warning', message: 'Port is busy.' }));
        append(coordinator.handleDebugAdapterOutput('warn: Example.Category[7]\r\n      Port is busy.\r\n', 'stdout'));

        appendEntry(createEntry({
            sequenceNumber: 3,
            logLevel: 'Error',
            message: 'Request failed.',
            exception: 'System.InvalidOperationException: boom\n   at Example.Run()'
        }));
        append(coordinator.handleDebugAdapterOutput(
            'fail: Example.Category[7]\r\n'
            + '      Request failed.\r\n'
            + '      System.InvalidOperationException: boom\r\n'
            + '         at Example.Run()\r\n',
            'stdout'));
        append(coordinator.handleDebugAdapterOutput(
            'Example.Category: Error: Request failed.\r\n'
            + '\r\n'
            + 'System.InvalidOperationException: boom\r\n'
            + '   at Example.Run()\r\n',
            'console'));
        append(coordinator.flush());

        assert.deepStrictEqual(outputs, [
            {
                output: 'Example.Category: Information: Application started.\n',
                category: 'stdout'
            },
            {
                output: '\x1b[33mExample.Category: Warning: Port is busy.\x1b[0m\n',
                category: 'stdout'
            },
            {
                output: 'Example.Category: Error: Request failed.\n'
                    + 'System.InvalidOperationException: boom\n'
                    + '   at Example.Run()\n',
                category: 'stderr'
            }
        ]);
    });

    test('matches single-line SimpleConsoleFormatter output with an exception', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({
            logLevel: 'Error',
            message: 'Request failed.',
            exception: 'System.InvalidOperationException: boom\n   at Example.Run()'
        });
        const raw = 'fail: Example.Category[7] Request failed. System.InvalidOperationException: boom    at Example.Run()\n';

        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput(raw, 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: 'Example.Category: Error: Request failed.\n'
                + 'System.InvalidOperationException: boom\n'
                + '   at Example.Run()\n',
            category: 'stderr'
        });
        assert.deepStrictEqual(coordinator.flush(), []);
    });

    test('matches a single-line message containing an event-id-shaped value', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({ message: 'Processing order [42] now' });

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: 'Example.Category: Information: Processing order [42] now\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7] Processing order [42] now\n', 'stdout'),
            []);
    });

    test('matches Windows multiline output containing a bare LF', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({ message: 'first\nsecond' });

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: 'Example.Category: Information: first\nsecond\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\r\n      first\nsecond\r\n', 'stdout'),
            []);
    });

    test('deduplicates unindented multiline DebugLogger messages', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ message: 'first\nsecond' })),
            {
                output: 'Example.Category: Information: first\nsecond\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Information: first\nsecond\n',
                'console'),
            []);
    });

    test('deduplicates unindented multiline DebugLogger messages when it arrives first', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Information: first\nsecond\n',
                'console'),
            [{
                output: 'Example.Category: Information: first\nsecond\n',
                category: 'stdout'
            }]);
        assert.strictEqual(
            coordinator.handleBackchannelEntry(createEntry({ message: 'first\nsecond' })),
            undefined);
    });

    test('matches timestamped multiline output with scopes', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const raw = '2026-08-10 17:40:09 warn: Example.Category[7]\n'
            + '      => RequestPath:/health\n'
            + '      Scoped warning.\n';

        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('2026-08-10 ', 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('17:40:09 wa', 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput(raw.slice('2026-08-10 17:40:09 wa'.length), 'stdout'), []);
        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ logLevel: 'Warning', message: 'Scoped warning.' })),
            {
                output: '\x1b[33mExample.Category: Warning: Scoped warning.\x1b[0m\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(coordinator.flush(), []);
    });

    test('deduplicates a scope-free structured record after scoped ConsoleLogger output arrives first', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'info: Example.Category[7]\n'
                    + '      => RequestPath:/health\n'
                    + '      Scoped message.\n',
                'stdout'),
            [{
                output: 'Example.Category: Information: => RequestPath:/health\nScoped message.\n',
                category: 'stdout'
            }]);
        assert.strictEqual(
            coordinator.handleBackchannelEntry(createEntry({ message: 'Scoped message.' })),
            undefined);
        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Information: Scoped message.\n',
                'console'),
            []);
        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({
                sequenceNumber: 2,
                message: 'Scoped message.'
            })),
            {
                output: 'Example.Category: Information: Scoped message.\n',
                category: 'stdout'
            });
    });

    test('keeps a message that begins with the scope marker', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({ message: '=> started' })), {
            output: 'Example.Category: Information: => started\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\n      => started\n', 'stdout'),
            []);
    });

    test('deduplicates a message that begins with the scope marker after a real scope regardless of source order', () => {
        const raw = 'info: Example.Category[7]\n'
            + '      => RequestPath:/health\n'
            + '      => ConnectionId:0HN123\n'
            + '      => started\n';

        const backchannelFirst = new AppHostLogOutputCoordinator();
        assert.deepStrictEqual(backchannelFirst.handleBackchannelEntry(createEntry({ message: '=> started' })), {
            output: 'Example.Category: Information: => started\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            renderConsole(backchannelFirst, raw, 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(backchannelFirst, 'Example.Category: Information: => started\n', 'console'),
            []);

        assert.deepStrictEqual(backchannelFirst.handleBackchannelEntry(createEntry({
            sequenceNumber: 2,
            message: '=> started'
        })), {
            output: 'Example.Category: Information: => started\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(
            renderConsole(backchannelFirst, raw, 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(backchannelFirst, 'Example.Category: Information: => started\n', 'console'),
            []);

        const consoleFirst = new AppHostLogOutputCoordinator();
        assert.deepStrictEqual(renderConsole(consoleFirst, raw, 'stdout'), [{
            output: 'Example.Category: Information: => RequestPath:/health\n=> ConnectionId:0HN123\n=> started\n',
            category: 'stdout'
        }]);
        assert.strictEqual(
            consoleFirst.handleBackchannelEntry(createEntry({ message: '=> started' })),
            undefined);
        assert.deepStrictEqual(
            renderConsole(consoleFirst, 'Example.Category: Information: => started\n', 'console'),
            []);

        const debugLoggerFirst = new AppHostLogOutputCoordinator();
        assert.deepStrictEqual(
            renderConsole(debugLoggerFirst, 'Example.Category: Information: => started\n', 'console'),
            [{
                output: 'Example.Category: Information: => started\n',
                category: 'stdout'
            }]);
        assert.deepStrictEqual(renderConsole(debugLoggerFirst, raw, 'stdout'), []);
        assert.strictEqual(
            debugLoggerFirst.handleBackchannelEntry(createEntry({ message: '=> started' })),
            undefined);
    });

    test('discards ambiguous scope aliases after another source confirms the message identity', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const raw = 'info: Example.Category[7]\n'
            + '      => RequestPath:/health\n'
            + '      => ConnectionId:0HN123\n'
            + '      => started\n';

        assert.deepStrictEqual(renderConsole(coordinator, raw, 'stdout'), [{
            output: 'Example.Category: Information: => RequestPath:/health\n=> ConnectionId:0HN123\n=> started\n',
            category: 'stdout'
        }]);
        assert.strictEqual(
            coordinator.handleBackchannelEntry(createEntry({ message: '=> started' })),
            undefined);
        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Information: => ConnectionId:0HN123\n=> started\n',
                'console'),
            [{
                output: 'Example.Category: Information: => ConnectionId:0HN123\n=> started\n',
                category: 'stdout'
            }]);
        assert.deepStrictEqual(
            renderConsole(coordinator, 'Example.Category: Information: => started\n', 'console'),
            []);
    });

    test('prefers an exact identity over an older scope alias when DebugLogger omits the event ID', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const raw = 'info: Example.Category[7]\n'
            + '      => RequestPath:/health\n'
            + '      => ConnectionId:0HN123\n'
            + '      => started\n';

        assert.deepStrictEqual(renderConsole(coordinator, raw, 'stdout'), [{
            output: 'Example.Category: Information: => RequestPath:/health\n=> ConnectionId:0HN123\n=> started\n',
            category: 'stdout'
        }]);
        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ eventId: 8, message: '=> started' })),
            {
                output: 'Example.Category: Information: => started\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(
            renderConsole(coordinator, 'Example.Category: Information: => started\n', 'console'),
            []);
        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Information: => ConnectionId:0HN123\n=> started\n',
                'console'),
            []);
    });

    test('does not treat a scope marker after the first message line as a new scope boundary', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const message = 'started\n=> still part of the message';
        const raw = 'info: Example.Category[7]\n'
            + '      => RequestPath:/health\n'
            + '      started\n'
            + '      => still part of the message\n';

        assert.deepStrictEqual(renderConsole(coordinator, raw, 'stdout'), [{
            output: 'Example.Category: Information: => RequestPath:/health\nstarted\n=> still part of the message\n',
            category: 'stdout'
        }]);
        assert.strictEqual(
            coordinator.handleBackchannelEntry(createEntry({ message })),
            undefined);
    });

    test('deduplicates an empty log message', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const raw = 'info: Example.Category[7]\n';

        assert.deepStrictEqual(coordinator.handleDebugAdapterOutput(raw, 'stdout'), []);
        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({ message: '' })), {
            output: 'Example.Category: Information: \n',
            category: 'stdout'
        });
        assert.deepStrictEqual(coordinator.flush(), []);
    });

    test('does not add a leading blank line to an empty message with an exception', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const entry = createEntry({
            logLevel: 'Error',
            message: '',
            exception: 'System.InvalidOperationException: boom'
        });

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(entry), {
            output: 'Example.Category: Error: System.InvalidOperationException: boom\n',
            category: 'stderr'
        });
        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Error: \n\nSystem.InvalidOperationException: boom\n',
                'console'),
            []);
    });

    test('correlates DebugLogger output and preserves fallback filtering elsewhere', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('Example.Category[7]: Debug: Hidden detail.\n', 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(coordinator, 'Example.Category[7]: Error: Failed.\n', 'console'),
            [{ output: 'Example.Category: Error: Failed.\n', category: 'stderr' }]);
    });

    test('does not parse arbitrary console text as a DebugLogger category', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(renderConsole(coordinator, 'Status: Error: connection refused\n', 'console'), []);
        assert.deepStrictEqual(renderConsole(coordinator, 'step 3: Debug: cache miss\n', 'console'), []);
    });

    test('does not append unrelated console output when the pending DebugLogger record has a twin', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ message: 'Logged.' })),
            {
                output: 'Example.Category: Information: Logged.\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(
            renderConsole(
                coordinator,
                'Example.Category: Information: Logged.\nprocessing\n',
                'console'),
            []);
    });

    test('keeps an exception-shaped one-line DebugLogger message intact', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const expected = {
            output: 'Example.Category: Error: ValidationError: invalid input\n',
            category: 'stderr' as const
        };

        assert.deepStrictEqual(
            renderConsole(coordinator, 'Example.Category: Error: ValidationError: invalid input\n', 'console'),
            [expected]);
        assert.strictEqual(coordinator.handleBackchannelEntry(createEntry({
            logLevel: 'Error',
            message: 'ValidationError: invalid input'
        })), undefined);
    });

    test('does not parse arbitrary text before a ConsoleLogger level token', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            renderConsole(coordinator, 'status warn: Example.Category[7] Still working.\n', 'stdout'),
            [{ output: 'status warn: Example.Category[7] Still working.\n', category: 'stdout' }]);
    });

    test('waits for the complete ConsoleLogger record before correlating it', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        assert.ok(coordinator.handleBackchannelEntry(createEntry({ message: 'First line.' })));

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('info: Example.Category[7]\n      First line.\n', 'stdout'),
            []);
        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('      \n', 'stdout'),
            []);
        assert.deepStrictEqual(coordinator.flush(), []);
    });

    test('keeps blank lines inside console-category error blocks', () => {
        const filter = new AppHostParentOutputFilter();

        assert.deepStrictEqual(
            filter.filter(
                'Unhandled exception. System.InvalidOperationException: boom\n\n   at Example.Run()\n',
                'console'),
            {
                output: 'Unhandled exception. System.InvalidOperationException: boom\n\n   at Example.Run()\n',
                category: 'stderr'
            });
    });

    test('suppresses replayed sequences and accepts the same sequence after reset', () => {
        const coordinator = new AppHostLogOutputCoordinator();
        const laterEntry = createEntry({ sequenceNumber: 42, message: 'Later entry.' });
        const earlierEntry = createEntry({ sequenceNumber: 41, message: 'Earlier entry.' });

        assert.ok(coordinator.handleBackchannelEntry(laterEntry));
        assert.ok(coordinator.handleBackchannelEntry(earlierEntry));
        assert.strictEqual(coordinator.handleBackchannelEntry(laterEntry), undefined);

        coordinator.reset();

        assert.ok(coordinator.handleBackchannelEntry(laterEntry));
    });

    test('idle flush releases final adapter-only and partial output', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const emitted: AppHostParentOutput[] = [];
        const coordinator = new AppHostLogOutputCoordinator(output => emitted.push(output));

        try {
            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput('dbug: Example.Category[7]\n      Last detail.\n', 'stdout'),
                []);
            assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('native partial', 'stderr'), []);

            await clock.tickAsync(1000);

            assert.deepStrictEqual(emitted, [
                {
                    output: '\x1b[2mExample.Category: Debug: Last detail.\x1b[0m\n',
                    category: 'stdout'
                },
                {
                    output: 'native partial',
                    category: 'stderr'
                }
            ]);
        }
        finally {
            coordinator.reset();
            clock.restore();
        }
    });

    test('continuous partial chunks do not postpone the original idle flush deadline', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const emitted: AppHostParentOutput[] = [];
        const coordinator = new AppHostLogOutputCoordinator(output => emitted.push(output));

        try {
            assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('continuous ', 'stderr'), []);
            await clock.tickAsync(100);
            assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('partial ', 'stderr'), []);
            await clock.tickAsync(100);
            assert.deepStrictEqual(coordinator.handleDebugAdapterOutput('output', 'stderr'), []);
            await clock.tickAsync(50);

            assert.deepStrictEqual(emitted, [{
                output: 'continuous partial output',
                category: 'stderr'
            }]);
        }
        finally {
            coordinator.reset();
            clock.restore();
        }
    });

    test('restarts idle deadlines for replacements but not continuations', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const emitted: AppHostParentOutput[] = [];
        const coordinator = new AppHostLogOutputCoordinator(output => emitted.push(output));

        try {
            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput(
                    'info: Extended.Category[7]\n      first\n',
                    'stdout'),
                []);
            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput(
                    'info: Replaced.Category[7]\n      old\n',
                    'stderr'),
                []);
            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput(
                    'Replaced.DebugCategory: Information: old\n',
                    'console'),
                []);

            await clock.tickAsync(100);

            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput('      second\n', 'stdout'),
                []);
            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput(
                    'info: Replacement.Category[7]\n      replacement\n',
                    'stderr'),
                [{
                    output: 'Replaced.Category: Information: old\n',
                    category: 'stdout'
                }]);
            assert.deepStrictEqual(
                coordinator.handleDebugAdapterOutput(
                    'Replacement.DebugCategory: Information: replacement\n',
                    'console'),
                [{
                    output: 'Replaced.DebugCategory: Information: old\n',
                    category: 'stdout'
                }]);

            await clock.tickAsync(150);

            assert.deepStrictEqual(emitted, [{
                output: 'Extended.Category: Information: first\nsecond\n',
                category: 'stdout'
            }]);

            await clock.tickAsync(100);

            assert.deepStrictEqual(emitted, [
                {
                    output: 'Extended.Category: Information: first\nsecond\n',
                    category: 'stdout'
                },
                {
                    output: 'Replacement.Category: Information: replacement\n',
                    category: 'stdout'
                },
                {
                    output: 'Replacement.DebugCategory: Information: replacement\n',
                    category: 'stdout'
                }
            ]);
        }
        finally {
            coordinator.reset();
            clock.restore();
        }
    });

    test('cancellation flush retains the final incomplete record', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('crit: Example.Category[7]\n      Fatal', 'stderr'),
            []);
        assert.deepStrictEqual(coordinator.flush(), [{
            output: 'Example.Category: Critical: Fatal\n',
            category: 'stderr'
        }]);
        assert.deepStrictEqual(coordinator.flush(), []);
    });

});

function renderConsole(
    coordinator: AppHostLogOutputCoordinator,
    output: string,
    category: string): AppHostParentOutput[] {
    return [...coordinator.handleDebugAdapterOutput(output, category), ...coordinator.flush()];
}

function createEntry(overrides: Partial<AppHostLogEntry> = {}): AppHostLogEntry {
    return {
        sequenceNumber: 1,
        logLevel: 'Information',
        message: 'Repeated message.',
        categoryName: 'Example.Category',
        eventId: 7,
        exception: null,
        ...overrides
    };
}
