import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('E2E launch profile', () => {
    test('uses in-memory secret storage so VS Code does not prompt for OS keychain access', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');

        assert.ok(runner.includes("'--disable-keytar'"));
        assert.ok(runner.includes("'--use-inmemory-secretstorage'"));
        assert.ok(runner.includes("'--password-store=basic'"));
        assert.ok(runner.includes("'--disable-extension', 'vscode.github-authentication'"));
        assert.ok(runner.includes("'--disable-extension', 'vscode.microsoft-authentication'"));
    });

    test('opens the E2E workspace as a VS Code startup folder', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');

        assert.ok(runner.includes('JSON.stringify(workspaceRoot)'));
        assert.ok(!runner.includes("'--open_resource', workspaceRoot"));
    });

    test('clears the E2E control file before explicit workspace reloads', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const apiTypes = fs.readFileSync(path.join(extensionRoot, 'src', 'types', 'extensionApi.ts'), 'utf8');
        const extension = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');

        assert.ok(apiTypes.includes("{ name: 'openWorkspaceFolder'; folderPath: string }"));
        assert.ok(extension.includes("case 'openWorkspaceFolder'"));
        assert.ok(extension.includes('clearPendingE2eControlFile();'));
        assert.ok(extension.includes("vscode.commands.executeCommand('vscode.openFolder'"));
    });

    test('validates explicit workspace folder before reporting bridge command start', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const extension = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
        const openWorkspaceCase = extension.slice(extension.indexOf("case 'openWorkspaceFolder'"), extension.indexOf("case 'getWorkspaceFolders'"));

        assert.ok(openWorkspaceCase.indexOf('getE2eWorkspaceFolderPath') < openWorkspaceCase.indexOf('markStarted();'));
    });

    test('uses a shared timeout budget for workspace recovery and AppHost discovery', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const assertions = fs.readFileSync(path.join(extensionRoot, 'src', 'test-e2e', 'helpers', 'assertions.ts'), 'utf8');

        assert.ok(assertions.includes('const deadline = createDeadline(timeoutMs);'));
        assert.ok(assertions.includes('getRemainingTimeout(deadline'));
        assert.ok(assertions.includes('throwIfControlFailed(openWorkspaceRevision);'));
    });
});
