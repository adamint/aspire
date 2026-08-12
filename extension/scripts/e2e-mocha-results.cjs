'use strict';

const BLOCKING_HARNESS_ERROR_NAMES = new Set([
  'InvalidSessionIdError',
  'NoSuchSessionError',
  'SessionNotCreatedError',
]);

function hasCompletedMochaTestFailures(results) {
  if (!Array.isArray(results?.tests) || !Array.isArray(results?.failures) || results.failures.length === 0) {
    return false;
  }

  // The reporter writes this shape only after Mocha emits EVENT_RUN_END:
  //   { tests: [{ fullTitle: "suite test" }],
  //     failures: [{ fullTitle: "suite test", err: { name: "NoSuchSessionError" } }] }
  // Startup crashes and hook failures can appear without a completed matching test. Require every
  // failure to match EVENT_TEST_END output, and keep browser-session lifecycle failures blocking
  // even though Mocha records them against a completed test.
  const completedTestTitles = new Set(results.tests.map(test => test.fullTitle ?? test.title));
  return results.failures.every(failure =>
    completedTestTitles.has(failure.fullTitle ?? failure.title)
    && !BLOCKING_HARNESS_ERROR_NAMES.has(failure.err?.name));
}

module.exports = {
  hasCompletedMochaTestFailures,
};
