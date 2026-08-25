import * as assert from 'assert';
import * as path from 'path';
import { getCommandInvocationCount, waitForCommandOutcome, waitForRepositoryIdle, waitForRunningAppHost, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, runE2eTeardown, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath, getWorkspaceRoot } from './helpers/paths';
import { openAspireView, waitForNotificationMessage } from './helpers/vscode';

interface CliResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

interface OpenEditor {
    label: string;
    uri?: string;
    text?: string;
    isPreview: boolean;
}

suite('CLI diagnostic log editor E2E', function () {
    this.timeout(420000);

    teardown(async () => {
        await runE2eTeardown([
            () => stopPrimaryAppHostIfRunning(),
            () => executeE2eControlCommand({ name: 'closeAllEditors' }),
        ], 'CLI diagnostic log editor E2E teardown failed.');
    });

    test('keeps the failure notification and opens one existing log as a persistent editor', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        await executeE2eControlCommand({ name: 'closeAllEditors' });

        const missingAppHost = path.join(getWorkspaceRoot(), 'missing', 'Missing.AppHost.csproj');
        const status = await executeE2eControlCommand({
            name: 'runAspireCli',
            args: ['run', '--apphost', missingAppHost, '--non-interactive'],
            workingDirectory: '.',
            allowNonZeroExit: true,
        }, { timeoutMs: 180000 });
        const result = status.result as CliResult;

        assert.notStrictEqual(result.exitCode, 0);
        await waitForNotificationMessage('The --apphost option specified a project that does not exist');

        const editors = await getOpenLogEditors();
        assert.strictEqual(editors.length, 1);
        assert.strictEqual(editors[0].isPreview, false);
    });

    test('opens current and AppHost logs in order as persistent editors', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        await waitForWorkspaceAppHost();
        await executeE2eControlCommand({ name: 'closeAllEditors' });

        const appHostPath = getPrimaryAppHostProjectPath();
        const runBefore = getCommandInvocationCount('aspire-vscode.runAppHost');
        await executeE2eControlCommand({ name: 'runAppHost', appHostPath }, { waitFor: 'started' });
        await waitForCommandOutcome('aspire-vscode.runAppHost', 'success', 180000, runBefore);
        await waitForRunningAppHost(180000);

        const status = await executeE2eControlCommand({
            name: 'runAspireCli',
            args: ['resource', 'e2e-worker', 'missing-command', '--apphost', appHostPath, '--non-interactive'],
            workingDirectory: '.',
            allowNonZeroExit: true,
        }, { timeoutMs: 180000 });
        const result = status.result as CliResult;

        assert.notStrictEqual(result.exitCode, 0);
        await waitForNotificationMessage("Failed to execute command 'missing-command'");

        const editors = await getOpenLogEditors();
        assert.strictEqual(editors.length, 2);
        assert.ok(editors[0].text?.includes('missing-command'), `Expected the current CLI log first, got '${editors[0].label}'.`);
        assert.ok(!editors[1].text?.includes('missing-command'), `Expected the AppHost CLI log second, got '${editors[1].label}'.`);
        assert.deepStrictEqual(editors.map(editor => editor.isPreview), [false, false]);
    });
});

async function getOpenLogEditors(): Promise<OpenEditor[]> {
    const status = await executeE2eControlCommand({ name: 'getOpenEditors' });
    const editors = status.result as OpenEditor[];

    return editors.filter(editor =>
        editor.uri !== undefined
        && path.extname(new URL(editor.uri).pathname) === '.log');
}
