import { defineConfig } from '@vscode/test-cli';

// Local-only harness that runs against a REAL C# Dev Kit installation rather than a stub.
// Not part of `yarn test`; run with `yarn vscode-test --config .vscode-test-devkit.mjs`.
export default defineConfig({
	files: 'out/test-proof/**/*.proof.js',
	version: 'insiders',
	workspaceFolder: process.env.PROOF_WORKSPACE,
	launchArgs: [
		'--extensions-dir', new URL('.proof-extensions', import.meta.url).pathname,
		'--disable-workspace-trust'
	],
	download: {
		timeout: 180000
	},
	mocha: {
		ui: 'tdd',
		timeout: 300000
	}
});
