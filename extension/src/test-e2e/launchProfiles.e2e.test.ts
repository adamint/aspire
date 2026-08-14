import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getLaunchConfigurations, waitForLaunchConfigurations, waitForRepositoryIdle, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, runE2eTeardown, stopPrimaryAppHostIfRunning, writeFileWithRetry } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath, getWorkspaceRoot } from './helpers/paths';
import { chooseActiveQuickPick, executeCommandFromPalette, openAspireView } from './helpers/vscode';

suite('Aspire launch profiles E2E', function () {
    this.timeout(240000);

    const resultFileName = 'launch-profile-result.json';
    const launchConfigurationName = 'Aspire: launch profile h2';
    const appHostProjectPath = getPrimaryAppHostProjectPath();
    const appHostDirectory = path.dirname(appHostProjectPath);
    const appHostSourcePath = path.join(appHostDirectory, 'AppHost.cs');
    const resultPath = path.join(appHostDirectory, resultFileName);
    const launchSettingsDirectory = path.join(appHostDirectory, 'Properties');
    const launchSettingsPath = path.join(launchSettingsDirectory, 'launchSettings.json');
    const launchJsonPath = path.join(getWorkspaceRoot(), '.vscode', 'launch.json');
    let originalAppHostSource: FileSnapshot | undefined;
    let originalLaunchSettings: FileSnapshot | undefined;
    let originalLaunchJson: FileSnapshot | undefined;
    let originalLaunchConfigurations: readonly Record<string, unknown>[] | undefined;
    let launchSettingsDirectoryExisted: boolean | undefined;

    teardown(async () => {
        await runE2eTeardown([
            () => executeE2eControlCommand({ name: 'stopDebugging' }),
            () => stopPrimaryAppHostIfRunning(),
            () => restoreFile(appHostSourcePath, originalAppHostSource),
            () => restoreFile(launchSettingsPath, originalLaunchSettings),
            () => removeDirectoryIfCreated(launchSettingsDirectory, launchSettingsDirectoryExisted),
            () => restoreLaunchJson(launchJsonPath, originalLaunchJson, originalLaunchConfigurations),
            () => fs.rmSync(resultPath, { force: true }),
        ], 'Launch profiles E2E teardown failed.');
    });

    test('uses the AppHost launch profile selected by launch.json', async () => {
        originalAppHostSource = captureFile(appHostSourcePath);
        originalLaunchSettings = captureFile(launchSettingsPath);
        originalLaunchJson = captureFile(launchJsonPath);
        launchSettingsDirectoryExisted = fs.existsSync(launchSettingsDirectory);

        await openAspireView();
        await waitForRepositoryIdle();
        await waitForWorkspaceAppHost();
        originalLaunchConfigurations = await getLaunchConfigurations();

        assert.strictEqual(originalAppHostSource.exists, true, `Expected AppHost source at ${appHostSourcePath}.`);
        const updatedAppHostSource = originalAppHostSource.content.replace(
            'var builder = DistributedApplication.CreateBuilder(args);',
            `var builder = DistributedApplication.CreateBuilder(args);

File.WriteAllText(
    Path.Combine(Directory.GetCurrentDirectory(), "${resultFileName}"),
    System.Text.Json.JsonSerializer.Serialize(new
    {
        mode = builder.Configuration["mode"],
        launchProfile = Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE"),
        urls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS"),
    }));`);
        assert.notStrictEqual(updatedAppHostSource, originalAppHostSource.content, 'Expected AppHost fixture to contain DistributedApplication.CreateBuilder(args).');
        writeFileWithRetry(appHostSourcePath, updatedAppHostSource);

        fs.mkdirSync(launchSettingsDirectory, { recursive: true });
        writeFileWithRetry(launchSettingsPath, JSON.stringify({
            profiles: {
                h1: {
                    commandName: 'Project',
                    environmentVariables: {
                        mode: '1',
                    },
                },
                h2: {
                    commandName: 'Project',
                    applicationUrl: 'http://localhost:15002',
                    environmentVariables: {
                        mode: '2',
                    },
                },
            },
        }, undefined, 2));

        const launchConfiguration = {
            type: 'aspire',
            request: 'launch',
            name: launchConfigurationName,
            program: '${workspaceFolder}/AspireE2E.AppHost/AspireE2E.AppHost.csproj',
            dashboardBrowser: 'none',
            debuggers: {
                apphost: {
                    launchProfile: 'h2',
                },
            },
        };
        writeFileWithRetry(launchJsonPath, JSON.stringify({
            version: '0.2.0',
            configurations: [launchConfiguration],
        }, undefined, 2));
        await waitForLaunchConfigurations([launchConfiguration]);

        fs.rmSync(resultPath, { force: true });
        await executeCommandFromPalette('workbench.action.debug.selectandstart');
        await chooseActiveQuickPick(launchConfigurationName);

        const result = await waitForJsonFile(resultPath, 180000);
        assert.deepStrictEqual(result, {
            mode: '2',
            launchProfile: 'h2',
            urls: 'http://localhost:15002',
        });
    });
});

type FileSnapshot =
    | { exists: false }
    | { exists: true; content: string };

function captureFile(filePath: string): FileSnapshot {
    return fs.existsSync(filePath)
        ? { exists: true, content: fs.readFileSync(filePath, 'utf8') }
        : { exists: false };
}

function restoreFile(filePath: string, snapshot: FileSnapshot | undefined): void {
    if (snapshot === undefined) {
        return;
    }

    if (!snapshot.exists) {
        fs.rmSync(filePath, { force: true });
        return;
    }

    writeFileWithRetry(filePath, snapshot.content);
}

async function restoreLaunchJson(
    launchJsonPath: string,
    snapshot: FileSnapshot | undefined,
    originalLaunchConfigurations: readonly Record<string, unknown>[] | undefined,
): Promise<void> {
    restoreFile(launchJsonPath, snapshot);
    if (snapshot !== undefined && originalLaunchConfigurations !== undefined) {
        await waitForLaunchConfigurations(originalLaunchConfigurations);
    }
}

function removeDirectoryIfCreated(directoryPath: string, existed: boolean | undefined): void {
    if (existed === false && fs.existsSync(directoryPath)) {
        fs.rmdirSync(directoryPath);
    }
}

async function waitForJsonFile(filePath: string, timeoutMs: number): Promise<unknown> {
    const started = Date.now();
    let lastContent = '<missing>';
    let lastError = '<none>';

    while (Date.now() - started < timeoutMs) {
        if (fs.existsSync(filePath)) {
            try {
                lastContent = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(lastContent);
            }
            catch (error) {
                lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            }
        }

        await delay(250);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for JSON result at ${filePath}. Last content: ${lastContent}. Last error: ${lastError}.`);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
