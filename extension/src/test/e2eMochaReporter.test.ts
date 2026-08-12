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

    test('process failure: exit code includes visible diagnostics', () => {
        const { E2eProcessError } = require(getProcessFailureModulePath());
        const exitCodeError = new E2eProcessError('exit-code', 'node', ['run-tests'], {
            exitCode: 1,
            diagnosticsSuffix,
        });

        assert.strictEqual(exitCodeError.reason, 'exit-code');
        assert.strictEqual(exitCodeError.exitCode, 1);
        assert.strictEqual(exitCodeError.diagnosticsSuffix, diagnosticsSuffix);
        assert.strictEqual(exitCodeError.message, `node run-tests exited with code 1.${diagnosticsSuffix}`);
    });

    test('process failure: timeout includes visible diagnostics', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const timeoutError = new E2eProcessError('timeout', 'node', ['run-tests'], {
            timeout: 60000,
            diagnosticsSuffix,
        });
        const forcedTimeoutError = new E2eProcessError('timeout', 'node', ['run-tests'], {
            timeout: 60000,
            didNotExit: true,
            diagnosticsSuffix,
        });

        assert.strictEqual(shouldAllowAdvisoryTestFailure(timeoutError, createCompletedMochaResults(), false), false);
        assert.strictEqual(shouldAllowAdvisoryTestFailure(forcedTimeoutError, createCompletedMochaResults(), false), false);
        assert.strictEqual(timeoutError.reason, 'timeout');
        assert.strictEqual(timeoutError.timeout, 60000);
        assert.strictEqual(timeoutError.didNotExit, false);
        assert.strictEqual(timeoutError.diagnosticsSuffix, diagnosticsSuffix);
        assert.strictEqual(timeoutError.message, `node run-tests timed out after 60000ms.${diagnosticsSuffix}`);
        assert.strictEqual(forcedTimeoutError.reason, 'timeout');
        assert.strictEqual(forcedTimeoutError.timeout, 60000);
        assert.strictEqual(forcedTimeoutError.didNotExit, true);
        assert.strictEqual(forcedTimeoutError.diagnosticsSuffix, diagnosticsSuffix);
        assert.strictEqual(forcedTimeoutError.message, `node run-tests timed out after 60000ms and did not exit after process-tree termination.${diagnosticsSuffix}`);
    });

    test('process failure: signal includes visible diagnostics', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const signalError = new E2eProcessError('signal', 'node', ['run-tests'], {
            signal: 'SIGTERM',
            diagnosticsSuffix,
        });

        assert.strictEqual(shouldAllowAdvisoryTestFailure(signalError, createCompletedMochaResults(), false), false);
        assert.strictEqual(signalError.reason, 'signal');
        assert.strictEqual(signalError.signal, 'SIGTERM');
        assert.strictEqual(signalError.diagnosticsSuffix, diagnosticsSuffix);
        assert.strictEqual(signalError.message, `node run-tests exited due to signal SIGTERM.${diagnosticsSuffix}`);
    });

    test('process failure: spawn includes visible diagnostics', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const spawnCause = new Error('spawn EPERM');
        const spawnError = new E2eProcessError('spawn', 'node', ['run-tests'], {
            cause: spawnCause,
            diagnosticsSuffix,
        });

        assert.strictEqual(shouldAllowAdvisoryTestFailure(spawnError, createCompletedMochaResults(), false), false);
        assert.strictEqual(spawnError.reason, 'spawn');
        assert.strictEqual(spawnError.cause, spawnCause);
        assert.strictEqual(spawnError.diagnosticsSuffix, diagnosticsSuffix);
        assert.strictEqual(spawnError.message, `Failed to start node run-tests: spawn EPERM.${diagnosticsSuffix}`);
    });

    test('process failure: completed Mocha exit-code failure is advisory', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const exitCodeError = new E2eProcessError('exit-code', 'node', ['run-tests'], {
            exitCode: 1,
            diagnosticsSuffix,
        });

        assert.strictEqual(shouldAllowAdvisoryTestFailure(exitCodeError, createCompletedMochaResults(), false), true);
    });

    test('process failure: cleanup failure keeps completed Mocha failure blocking', () => {
        const { E2eProcessError, shouldAllowAdvisoryTestFailure } = require(getProcessFailureModulePath());
        const exitCodeError = new E2eProcessError('exit-code', 'node', ['run-tests'], {
            exitCode: 1,
            diagnosticsSuffix,
        });

        assert.strictEqual(shouldAllowAdvisoryTestFailure(exitCodeError, createCompletedMochaResults(), true), false);
    });
});

const diagnosticsSuffix = ' Diagnostics are under out/test-e2e-results and out/test-e2e-storage-diagnostics.';

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

function createCompletedMochaResults() {
    const failedTest = { fullTitle: 'Aspire E2E starts an AppHost' };
    return {
        tests: [failedTest],
        failures: [failedTest],
    };
}
