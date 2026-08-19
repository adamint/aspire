import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getCommandInvocationCount, getTerminalCommandCount, waitForCommandOutcome, waitForRepositoryIdle, waitForTerminalCommand } from './helpers/assertions';
import { executeE2eControlCommand, restoreE2eCliPathForE2E, setE2eCliPathForE2E, setTerminalCommandExecutionSuppressedForE2E, writeWorkspaceSetting } from './helpers/fixtures';
import { getWorkspaceRoot } from './helpers/paths';
import { VSBrowser } from './helpers/extester';
import { answerActiveInput, cancelActiveInput, chooseActiveQuickPick, executeCommandFromPalette, openAspireView, waitForActiveInput, waitForNotificationMessage } from './helpers/vscode';

suite('Workspace target proof E2E', function () {
    this.timeout(900000);

    teardown(async () => {
        await setTerminalCommandExecutionSuppressedForE2E(false);
        await restoreE2eCliPathForE2E();
        writeWorkspaceSetting('files.simpleDialog.enable', undefined);
        fs.rmSync(path.join(getWorkspaceRoot(), '.new-project-output-collision'), { recursive: true, force: true });
    });

    test('reopens the project folder picker after a colliding selection', async function () {
        if (process.env.ASPIRE_EXTENSION_E2E_SKIP_CURRENT_CLI_REGRESSIONS === 'true') {
            this.skip();
        }

        const projectName = 'aspire-empty';
        const testRoot = path.join(getWorkspaceRoot(), '.new-project-output-collision');
        const collidingParent = path.join(testRoot, 'colliding-parent');
        const validParent = path.join(testRoot, 'valid-parent');
        const collidingProject = path.join(collidingParent, projectName);
        const generatedAppHost = path.join(validParent, projectName, 'apphost.cs');
        fs.mkdirSync(collidingProject, { recursive: true });
        fs.mkdirSync(validParent, { recursive: true });
        fs.writeFileSync(path.join(collidingProject, 'existing.txt'), 'existing project');
        writeWorkspaceSetting('files.simpleDialog.enable', true);

        await openAspireView();
        await waitForRepositoryIdle();
        const beforeInvocation = getCommandInvocationCount('aspire-vscode.new');
        await executeCommandFromPalette('Aspire: New Project');
        await chooseActiveQuickPick('Empty AppHost (Choose language...)');
        await chooseActiveQuickPick('C# (.NET)');
        await answerActiveInput(projectName, '');
        await chooseActiveQuickPick(`In a subdirectory named '${projectName}' in the selected folder`);
        await answerActiveInput(collidingParent, 'Folder path');

        const expectedError = `The output directory '${collidingProject}' already exists and is not empty. Specify a different location.`;
        await waitForNotificationMessage(expectedError, 60000);
        await waitForActiveInput('Folder path', 'Enter the output path', 60000);
        await VSBrowser.instance.takeScreenshot('new-project-output-collision-retry.png');

        await answerActiveInput(validParent, 'Folder path');
        await chooseActiveQuickPick('No');
        await VSBrowser.instance.driver.wait(
            () => fs.existsSync(generatedAppHost),
            120000,
            `Timed out waiting for the generated AppHost at '${generatedAppHost}'.`);

        await chooseActiveQuickPick('No');
        await waitForCommandOutcome('aspire-vscode.new', 'success', 60000, beforeInvocation);
        assert.ok(fs.existsSync(path.join(collidingProject, 'existing.txt')));
        assert.ok(fs.existsSync(generatedAppHost));
    });

    test('isolates folder terminals and keeps global commands window scoped', async function () {
        if (process.platform === 'win32') {
            this.skip();
        }

        const workspaceRoot = getWorkspaceRoot();
        const folderA = createFolderFixture(workspaceRoot, 'folder-a');
        const folderB = createFolderFixture(workspaceRoot, 'folder-b');

        await openAspireView();
        await addWorkspaceFolder(folderA.folderPath);
        await addWorkspaceFolder(folderB.folderPath);
        await setE2eCliPathForE2E(undefined);

        await invokeNewForFolder('folder-a', folderA);
        await invokeNewForFolder('folder-b', folderB);

        const beforeCanceledInvocation = getCommandInvocationCount('aspire-vscode.new');
        const beforeCanceledTerminal = getTerminalCommandCount();
        await executeCommandFromPalette('Aspire: New Project');
        await cancelActiveInput();
        await waitForCommandOutcome('aspire-vscode.new', 'canceled', 60000, beforeCanceledInvocation);
        assert.strictEqual(getTerminalCommandCount(), beforeCanceledTerminal);

        await setTerminalCommandExecutionSuppressedForE2E(true);
        const beforeUpdateInvocation = getCommandInvocationCount('aspire-vscode.updateSelf');
        const beforeUpdateTerminal = getTerminalCommandCount();
        await executeE2eControlCommand({ name: 'executeAspireCommand', commandId: 'aspire-vscode.updateSelf' });
        await waitForCommandOutcome('aspire-vscode.updateSelf', 'success', 60000, beforeUpdateInvocation);
        const updateCommand = await waitForTerminalCommand(
            event => event.executionSuppressed && event.subcommand === 'update --self',
            'window-scoped update self command',
            60000,
            beforeUpdateTerminal);
        // The property under test is that a window-scoped command resolves its CLI outside any
        // workspace folder. Asserting the literal 'aspire update --self' would also encode "no CLI
        // is installed on this machine", which is true on CI and false on a developer box where the
        // command legitimately resolves to an absolute path under ~/.aspire.
        assert.ok(updateCommand.commandLine.endsWith('aspire update --self'), updateCommand.commandLine);
        assert.ok(!updateCommand.commandLine.includes(workspaceRoot), updateCommand.commandLine);
        assert.ok(!updateCommand.commandLine.includes(folderA.wrapperPath), updateCommand.commandLine);
        assert.ok(!updateCommand.commandLine.includes(folderB.wrapperPath), updateCommand.commandLine);

        await VSBrowser.instance.takeScreenshot('workspace-target-proof.png');
    });
});

