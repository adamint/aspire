import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

suite('E2E Mocha reporter', () => {
    test('prints spec progress and writes JSON results', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-e2e-reporter-'));
        const outputPath = path.join(tempDir, 'mocha.json');
        const constants = require('mocha/lib/runner').constants;
        const Base = require('mocha/lib/reporters/base');
        const previousConsoleLog = Base.consoleLog;
        const outputLines: string[] = [];
        Base.consoleLog = (...args: unknown[]) => outputLines.push(args.map(value => String(value)).join(' '));

        try {
            const Reporter = require(path.join(__dirname, '..', '..', 'scripts', 'e2e-mocha-reporter.cjs'));
            const runner = new EventEmitter() as EventEmitter & { stats: Record<string, unknown>; total: number };
            runner.stats = {
                suites: 1,
                tests: 1,
                passes: 1,
                pending: 0,
                failures: 0,
                duration: 7,
            };
            runner.total = 1;

            new Reporter(runner, { reporterOption: { output: outputPath } });
            const test = createReporterTest('prints live progress to the console');

            runner.emit(constants.EVENT_RUN_BEGIN);
            runner.emit(constants.EVENT_SUITE_BEGIN, { title: 'Aspire E2E' });
            runner.emit(constants.EVENT_TEST_PASS, test);
            runner.emit(constants.EVENT_TEST_END, test);
            runner.emit(constants.EVENT_SUITE_END);
            runner.emit(constants.EVENT_RUN_END);

            assert.ok(outputLines.some(line => line.includes('prints live progress to the console')));

            const results = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
            assert.strictEqual(results.stats.passes, 1);
            assert.deepStrictEqual(results.passes.map((pass: { fullTitle: string }) => pass.fullTitle), [
                'Aspire E2E prints live progress to the console',
            ]);
        }
        finally {
            Base.consoleLog = previousConsoleLog;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('only classifies completed test failures as advisory', () => {
        const { hasCompletedMochaTestFailures } = require(path.join(__dirname, '..', '..', 'scripts', 'e2e-mocha-results.cjs'));
        const failedTest = {
            title: 'starts an AppHost',
            fullTitle: 'Aspire E2E starts an AppHost',
        };

        assert.strictEqual(hasCompletedMochaTestFailures({
            tests: [failedTest],
            failures: [failedTest],
        }), true);
        assert.strictEqual(hasCompletedMochaTestFailures(undefined), false);
        assert.strictEqual(hasCompletedMochaTestFailures({
            tests: [],
            failures: [{ title: '"before all" hook', fullTitle: 'Aspire E2E "before all" hook' }],
        }), false);
        assert.strictEqual(hasCompletedMochaTestFailures({
            tests: [failedTest],
            failures: [
                failedTest,
                { title: '"after all" hook', fullTitle: 'Aspire E2E "after all" hook' },
            ],
        }), false);
    });

    test('only allows ordinary exit-code failures with completed Mocha failures and no cleanup failure', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const results = {
            tests: [{ fullTitle: 'Aspire E2E starts an AppHost' }],
            failures: [{ fullTitle: 'Aspire E2E starts an AppHost' }],
        };

        assert.strictEqual(shouldAllowAdvisoryTestFailure(
            new E2eProcessError('exit-code', 'node', ['run-tests'], { exitCode: 1 }),
            results,
            false),
        true);
        assert.strictEqual(shouldAllowAdvisoryTestFailure(
            new E2eProcessError('exit-code', 'node', ['run-tests'], { exitCode: 1 }),
            results,
            true),
        false);
        assert.strictEqual(shouldAllowAdvisoryTestFailure(
            new E2eProcessError('exit-code', 'node', ['run-tests'], { exitCode: 1 }),
            {
                tests: [],
                failures: [{ fullTitle: 'Aspire E2E "before all" hook' }],
            },
            false),
        false);
    });

    test('does not allow timeout, signal, or spawn failures and retains diagnostics details', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const results = {
            tests: [{ fullTitle: 'Aspire E2E starts an AppHost' }],
            failures: [{ fullTitle: 'Aspire E2E starts an AppHost' }],
        };
        const timeoutError = new E2eProcessError('timeout', 'node', ['run-tests']);
        const signalError = new E2eProcessError('signal', 'node', ['run-tests'], { signal: 'SIGTERM' });
        const spawnCause = new Error('spawn EPERM');
        const spawnError = new E2eProcessError('spawn', 'node', ['run-tests'], { cause: spawnCause });

        assert.strictEqual(shouldAllowAdvisoryTestFailure(timeoutError, results, false), false);
        assert.strictEqual(shouldAllowAdvisoryTestFailure(signalError, results, false), false);
        assert.strictEqual(shouldAllowAdvisoryTestFailure(spawnError, results, false), false);

        const exitCodeError = new E2eProcessError('exit-code', 'node', ['run-tests'], { exitCode: 1 });
        assert.strictEqual(exitCodeError.reason, 'exit-code');
        assert.strictEqual(exitCodeError.exitCode, 1);
        assert.match(exitCodeError.message, /node run-tests exited with code 1/);
        assert.strictEqual(timeoutError.reason, 'timeout');
        assert.match(timeoutError.message, /node run-tests timed out/);
        assert.strictEqual(signalError.reason, 'signal');
        assert.strictEqual(signalError.signal, 'SIGTERM');
        assert.match(signalError.message, /node run-tests exited due to signal SIGTERM/);
        assert.strictEqual(spawnError.reason, 'spawn');
        assert.strictEqual(spawnError.cause, spawnCause);
        assert.match(spawnError.message, /Failed to start node run-tests/);
    });
});

function createReporterTest(title: string) {
    return {
        title,
        file: 'out/test-e2e/sample.e2e.test.js',
        duration: 5,
        slow: () => 75,
        fullTitle: () => `Aspire E2E ${title}`,
        currentRetry: () => 0,
        titlePath: () => ['Aspire E2E', title],
    };
}

function getProcessFailureModulePath() {
    return path.join(__dirname, '..', '..', 'scripts', 'e2e-process-failure.cjs');
}
