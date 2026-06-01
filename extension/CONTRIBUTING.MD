# Set up your machine to contribute

## Install Prerequisites

- Node.js (LTS version)
- Yarn accessible in the PATH
- Visual Studio Code (latest) or Visual Studio Code Insiders
- [Aspire CLI](https://aspire.dev/get-started/install-cli/) must be installed and available in the PATH

## Build CLI

Run `build.ps1` (Windows) or `build.sh` (Mac/Linux) to compile the Aspire CLI, install dependencies, and localize.

## Run extension locally

- Open the extension folder in Visual Studio Code.
- Launch either the `Run Extension` or `Run Extension (cli stop on entry)` launch configuration. The latter will set an environment variable that causes the CLI to wait until a debugger is attached to execute its logic.

### Optional: set the CLI path

If you want to effectively debug the Aspire CLI together with the Aspire VS Code extension, you must set the `Aspire Cli Executable Path` setting to the Aspire CLI output path. The output path, relative to the Aspire repository root directory, is `artifacts/bin/Aspire.Cli/Debug/net10.0/aspire`.

You may also want to use the `Run Extension (cli stop on entry)` launch configuration, as `Run Extension` does not prevent the Aspire CLI from executing immediately.

You can use the `Aspire: Extension settings` command to open VS Code settings directly to the Aspire extension category.

## Updating dependency overrides

The extension is built with **yarn**, so `package.json` uses `resolutions` for transitive dependency pins and `yarn.lock` is the authoritative lockfile.

When pinning a transitive dependency (e.g. to address a security advisory), add the pin to `resolutions` and regenerate `yarn.lock` in the same change:

```bash
yarn install
```

The build rejects public npm registry URLs in `yarn.lock`; ensure regenerated entries resolve through the internal `dotnet-public-npm` feed.

## End-to-end tests

The extension has unit tests under `src/test` and UI end-to-end tests under `src/test-e2e`. The E2E suite runs a packaged VSIX in a real VS Code instance through ExTester, using a real Aspire CLI and a generated AppHost workspace.

Run the local checks from the extension directory:

```bash
corepack yarn@1.22.22 install --frozen-lockfile --non-interactive
corepack yarn@1.22.22 test
ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
```

On Linux, run the E2E command under `xvfb-run -a` when no desktop session is available. On Windows, `ASPIRE_EXTENSION_E2E_CLI_PATH` can point at an `.exe` or `.cmd` wrapper, including paths with spaces. Set `ASPIRE_EXTENSION_E2E_VSIX=/path/to/aspire-extension.vsix` to test an existing package instead of letting the runner create one.

The suite can be sharded by running separate VS Code windows/processes, which is how CI keeps the long UI paths parallel instead of relying on Mocha-level parallelism inside one extension host:

```bash
ASPIRE_EXTENSION_E2E_SHARD=command-palette ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/commandPalette.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=settings-files ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/settingsFiles.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=discovery-configuration ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/discoveryConfiguration.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=apphost-tree ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/appHostTree.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=tree-actions ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/treeActions.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=debug-dashboard ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/debugDashboard.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=zero-to-running ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/zeroToRunning.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=package-surface ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/packageSurface.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
ASPIRE_EXTENSION_E2E_SHARD=edge-cases ASPIRE_EXTENSION_E2E_SPEC=out/test-e2e/test-e2e/edgeCases.e2e.test.js ASPIRE_EXTENSION_E2E_CLI_PATH=/path/to/aspire corepack yarn@1.22.22 test:e2e
```

The current shards cover command palette and terminal routing, settings-file creation/opening with an isolated Aspire home, workspace AppHost discovery/configuration changes, AppHost run/stop/resource rendering, tree action commands for copy/open/log/resource operations, debug/dashboard lifecycle, a zero-to-running flow that creates a C# AppHost through the real Aspire terminal path, adds an integration package, registers a source breakpoint, and debugs the generated AppHost, the `package.json` contribution surface including exact activation events, command registration, menu/view/settings inventory, JSON validation, walkthrough command registration, CodeLens routing, and debug launch command routing, plus negative-path edge cases for invalid control payloads, missing tree targets, CLI-independent settings commands, and launch-state cleanup.

Diagnostics are left under `extension/.test-results`, `extension/.test-storage`, and `extension/.test-workspaces`, with shard-specific subdirectories when `ASPIRE_EXTENSION_E2E_SHARD` is set. The runner also sets `ASPIRE_HOME` to an isolated per-run directory and copies it into diagnostics before cleanup so settings-file failures do not touch or depend on the real user profile. These folders are ignored by git and are uploaded by CI when the E2E job runs.

E2E tests should avoid fixed sleeps for readiness. Prefer the observation state written by the extension test bridge, ExTester wait APIs, unique generated workspaces, explicit per-phase timeouts, and cleanup through `aspire stop --apphost`. This is intentionally stricter than a normal smoke test because the suite runs a real VS Code, CLI, AppHost, terminal, and dashboard path. See https://github.com/microsoft/aspire/issues/17727 for the original tracking issue.