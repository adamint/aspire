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

    test('bounds the ExTester process below the workflow timeout so diagnostics still run', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');

        assert.ok(runner.includes('ASPIRE_EXTENSION_E2E_RUN_TESTS_TIMEOUT_MS'));
        assert.ok(runner.includes('timeout: getRunTestsTimeoutMs()'));
    });

    test('opts out of telemetry for all CLI processes spawned by E2E tests', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const runner = fs.readFileSync(path.join(extensionRoot, 'scripts', 'run-e2e.js'), 'utf8');

        assert.ok(runner.includes("ASPIRE_CLI_TELEMETRY_OPTOUT: '1'"));
        assert.ok(runner.includes("DOTNET_CLI_TELEMETRY_OPTOUT: '1'"));
    });

    test('keeps the slow zero-to-running shard timeout above its composed wait budgets', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const zeroToRunning = fs.readFileSync(path.join(extensionRoot, 'src', 'test-e2e', 'zeroToRunning.e2e.test.ts'), 'utf8');

        assert.ok(zeroToRunning.includes('this.timeout(1200000);'));
        assert.ok(zeroToRunning.includes('waitForDebugSessionStartup(appHostPath, 300000)'));
        assert.ok(zeroToRunning.includes('waitForDebugDashboardUrl(appHostPath, 180000)'));
        assert.ok(zeroToRunning.includes("waitForWorkbenchTextAfterIntegratedBrowserNavigation('Resources', 180000)"));
    });

    test('uses monotonic E2E event sequences instead of positional slices over capped buffers', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const apiTypes = fs.readFileSync(path.join(extensionRoot, 'src', 'types', 'extensionApi.ts'), 'utf8');
        const extension = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
        const assertions = fs.readFileSync(path.join(extensionRoot, 'src', 'test-e2e', 'helpers', 'assertions.ts'), 'utf8');

        assert.ok(apiTypes.includes('sequence: number;'));
        assert.ok(extension.includes('commandInvocationSequence'));
        assert.ok(extension.includes('terminalCommandSequence'));
        assert.ok(extension.includes('debugLaunchSequence'));
        assert.ok(assertions.includes('event.sequence > afterInvocationSequence'));
        assert.ok(!assertions.includes('.slice(afterInvocationCount)'));
        assert.ok(!assertions.includes('.slice(afterCommandCount)'));
        assert.ok(!assertions.includes('.slice(afterLaunchCount)'));
    });
});
