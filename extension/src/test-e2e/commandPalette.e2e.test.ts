import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getCommandInvocationCount, getTerminalCommandCount, isSamePath, waitForCommandOutcome, waitForExtensionState, waitForRepositoryIdle, waitForSelectedWorkspaceAppHost, waitForTerminalCommand, waitForWorkspaceAppHost } from './helpers/assertions';
import { createAdditionalAppHostCandidate, executeE2eControlCommand, removeAdditionalAppHostCandidate, removeWorkspaceAppHostConfig, restoreE2eCliPathForE2E, restoreWorkspaceAppHostConfig, restoreWorkspaceCliPath, runE2eTeardown, setCliUnavailableForE2E, setE2eCliPathForE2E, setTerminalCommandExecutionSuppressedForE2E, writeWorkspaceCliPath, writeWorkspaceSetting } from './helpers/fixtures';
import { getWorkspaceRoot } from './helpers/paths';
import { chooseActiveQuickPick, executeCommandFromPalette, openAspireView, waitForEditorTitle, waitForNotificationMessage, waitForTerminalChannel, waitForWorkbenchText } from './helpers/vscode';

suite('Aspire command palette E2E', function () {
    this.timeout(420000);

    teardown(async () => {
        await runE2eTeardown([
            () => executeE2eControlCommand({ name: 'closeAllEditors' }),
            () => setCliUnavailableForE2E(false),
            () => setTerminalCommandExecutionSuppressedForE2E(false),
            () => writeWorkspaceSetting('aspire.nugetSource', undefined),
            () => restoreE2eCliPathForE2E(),
            () => restoreWorkspaceCliPath(),
            () => restoreWorkspaceAppHostConfig(),
            () => removeAdditionalAppHostCandidate(),
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

    test('routes the configured NuGet source through the registered new and add commands', async () => {
        const source = 'https://example.invalid/v3/index.json?feed="quoted value"&marker=\'$(touch no);|$HOME\'';
        writeWorkspaceSetting('aspire.nugetSource', source);

        await openAspireView();
        await waitForRepositoryIdle();
        const discovered = await waitForSelectedWorkspaceAppHost();
        const expectedAppHostPath = discovered.state.workspaceAppHostPath;
        assert.ok(expectedAppHostPath, 'Expected a selected workspace AppHost path.');

        await setTerminalCommandExecutionSuppressedForE2E(true);

        let beforeInvocation = getCommandInvocationCount('aspire-vscode.new');
        let beforeTerminalCommand = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeAspireCommand', commandId: 'aspire-vscode.new' });
        await waitForCommandOutcome('aspire-vscode.new', 'success', 60000, beforeInvocation);
        const newTerminalCommand = await waitForTerminalCommand(
            event => event.executionSuppressed && event.subcommand === 'new',
            'suppressed Aspire: New Project terminal routing with a configured NuGet source',
            60000,
            beforeTerminalCommand);
        assert.strictEqual(newTerminalCommand.executionSuppressed, true);
        assert.strictEqual(newTerminalCommand.subcommand, 'new');
        assert.deepStrictEqual(newTerminalCommand.additionalArgs, ['--source', source]);
        assert.ok(
            newTerminalCommand.commandLine.includes(getQuotedShellArgumentPair('--source', source)),
            `Expected new command line to quote the configured NuGet source once. Command line: ${newTerminalCommand.commandLine}`);

        beforeInvocation = getCommandInvocationCount('aspire-vscode.add');
        beforeTerminalCommand = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeAspireCommand', commandId: 'aspire-vscode.add' });
        await waitForCommandOutcome('aspire-vscode.add', 'success', 60000, beforeInvocation);
        const addTerminalCommand = await waitForTerminalCommand(
            event => event.executionSuppressed && event.subcommand === 'add',
            'suppressed Aspire: Add Package terminal routing with a configured NuGet source',
            60000,
            beforeTerminalCommand);
        assert.strictEqual(addTerminalCommand.executionSuppressed, true);
        assert.strictEqual(addTerminalCommand.subcommand, 'add');
        assert.deepStrictEqual(addTerminalCommand.additionalArgs, ['--apphost', expectedAppHostPath, '--source', source]);
        assert.ok(
            addTerminalCommand.commandLine.includes(getQuotedShellArgumentPair('--source', source)),
            `Expected add command line to quote the configured NuGet source once. Command line: ${addTerminalCommand.commandLine}`);
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
            file => file.state.isWorkspaceAppHostDiscoveryComplete
                && !file.state.isRepositoryLoading
                && file.state.workspaceAppHostCandidatePaths.length >= 2
                && file.state.workspaceAppHostCandidatePaths.some(candidate => isSamePath(candidate, secondaryAppHostPath)),
            'completed discovery with multiple AppHost candidates',
            180000);

        assert.ok(stateFile.state.workspaceAppHostCandidatePaths.length >= 2);
    });
});

function quoteExpectedShellArg(arg: string): string {
    if (process.platform === 'win32') {
        return `"${arg.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')}"`;
    }

    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function getQuotedShellArgumentPair(flag: string, value: string): string {
    return `${quoteExpectedShellArg(flag)} ${quoteExpectedShellArg(value)}`;
}
