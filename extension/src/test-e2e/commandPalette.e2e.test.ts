import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getCommandInvocationCount, getTerminalCommandCount, isSamePath, waitForCommandOutcome, waitForExtensionState, waitForRepositoryIdle, waitForTerminalCommand, waitForWorkspaceAppHost } from './helpers/assertions';
import { createAdditionalAppHostCandidate, executeE2eControlCommand, removeAdditionalAppHostCandidate, removeGlobalToolCmdShim, removeWorkspaceAppHostConfig, restoreE2eCliPathForE2E, restoreWorkspaceAppHostConfig, restoreWorkspaceCliPath, runE2eTeardown, setCliUnavailableForE2E, setE2eCliPathForE2E, setTerminalCommandExecutionSuppressedForE2E, writeGlobalToolCmdShim, writeWorkspaceCliPath } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath, getWorkspaceRoot } from './helpers/paths';
import { chooseActiveQuickPick, executeCommandFromPalette, openAspireView, waitForEditorTitle, waitForNotificationMessage, waitForTerminalChannel, waitForWorkbenchText } from './helpers/vscode';

suite('Aspire command palette E2E', function () {
    this.timeout(420000);

    teardown(async () => {
        await runE2eTeardown([
            () => executeE2eControlCommand({ name: 'closeAllEditors' }),
            () => setCliUnavailableForE2E(false),
            () => setTerminalCommandExecutionSuppressedForE2E(false),
            () => restoreE2eCliPathForE2E(),
            () => restoreWorkspaceCliPath(),
            () => restoreWorkspaceAppHostConfig(),
            () => removeAdditionalAppHostCandidate(),
            () => removeGlobalToolCmdShim(),
        ], 'Command palette E2E teardown failed.');
    });

    test('opens an Aspire terminal through the command palette with the configured CLI path', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        await waitForWorkspaceAppHost();

        const before = getCommandInvocationCount('aspire-vscode.openTerminal');
        await executeCommandFromPalette('Aspire: Open Aspire terminal');
        await waitForCommandOutcome('aspire-vscode.openTerminal', 'success', 60000, before);

        const channel = await waitForTerminalChannel('Aspire');
        assert.ok(channel.includes('Aspire'), `Expected Aspire terminal channel, got '${channel}'.`);
    });

    test('surfaces invalid CLI configuration as a notification and canceled command outcome', async () => {
        const missingCliPath = path.join(getWorkspaceRoot(), 'missing cli folder', process.platform === 'win32' ? 'aspire.cmd' : 'aspire');
        await writeWorkspaceCliPath(missingCliPath);
        await setCliUnavailableForE2E(true);
        const before = getCommandInvocationCount('aspire-vscode.openTerminal');
        await executeCommandFromPalette('Aspire: Open Aspire terminal');
        await waitForNotificationMessage('Aspire CLI is not available');
        await waitForCommandOutcome('aspire-vscode.openTerminal', 'canceled', 60000, before);
    });

    test('routes terminal commands through a configured Windows cmd wrapper path with spaces', async function () {
        if (process.platform !== 'win32') {
            this.skip();
        }

        await openAspireView();
        await waitForRepositoryIdle();
        await waitForWorkspaceAppHost();

        const wrapperDirectory = path.join(getWorkspaceRoot(), 'cli wrapper with spaces');
        const wrapperPath = path.join(wrapperDirectory, 'aspire.cmd');
        fs.mkdirSync(wrapperDirectory, { recursive: true });
        fs.writeFileSync(wrapperPath, '@echo off\r\nif "%~1"=="--version" (\r\n  echo 13.5.0-pr.e2e\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n');
        await setE2eCliPathForE2E(undefined);
        await writeWorkspaceCliPath(wrapperPath);
        await setTerminalCommandExecutionSuppressedForE2E(true);

        const beforeInvocation = getCommandInvocationCount('aspire-vscode.new');
        const beforeTerminalCommand = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeAspireCommand', commandId: 'aspire-vscode.new' });
        await waitForCommandOutcome('aspire-vscode.new', 'success', 60000, beforeInvocation);

        const terminalCommand = await waitForTerminalCommand(
            event => event.executionSuppressed && event.subcommand === 'new' && event.commandLine.includes(`& "${wrapperPath}" new`),
            'Windows cmd wrapper terminal routing',
            60000,
            beforeTerminalCommand);
        assert.strictEqual(terminalCommand.executionSuppressed, true);
    });

    test('executes a .NET global-tool aspire.cmd shim end-to-end on Windows', async function () {
        if (process.platform !== 'win32') {
            this.skip();
        }

        // Regression coverage for the Windows cmd-shim fix (dotnet/aspire#17306): a real
        // ~/.dotnet/tools/aspire.cmd forwards its arguments to the CLI via %*, and the extension can
        // only launch it through the cmd.exe /c wrapper with windowsVerbatimArguments built by
        // getCliExecutionCommand. The sibling 'routes terminal commands...' test suppresses
        // execution, so this is the only coverage that actually spawns the shim from the VS Code
        // process and drives a CLI-backed surface (AppHost discovery) through it.
        const { shimPath, invocationMarkerDirectory } = writeGlobalToolCmdShim();
        try {
            // Clear the harness-provided native CLI path so resolveCliPath falls through to the
            // configured .cmd shim and must execute it, mirroring a user whose only Aspire CLI is a
            // global-tool command shim.
            await setE2eCliPathForE2E(undefined);
            await writeWorkspaceCliPath(shimPath);

            await openAspireView();
            await waitForRepositoryIdle();

            const before = getCommandInvocationCount('aspire-vscode.refreshAppHosts');
            await executeE2eControlCommand({ name: 'refreshAppHosts' });
            await waitForCommandOutcome('aspire-vscode.refreshAppHosts', 'success', 120000, before);

            const discovered = await waitForWorkspaceAppHost();
            assert.strictEqual(discovered.state.hasError, false, discovered.state.errorMessage);
            assert.ok(
                discovered.state.workspaceAppHostCandidatePaths.some(candidate => isSamePath(candidate, getPrimaryAppHostProjectPath())),
                'Expected the workspace AppHost to be discovered through the aspire.cmd shim.');

            // config info and aspire ls ran through the shim, so it must have recorded at least one
            // invocation. This proves the cmd.exe wrapper actually spawned the .cmd rather than the
            // extension resolving some other CLI on PATH or a file-only discovery fallback.
            assert.ok(
                fs.existsSync(invocationMarkerDirectory) && fs.readdirSync(invocationMarkerDirectory).length > 0,
                'Expected the aspire.cmd shim to have been executed by the extension.');
        }
        finally {
            await runE2eTeardown([
                () => restoreE2eCliPathForE2E(),
                () => restoreWorkspaceCliPath(),
                () => removeGlobalToolCmdShim(),
            ], 'Global-tool cmd shim E2E cleanup failed.');
        }
    });

    test('opens settings UI and writes launch configuration through command palette commands', async () => {
        const settingsBefore = getCommandInvocationCount('aspire-vscode.settings');
        await executeCommandFromPalette('Aspire: Extension settings');
        await waitForCommandOutcome('aspire-vscode.settings', 'success', 60000, settingsBefore);
        await waitForWorkbenchText('Settings');
        await waitForWorkbenchText('Aspire: App Host Discovery Timeout Ms');
        await executeE2eControlCommand({ name: 'closeAllEditors' });

        const configureBefore = getCommandInvocationCount('aspire-vscode.configureLaunchJson');
        await executeCommandFromPalette('Aspire: Configure launch.json file');
        await chooseActiveQuickPick('Do not open the dashboard');
        await waitForCommandOutcome('aspire-vscode.configureLaunchJson', 'success', 60000, configureBefore);
        assert.ok((await waitForEditorTitle('launch.json')).includes('launch.json'));

        const launchJsonPath = path.join(getWorkspaceRoot(), '.vscode', 'launch.json');
        const launchJson = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8')) as { configurations?: Array<{ type?: string; request?: string; dashboardBrowser?: string }> };
        assert.ok(launchJson.configurations?.some(configuration => configuration.type === 'aspire' && configuration.request === 'launch' && configuration.dashboardBrowser === 'none'));
    });

    test('observes multiple AppHost candidates without selecting the wrong one', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        removeWorkspaceAppHostConfig();
        const secondaryAppHostPath = createAdditionalAppHostCandidate('AspireE2E.SecondAppHost', 'single-file');
        const beforeRefresh = getCommandInvocationCount('aspire-vscode.refreshAppHosts');
        await executeE2eControlCommand({ name: 'refreshAppHosts' });
        await waitForCommandOutcome('aspire-vscode.refreshAppHosts', 'success', 60000, beforeRefresh);

        const stateFile = await waitForExtensionState(
            file => file.state.workspaceAppHostCandidatePaths.some(candidate => isSamePath(candidate, secondaryAppHostPath)),
            'secondary AppHost candidate',
            180000);

        assert.ok(stateFile.state.workspaceAppHostCandidatePaths.length >= 2);
    });
});
