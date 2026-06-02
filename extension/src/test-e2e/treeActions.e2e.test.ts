import * as assert from 'assert';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { getCommandInvocationCount, getTerminalCommandCount, isSamePath, waitForAppHostLaunching, waitForCommandOutcome, waitForDashboardUrl, waitForExtensionState, waitForNoRunningAppHost, waitForRepositoryIdle, waitForResource, waitForResourceState, waitForRunningAppHost, waitForTerminalCommand, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, restoreWorkspaceCliPath, setCliUnavailableForE2E, setTerminalCommandExecutionSuppressedForE2E, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath } from './helpers/paths';
import { answerActiveInput, chooseActiveQuickPick, openAspireView, waitForEditorTitle } from './helpers/vscode';

suite('Aspire tree action command E2E', function () {
    this.timeout(300000);

    teardown(async () => {
        await setCliUnavailableForE2E(false);
        await setTerminalCommandExecutionSuppressedForE2E(false);
        await restoreWorkspaceCliPath();
        await stopPrimaryAppHostIfRunning();
        await waitForNoRunningAppHost();
    });

    test('routes view, copy, endpoint, log, and resource commands through tree handlers', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        const discovered = await waitForWorkspaceAppHost();
        await openAspireView();
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
        await executeE2eControlCommand({ name: 'runAppHost', appHostPath }, { waitFor: 'started' });
        await waitForAppHostLaunching(appHostPath);
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
        const endpointUrl = String(copiedEndpointUrl.result);
        assert.ok(endpointUrl.startsWith('http'));

        before = getCommandInvocationCount('aspire-vscode.openInIntegratedBrowser');
        await executeE2eControlCommand({ name: 'openInIntegratedBrowser', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.openInIntegratedBrowser', 'success', 60000, before);
        assert.ok((await waitForEditorTitle(new URL(endpointUrl).host, 120000, { matchCase: false })).toLowerCase().includes(new URL(endpointUrl).host.toLowerCase()));
        assert.strictEqual(await waitForHttpText(endpointUrl, 'ok'), 'ok');

        const viewedLog = await executeE2eControlCommand({ name: 'viewAppHostLogFile', appHostPath });
        const viewedLogFileName = (viewedLog.result as { fileName?: string }).fileName;
        assert.ok(viewedLogFileName && path.isAbsolute(viewedLogFileName));

        const copiedLogPath = await executeE2eControlCommand({ name: 'copyLogFilePath', appHostPath });
        assert.ok(path.isAbsolute(String(copiedLogPath.result)));

        await setTerminalCommandExecutionSuppressedForE2E(true);
        before = getCommandInvocationCount('aspire-vscode.viewResourceLogs');
        await executeE2eControlCommand({ name: 'viewResourceLogs', appHostPath, resourceName: 'e2e-worker' });
        await waitForCommandOutcome('aspire-vscode.viewResourceLogs', 'success', 60000, before);
        await setTerminalCommandExecutionSuppressedForE2E(false);

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

        await setTerminalCommandExecutionSuppressedForE2E(true);
        before = getCommandInvocationCount('aspire-vscode.executeResourceCommand');
        const terminalBefore = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeResourceCommand', appHostPath, resourceName: 'e2e-worker' }, { waitFor: 'started' });
        await chooseActiveQuickPick('echo-arguments');
        await chooseActiveQuickPick('Continue');
        await answerActiveInput('hello from e2e', 'Message');
        await chooseActiveQuickPick('Beta');
        await chooseActiveQuickPick('Yes');
        await answerActiveInput('42.5', 'Threshold');
        await answerActiveInput('secret-from-e2e', 'Token');
        await waitForCommandOutcome('aspire-vscode.executeResourceCommand', 'success', 60000, before);

        const resourceCommand = await waitForTerminalCommand(
            event => event.subcommand.includes('resource "') && event.subcommand.includes('"echo-arguments"') && event.executionSuppressed,
            'resource command with prompted arguments',
            60000,
            terminalBefore);
        assert.ok(resourceCommand.containsRedactedArgs);
        assert.strictEqual(resourceCommand.additionalArgs, undefined);
        assert.ok(resourceCommand.commandLine.includes('[redacted command arguments]'));
        assert.ok(!resourceCommand.commandLine.includes('secret-from-e2e'));
    });
});

async function waitForHttpText(url: string, expectedText: string, timeoutMs = 120000): Promise<string> {
    const started = Date.now();
    let lastError: string | undefined;

    while (Date.now() - started < timeoutMs) {
        try {
            const body = await getUrlText(url);
            if (body.includes(expectedText)) {
                return expectedText;
            }

            lastError = `response did not contain '${expectedText}': ${body}`;
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Timed out waiting for ${url} to return '${expectedText}'. Last error: ${lastError ?? '<none>'}`);
}

function getUrlText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const handleResponse = (response: http.IncomingMessage): void => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (response.statusCode && response.statusCode >= 400) {
                    reject(new Error(`${url} returned HTTP ${response.statusCode}: ${body}`));
                    return;
                }

                resolve(body);
            });
        };
        const request = parsed.protocol === 'https:'
            ? https.get(parsed, { rejectUnauthorized: false }, handleResponse)
            : http.get(parsed, handleResponse);

        request.on('error', reject);
        request.setTimeout(10000, () => {
            request.destroy(new Error(`${url} timed out`));
        });
    });
}
