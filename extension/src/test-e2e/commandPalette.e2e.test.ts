import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getCommandInvocationCount, isSamePath, waitForCommandOutcome, waitForExtensionState, waitForRepositoryIdle, waitForWorkspaceAppHost } from './helpers/assertions';
import { createAdditionalAppHostCandidate, executeE2eControlCommand, removeAdditionalAppHostCandidate, removeWorkspaceAppHostConfig, restoreWorkspaceAppHostConfig, restoreWorkspaceCliPath, setCliUnavailableForE2E, writeWorkspaceCliPath } from './helpers/fixtures';
import { getWorkspaceRoot } from './helpers/paths';
import { executeCommandFromPalette, openAspireView, waitForEditorTitle, waitForNotificationMessage, waitForTerminalChannel, waitForWorkbenchText } from './helpers/vscode';

suite('Aspire command palette E2E', function () {
    this.timeout(180000);

    teardown(async () => {
        await executeE2eControlCommand({ name: 'closeAllEditors' }).catch(() => undefined);
        await setCliUnavailableForE2E(false);
        await restoreWorkspaceCliPath();
        restoreWorkspaceAppHostConfig();
        removeAdditionalAppHostCandidate();
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

    test('opens settings UI and writes launch configuration through command palette commands', async () => {
        const settingsBefore = getCommandInvocationCount('aspire-vscode.settings');
        await executeCommandFromPalette('Aspire: Extension settings');
        await waitForCommandOutcome('aspire-vscode.settings', 'success', 60000, settingsBefore);
        await waitForWorkbenchText('Settings');
        await waitForWorkbenchText('Aspire: App Host Discovery Timeout Ms');
        await executeE2eControlCommand({ name: 'closeAllEditors' });

        const configureBefore = getCommandInvocationCount('aspire-vscode.configureLaunchJson');
        await executeCommandFromPalette('Aspire: Configure launch.json file');
        await waitForCommandOutcome('aspire-vscode.configureLaunchJson', 'success', 60000, configureBefore);
        assert.ok((await waitForEditorTitle('launch.json')).includes('launch.json'));

        const launchJsonPath = path.join(getWorkspaceRoot(), '.vscode', 'launch.json');
        const launchJson = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8')) as { configurations?: Array<{ type?: string; request?: string }> };
        assert.ok(launchJson.configurations?.some(configuration => configuration.type === 'aspire' && configuration.request === 'launch'));
    });

    test('observes multiple AppHost candidates without selecting the wrong one', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        removeWorkspaceAppHostConfig();
        const secondaryAppHostPath = createAdditionalAppHostCandidate();
        await executeE2eControlCommand({ name: 'refreshAppHosts' });
        await waitForCommandOutcome('aspire-vscode.refreshAppHosts', 'success');

        const stateFile = await waitForExtensionState(
            file => file.state.workspaceAppHostCandidatePaths.some(candidate => isSamePath(candidate, secondaryAppHostPath)),
            'secondary AppHost candidate',
            60000);

        assert.ok(stateFile.state.workspaceAppHostCandidatePaths.length >= 2);
    });
});
