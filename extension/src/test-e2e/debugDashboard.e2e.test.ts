import * as assert from 'assert';
import { getCommandInvocationCount, getTreeAppHostLabel, waitForAppHostLaunching, waitForCommandOutcome, waitForDebugDashboardUrl, waitForDebugSessionStartup, waitForNoDebugSessions, waitForNoRunningAppHost, waitForRepositoryIdle, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, restoreWorkspaceCliPath, setCliUnavailableForE2E, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath } from './helpers/paths';
import { openAspireView, waitForTreeItem, waitForWorkbenchTextAfterIntegratedBrowserNavigation } from './helpers/vscode';

suite('Aspire debug dashboard E2E', function () {
    this.timeout(240000);

    teardown(async () => {
        await setCliUnavailableForE2E(false);
        await restoreWorkspaceCliPath();
        await stopPrimaryAppHostIfRunning();
        await waitForNoRunningAppHost().catch(() => undefined);
    });

    test('debugs the AppHost and opens the dashboard in the integrated browser', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        const discovered = await waitForWorkspaceAppHost();
        const appHostLabel = getTreeAppHostLabel(discovered.state);
        const section = await openAspireView();

        const idleItem = await waitForTreeItem(section, appHostLabel);
        await idleItem.expand();
        await waitForTreeItem(section, 'Debug AppHost');
        const appHostPath = discovered.state.workspaceAppHostPath ?? getPrimaryAppHostProjectPath();
        const before = getCommandInvocationCount('aspire-vscode.debugAppHost');
        await executeE2eControlCommand({ name: 'debugAppHost', appHostPath }, { waitFor: 'started' });
        await waitForAppHostLaunching(appHostPath);
        await waitForCommandOutcome('aspire-vscode.debugAppHost', 'success', 60000, before);

        await waitForDebugSessionStartup();
        const dashboard = await waitForDebugDashboardUrl();
        assert.ok(dashboard.state.debugSessions.some(session => session.dashboardUrl?.startsWith('http')));

        const browserText = await waitForWorkbenchTextAfterIntegratedBrowserNavigation('Resources');
        assert.ok(browserText.includes('Resources'));

        await executeE2eControlCommand({ name: 'stopDebugging' });
        await waitForNoDebugSessions();
    });
});
