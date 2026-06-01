import * as assert from 'assert';
import { getTreeAppHostLabel, waitForCommandOutcome, waitForDebugDashboardUrl, waitForDebugSessionStartup, waitForNoDebugSessions, waitForNoRunningAppHost, waitForRepositoryIdle, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, restoreWorkspaceCliPath, setCliUnavailableForE2E, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath } from './helpers/paths';
import { executeCommandFromPalette, openAspireView, waitForEditorTitle, waitForTreeItem } from './helpers/vscode';

suite('Aspire debug dashboard E2E', function () {
    this.timeout(240000);

    teardown(async () => {
        await setCliUnavailableForE2E(false);
        await restoreWorkspaceCliPath();
        await stopPrimaryAppHostIfRunning();
        await waitForNoRunningAppHost().catch(() => undefined);
    });

    test('debugs the AppHost and opens the dashboard in the integrated browser', async () => {
        const section = await openAspireView();
        await waitForRepositoryIdle();
        const discovered = await waitForWorkspaceAppHost();
        const appHostLabel = getTreeAppHostLabel(discovered.state);

        const idleItem = await waitForTreeItem(section, appHostLabel);
        await idleItem.expand();
        await waitForTreeItem(section, 'Debug AppHost');
        await executeE2eControlCommand({ name: 'debugAppHost', appHostPath: discovered.state.workspaceAppHostPath ?? getPrimaryAppHostProjectPath() });
        await waitForCommandOutcome('aspire-vscode.debugAppHost', 'success');

        await waitForDebugSessionStartup();
        const dashboard = await waitForDebugDashboardUrl();
        assert.ok(dashboard.state.debugSessions.some(session => session.dashboardUrl?.startsWith('http')));

        const browserTitle = await waitForEditorTitle('Simple Browser', 120000);
        assert.ok(browserTitle.includes('Simple Browser'));

        await executeCommandFromPalette('Debug: Stop');
        await waitForNoDebugSessions();
    });
});
