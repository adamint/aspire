import * as assert from 'assert';
import * as path from 'path';
import { getCommandInvocationCount, isSamePath, waitForCommandOutcome, waitForDashboardUrl, waitForExtensionState, waitForRepositoryIdle, waitForResource, waitForResourceState, waitForRunningAppHost, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, restoreWorkspaceCliPath, setCliUnavailableForE2E, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath } from './helpers/paths';
import { openAspireView, waitForEditorTitle } from './helpers/vscode';

suite('Aspire tree action command E2E', function () {
    this.timeout(300000);

    teardown(async () => {
        await setCliUnavailableForE2E(false);
        await restoreWorkspaceCliPath();
        await stopPrimaryAppHostIfRunning();
    });

    test('routes view, copy, endpoint, log, and resource commands through tree handlers', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        const discovered = await waitForWorkspaceAppHost();
        const appHostPath = discovered.state.workspaceAppHostPath ?? getPrimaryAppHostProjectPath();

        let before = getCommandInvocationCount('aspire-vscode.switchToGlobalView');
        await executeE2eControlCommand({ name: 'switchToGlobalView' });
        await waitForCommandOutcome('aspire-vscode.switchToGlobalView', 'success', 60000, before);
        await waitForExtensionState(file => file.state.viewMode === 'global', 'global AppHost view');

        before = getCommandInvocationCount('aspire-vscode.globalRefreshAppHosts');
        await executeE2eControlCommand({ name: 'globalRefreshAppHosts' });
        await waitForCommandOutcome('aspire-vscode.globalRefreshAppHosts', 'success', 60000, before);

        before = getCommandInvocationCount('aspire-vscode.switchToWorkspaceView');
        await executeE2eControlCommand({ name: 'switchToWorkspaceView' });
        await waitForCommandOutcome('aspire-vscode.switchToWorkspaceView', 'success', 60000, before);
        await waitForExtensionState(file => file.state.viewMode === 'workspace', 'workspace AppHost view');

        before = getCommandInvocationCount('aspire-vscode.runAppHost');
        await executeE2eControlCommand({ name: 'runAppHost', appHostPath });
        await waitForCommandOutcome('aspire-vscode.runAppHost', 'success', 120000, before);
        await waitForRunningAppHost();
        await waitForResourceState('e2e-worker', ['Running'], 180000);
        await waitForDashboardUrl();

        const copiedAppHost = await executeE2eControlCommand({ name: 'copyAppHostPath', appHostPath });
        assert.ok(isSamePath(String(copiedAppHost.result), appHostPath));

        const openedSource = await executeE2eControlCommand({ name: 'openAppHostSource', appHostPath });
        assert.ok(String((openedSource.result as { fileName?: string }).fileName).endsWith(path.join('AspireE2E.AppHost', 'AppHost.cs')));

        const viewedSource = await executeE2eControlCommand({ name: 'viewAppHostSource', appHostPath });
        assert.ok(String((viewedSource.result as { uri?: string }).uri).startsWith('aspire-source:'));

        const copiedResourceName = await executeE2eControlCommand({ name: 'copyResourceName', appHostPath, resourceName: 'e2e-worker' });
        assert.strictEqual(copiedResourceName.result, 'e2e-worker');

        const copiedEndpointUrl = await executeE2eControlCommand({ name: 'copyEndpointUrl', appHostPath, resourceName: 'e2e-worker' });
        assert.ok(String(copiedEndpointUrl.result).startsWith('http'));

        before = getCommandInvocationCount('aspire-vscode.openInIntegratedBrowser');
        await executeE2eControlCommand({ name: 'openInIntegratedBrowser', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.openInIntegratedBrowser', 'success', 60000, before);
        assert.ok((await waitForEditorTitle('Simple Browser', 120000)).includes('Simple Browser'));

        const viewedLog = await executeE2eControlCommand({ name: 'viewAppHostLogFile', appHostPath });
        const viewedLogFileName = (viewedLog.result as { fileName?: string }).fileName;
        assert.ok(viewedLogFileName && path.isAbsolute(viewedLogFileName));

        const copiedLogPath = await executeE2eControlCommand({ name: 'copyLogFilePath', appHostPath });
        assert.ok(path.isAbsolute(String(copiedLogPath.result)));

        before = getCommandInvocationCount('aspire-vscode.viewResourceLogs');
        await executeE2eControlCommand({ name: 'viewResourceLogs', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.viewResourceLogs', 'success', 60000, before);

        await waitForResource('e2e-worker');
        await waitForResourceState('e2e-worker', ['Running'], 90000);

        before = getCommandInvocationCount('aspire-vscode.stopResource');
        await executeE2eControlCommand({ name: 'stopResource', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.stopResource', 'success', 60000, before);
        await waitForResourceState('e2e-worker', ['Stopped', 'Finished', 'Exited'], 90000);

        before = getCommandInvocationCount('aspire-vscode.startResource');
        await executeE2eControlCommand({ name: 'startResource', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.startResource', 'success', 60000, before);
        await waitForResourceState('e2e-worker', ['Running'], 90000);

        before = getCommandInvocationCount('aspire-vscode.restartResource');
        await executeE2eControlCommand({ name: 'restartResource', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.restartResource', 'success', 60000, before);
        await waitForResourceState('e2e-worker', ['Running'], 120000);
    });
});
