'use strict';

const path = require('path');

const resultsDir = process.env.ASPIRE_EXTENSION_E2E_RESULTS_DIR || path.join('.test-results', 'e2e');

module.exports = {
  ui: 'tdd',
  timeout: 240000,
  reporter: 'json',
  reporterOptions: {
    output: path.join(resultsDir, 'mocha.json'),
  },
  parallel: false,
  spec: 'out/test-e2e/**/*.e2e.test.js',
};
