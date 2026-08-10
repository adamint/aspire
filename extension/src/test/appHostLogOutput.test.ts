import * as assert from 'assert';
import * as sinon from 'sinon';
import { AppHostLogEntry, AppHostLogOutputCoordinator, AppHostParentOutput } from '../debugger/appHostLogOutput';

suite('AppHost log output coordinator', () => {
    test('deduplicates correlated records without dropping repeated messages', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 1 })), {
            output: 'info: Example.Category[7]\n      Repeated message.\n',
            category: 'stdout'
        });
        assert.deepStrictEqual(coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2 })), {
            output: 'info: Example.Category[7]\n      Repeated message.\n',
            category: 'stdout'
        });

        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\n      Repeated message.\n', 'stdout'),
            []);
        assert.deepStrictEqual(
            renderConsole(coordinator, 'info: Example.Category[7]\n      Repeated message.\n', 'stdout'),
            []);
    });

    test('colors warnings and preserves error stream identity', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ logLevel: 'Warning', message: 'Careful.' })),
            {
                output: '\x1b[33mwarn: Example.Category[7]\n      Careful.\x1b[0m\n',
                category: 'stdout'
            });
        assert.deepStrictEqual(
            coordinator.handleBackchannelEntry(createEntry({ sequenceNumber: 2, logLevel: 'Error', message: 'Failed.' })),
            {
                output: 'fail: Example.Category[7]\n      Failed.\n',
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
            output: raw,
            category: 'stderr'
        });
        assert.deepStrictEqual(coordinator.flush(), []);
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
                output: `\x1b[33m${raw.trimEnd()}\x1b[0m\n`,
                category: 'stdout'
            });
        assert.deepStrictEqual(coordinator.flush(), []);
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
                    output: '\x1b[2mdbug: Example.Category[7]\n      Last detail.\x1b[0m\n',
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

    test('cancellation flush retains the final incomplete record', () => {
        const coordinator = new AppHostLogOutputCoordinator();

        assert.deepStrictEqual(
            coordinator.handleDebugAdapterOutput('crit: Example.Category[7]\n      Fatal', 'stderr'),
            []);
        assert.deepStrictEqual(coordinator.flush(), [{
            output: 'crit: Example.Category[7]\n      Fatal\n',
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