interface FolderFixture {
    folderPath: string;
    wrapperPath: string;
    invocationLogPath: string;
}

function createFolderFixture(workspaceRoot: string, folderName: string): FolderFixture {
    const folderPath = path.join(workspaceRoot, folderName);
    const wrapperPath = path.join(folderPath, `aspire-${folderName}`);
    const invocationLogPath = path.join(folderPath, 'invocations.log');
    fs.mkdirSync(path.join(folderPath, '.vscode'), { recursive: true });
    fs.writeFileSync(wrapperPath, `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${invocationLogPath}'\nif [ "$1" = "--version" ]; then printf '13.5.0-proof\\n'; fi\n`);
    fs.chmodSync(wrapperPath, 0o755);
    fs.writeFileSync(path.join(folderPath, '.vscode', 'settings.json'), JSON.stringify({
        'aspire.aspireCliExecutablePath': wrapperPath,
    }, undefined, 2));
    return { folderPath, wrapperPath, invocationLogPath };
}

async function addWorkspaceFolder(folderPath: string): Promise<void> {
    // This used to drive `Workspaces: Add Folder to Workspace...` and its quick-open input. Adding the
    // first folder converts the single-folder window into an untitled multi-root workspace, which
    // reloads the window and restarts the extension host, and after that reload the second add never
    // took: the command ran and the input confirmed, but the folder never reached `workspaceFolders`.
    // Retrying only spent the budget - four attempts failed the same way - so the fragility is in the
    // UI flow, not in the time allowed for it.
    //
    // What this spec proves is that CLI commands target the right workspace folder. How the folder is
    // added is incidental, so it goes through the same API VS Code's own command calls. The bridge
    // resolves only once the extension host has observed the folder, so there is nothing left to poll.
    await VSBrowser.instance.waitForWorkbench();
    const response = await executeE2eControlCommand({ name: 'addWorkspaceFolder', folderPath }, { timeoutMs: 60000 });
    const folders = JSON.stringify(response.result);
    if (!folders.includes(folderPath)) {
        throw new Error(`Adding workspace folder '${folderPath}' reported success but the extension lists: ${folders}`);
    }
}

async function invokeNewForFolder(folderLabel: string, fixture: FolderFixture): Promise<void> {
    const beforeInvocation = getCommandInvocationCount('aspire-vscode.new');
    const beforeTerminal = getTerminalCommandCount();
    await executeCommandFromPalette('Aspire: New Project');
    await chooseActiveQuickPick(folderLabel);
    await waitForCommandOutcome('aspire-vscode.new', 'success', 60000, beforeInvocation);
    const terminalCommand = await waitForTerminalCommand(
        event => event.subcommand === 'new' && event.commandLine.includes(fixture.wrapperPath),
        `${folderLabel} terminal command`,
        60000,
        beforeTerminal);
    assert.strictEqual(terminalCommand.executionSuppressed, false);
    await VSBrowser.instance.driver.wait(() => {
        if (!fs.existsSync(fixture.invocationLogPath)) {
            return false;
        }
        return fs.readFileSync(fixture.invocationLogPath, 'utf8')
            .split(/\r?\n/)
            .some(line => line === `${fixture.folderPath}\tnew`);
    }, 30000, `Expected ${folderLabel} wrapper to run 'new' from '${fixture.folderPath}'.`);
}