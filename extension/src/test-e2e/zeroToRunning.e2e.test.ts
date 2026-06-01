import * as assert from 'assert';
import * as fs from 'fs';
import { getCommandInvocationCount, getTerminalCommandCount, waitForCommandOutcome, waitForDebugDashboardUrl, waitForDebugSessionStartup, waitForNoDebugSessions, waitForRepositoryIdle, waitForSelectedWorkspaceAppHost, waitForTerminalCommand } from './helpers/assertions';
import { addIntegrationPackageToAppHost, clearBreakpoints, createEmptyAppHostProject, executeE2eControlCommand, getGeneratedAppHostPath, removeGeneratedProject, restoreWorkspaceAppHostConfig, restoreWorkspaceCliPath, setCliUnavailableForE2E, setSourceBreakpoint, setTerminalCommandExecutionSuppressedForE2E, stopAppHostIfRunning, writeWorkspaceAppHostConfigForPath } from './helpers/fixtures';
import { executeCommandFromPalette, openAspireView, waitForEditorTitle, waitForTreeItem } from './helpers/vscode';

suite('Aspire zero-to-running E2E', function () {
    this.timeout(360000);

    const projectName = 'ExtensionZeroToRunningApp';
    const appHostPath = getGeneratedAppHostPath(projectName);

    teardown(async () => {
        await setCliUnavailableForE2E(false);
        await setTerminalCommandExecutionSuppressedForE2E(false);
        await restoreWorkspaceCliPath();
        await clearBreakpoints().catch(() => undefined);
        await executeCommandFromPalette('Debug: Stop').catch(() => undefined);
        await waitForNoDebugSessions().catch(() => undefined);
        await stopAppHostIfRunning(appHostPath).catch(() => undefined);
        restoreWorkspaceAppHostConfig();
        removeGeneratedProject(projectName);
    });

    test('creates a new AppHost, adds a package, sets a breakpoint, and debugs to the dashboard', async () => {
        const section = await openAspireView();
        await waitForRepositoryIdle();

        await setTerminalCommandExecutionSuppressedForE2E(true);
        const beforeRoutedNewInvocation = getCommandInvocationCount('aspire-vscode.new');
        const beforeRoutedNewCommand = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeAspireCommand', commandId: 'aspire-vscode.new' });
        await waitForCommandOutcome('aspire-vscode.new', 'success', 60000, beforeRoutedNewInvocation);
        await waitForTerminalCommand(
            event => event.executionSuppressed && event.subcommand === 'new',
            'suppressed Aspire: New Project terminal routing',
            60000,
            beforeRoutedNewCommand);

        const beforeRoutedAddInvocation = getCommandInvocationCount('aspire-vscode.add');
        const beforeRoutedAddCommand = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeAspireCommand', commandId: 'aspire-vscode.add' });
        await waitForCommandOutcome('aspire-vscode.add', 'success', 60000, beforeRoutedAddInvocation);
        await waitForTerminalCommand(
            event => event.executionSuppressed && event.subcommand.startsWith('add'),
            'suppressed Aspire: Add Package terminal routing',
            60000,
            beforeRoutedAddCommand);
        await setTerminalCommandExecutionSuppressedForE2E(false);

        const projectRoot = await createEmptyAppHostProject(projectName);
        assert.ok(fs.existsSync(projectRoot));

        await addIntegrationPackageToAppHost('Aspire.Hosting.Redis', appHostPath);
        assert.match(fs.readFileSync(appHostPath, 'utf8'), /#:package Aspire\.Hosting\.Redis@/);

        writeWorkspaceAppHostConfigForPath(appHostPath);
        const beforeRefresh = getCommandInvocationCount('aspire-vscode.refreshAppHosts');
        await executeE2eControlCommand({ name: 'refreshAppHosts' });
        await waitForCommandOutcome('aspire-vscode.refreshAppHosts', 'success', 60000, beforeRefresh);
        const selected = await waitForSelectedWorkspaceAppHost(appHostPath);
        const appHostLabel = selected.state.workspaceAppHostName ?? 'apphost.cs';
        const appHostItem = await waitForTreeItem(section, appHostLabel, 60000);
        await appHostItem.expand();
        await waitForTreeItem(section, 'Debug AppHost');

        const source = fs.readFileSync(appHostPath, 'utf8');
        const breakpointLine = source.split(/\r?\n/).findIndex(line => line.includes('builder.Build().Run();'));
        assert.notStrictEqual(breakpointLine, -1);
        await executeE2eControlCommand({ name: 'openAppHostSource', appHostPath });
        assert.ok((await waitForEditorTitle('apphost.cs')).includes('apphost.cs'));
        await setSourceBreakpoint(appHostPath, breakpointLine);

        const beforeDebug = getCommandInvocationCount('aspire-vscode.debugAppHost');
        await executeE2eControlCommand({ name: 'debugAppHost', appHostPath });
        await waitForCommandOutcome('aspire-vscode.debugAppHost', 'success', 60000, beforeDebug);
        await waitForDebugSessionStartup(appHostPath);
        const dashboard = await waitForDebugDashboardUrl(appHostPath);
        assert.ok(dashboard.state.debugSessions.some(session => session.dashboardUrl?.startsWith('http')));

        const browserTitle = await waitForEditorTitle('Simple Browser', 120000);
        assert.ok(browserTitle.includes('Simple Browser'));

        await executeCommandFromPalette('Debug: Stop');
        await waitForNoDebugSessions();
    });
});
