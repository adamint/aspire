import * as assert from 'assert';
import { getCommandInvocationCount, getTreeAppHostLabel, waitForAppHostLaunching, waitForCommandOutcome, waitForDebugDashboardUrl, waitForDebugSessionStartup, waitForHttpText, waitForNoDebugSessions, waitForNoRunningAppHost, waitForRepositoryIdle, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, restoreWorkspaceCliPath, runE2eTeardown, setCliUnavailableForE2E, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath } from './helpers/paths';
import { openAspireView, waitForEditorTitle, waitForTreeItem, waitForWorkbenchTextAfterIntegratedBrowserNavigation } from './helpers/vscode';

suite('Aspire debug dashboard E2E', function () {
    this.timeout(240000);

    teardown(async () => {
        await runE2eTeardown([
            () => setCliUnavailableForE2E(false),
            () => restoreWorkspaceCliPath(),
            () => executeE2eControlCommand({ name: 'stopDebugging' }),
            () => stopPrimaryAppHostIfRunning(),
            () => waitForNoDebugSessions().catch(() => undefined),
            () => waitForNoRunningAppHost().catch(() => undefined),
        ], 'Debug dashboard E2E teardown failed.');
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
        const dashboardUrl = dashboard.state.debugSessions.find(session => session.dashboardUrl?.startsWith('http'))?.dashboardUrl;
        assert.ok(dashboardUrl);

        await waitForHttpText(dashboardUrl, 'Aspire', 120000, new URL(dashboardUrl).origin);
        assert.ok((await waitForEditorTitle(new URL(dashboardUrl).host, 120000, { matchCase: false })).toLowerCase().includes(new URL(dashboardUrl).host.toLowerCase()));
        if (process.platform !== 'win32') {
            // Chromium webview text extraction is unreliable on hosted Windows runners after
            // integrated-browser navigation. The HTTP probe above proves the dashboard rendered
            // content, and Linux keeps the stronger webview text extraction assertion.
            const browserText = await waitForWorkbenchTextAfterIntegratedBrowserNavigation('Resources');
            assert.ok(browserText.includes('Resources'));
        }

        await executeE2eControlCommand({ name: 'stopDebugging' });
        await waitForNoDebugSessions();
    });
});
