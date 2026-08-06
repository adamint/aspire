import { defineConfig } from '@vscode/test-cli';
import * as os from 'os';
import * as path from 'path';

// Local-only regression proof: a real Aspire app run WITHOUT C# Dev Kit, to show that Hot Reload
// support did not degrade the experience for users who do not have it.
//
// ASPIRE_HOT_RELOAD_PROOF_MODE selects the extension set:
//   csharp-only    -> .proof-extensions-csharp (ms-dotnettools.csharp, no Dev Kit)
//   no-extensions  -> .proof-extensions-none   (neither C# nor Dev Kit)
//
// ASPIRE_HOT_RELOAD_PROOF_ASSETS_DIR points at the directory holding the prepared extension and
// user-data folders. It defaults to this config's own directory, and is overridden when running the
// same proof against a baseline checkout so both runs share one (large) copied extension set.
const workspaceFolder = process.env.ASPIRE_HOT_RELOAD_PROOF_WORKSPACE ?? path.join(os.homedir(), 'aspire-hr-proof');
const mode = process.env.ASPIRE_HOT_RELOAD_PROOF_MODE ?? 'csharp-only';
const extensionsDirectory = mode === 'no-extensions' ? '.proof-extensions-none' : '.proof-extensions-csharp';
const assetsDirectory = process.env.ASPIRE_HOT_RELOAD_PROOF_ASSETS_DIR ?? new URL('.', import.meta.url).pathname;

export default defineConfig({
	files: 'out/test-proof/aspireNoDevKit.proof.js',
	version: 'insiders',
	workspaceFolder,
	launchArgs: [
		'--extensions-dir', path.join(assetsDirectory, extensionsDirectory),
		'--user-data-dir', path.join(assetsDirectory, `.proof-user-data-${mode}`),
		'--disable-workspace-trust'
	],
	mocha: {
		ui: 'tdd',
		timeout: 900000
	}
});
