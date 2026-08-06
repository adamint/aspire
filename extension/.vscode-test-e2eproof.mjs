import { defineConfig } from '@vscode/test-cli';
import * as os from 'os';
import * as path from 'path';

// Local-only end-to-end proof: real Aspire app + real Aspire CLI + real C# Dev Kit.
// Point ASPIRE_HOT_RELOAD_PROOF_WORKSPACE at the proof fixture described in src/test-proof/README.md.
const workspaceFolder = process.env.ASPIRE_HOT_RELOAD_PROOF_WORKSPACE ?? path.join(os.homedir(), 'aspire-hr-proof');

export default defineConfig({
	files: 'out/test-proof/aspireHotReloadE2E.proof.js',
	version: 'insiders',
	workspaceFolder,
	launchArgs: [
		'--extensions-dir', new URL('.proof-extensions', import.meta.url).pathname,
		'--user-data-dir', new URL('.proof-user-data', import.meta.url).pathname,
		'--disable-workspace-trust'
	],
	mocha: {
		ui: 'tdd',
		timeout: 900000
	}
});
