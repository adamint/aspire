'use strict';

const { hasCompletedMochaTestFailures } = require('./e2e-mocha-results.cjs');

const VALID_REASONS = new Set(['exit-code', 'timeout', 'signal', 'spawn']);

class E2eProcessError extends Error {
  constructor(reason, command, args, options = {}) {
    if (!VALID_REASONS.has(reason)) {
      throw new TypeError(`Unsupported E2E process failure reason '${reason}'.`);
    }

    const { exitCode = null, signal = null, cause } = options;
    super(createMessage(reason, command, args, exitCode, signal, cause), cause === undefined ? undefined : { cause });
    this.name = 'E2eProcessError';
    this.reason = reason;
    this.command = command;
    this.args = [...args];
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

function shouldAllowAdvisoryTestFailure(error, results, cleanupFailed) {
  return error instanceof E2eProcessError
    && error.reason === 'exit-code'
    && hasCompletedMochaTestFailures(results)
    && !cleanupFailed;
}

function createMessage(reason, command, args, exitCode, signal, cause) {
  const commandLine = formatCommand(command, args);
  switch (reason) {
    case 'exit-code':
      return `${commandLine} exited with code ${exitCode ?? 'unknown'}.`;
    case 'timeout':
      return `${commandLine} timed out.`;
    case 'signal':
      return `${commandLine} exited due to signal ${signal ?? 'unknown'}.`;
    case 'spawn':
      return `Failed to start ${commandLine}: ${cause instanceof Error ? cause.message : String(cause ?? 'unknown error')}`;
    default:
      throw new TypeError(`Unsupported E2E process failure reason '${reason}'.`);
  }
}

function formatCommand(command, args) {
  return [command, ...args]
    .map(segment => /\s/.test(segment) ? JSON.stringify(segment) : segment)
    .join(' ');
}

module.exports = {
  E2eProcessError,
  shouldAllowAdvisoryTestFailure,
};
