import * as assert from 'assert';
import * as path from 'path';

import type { BrowserLaunchConfiguration } from '../dcp/types';
import {
    getBrowserDebugSessions,
    isSamePath,
    waitForNoBrowserDebugSessions,
    waitForNoRunningAppHost,
    waitForRepositoryIdle,
    waitForResourceState,
    waitForWorkspaceAppHost,
} from './helpers/assertions';
import { executeE2eControlCommand, runE2eTeardown, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath, getWorkspaceRoot } from './helpers/paths';
import { openAspireView } from './helpers/vscode';
import { proveBlazorScenario } from './helpers';

// ExTester loads these tests in Node, not in the extension host. Keep the expected
// contract independent of production modules that import the VS Code API.
const minimumCsharpBlazorWasmDebuggingVersion = '2.145.15-prerelease';

interface BrowserDebugConfiguration {
    type?: string;
    request?: string;
    browser?: string;
    projectPath?: string;
    webRoot?: string;
    userDataDir?: boolean;
    runtimeArgs?: string[];
}

suite('Aspire Blazor browser debugger E2E', function () {
    this.timeout(300000);

    const appHostPath = getPrimaryAppHostProjectPath();
    const workspaceRoot = getWorkspaceRoot();
    const standaloneProjectPath = path.join(workspaceRoot, 'StandaloneClient', 'StandaloneClient.csproj');
    const browser = process.env.ASPIRE_EXTENSION_E2E_BROWSER === 'msedge' ? 'msedge' : 'chrome';
    const expectedBrowser = browser === 'msedge' ? 'edge' : 'chrome';

    suiteSetup(async function () {
        this.timeout(600000);
        if (!shouldRunBrowserDebuggerE2E()) {
            this.skip();
        }

        await openAspireView();
        await waitForRepositoryIdle();
        await waitForWorkspaceAppHost();
        await executeE2eControlCommand({ name: 'runAppHost', appHostPath }, { waitFor: 'started', timeoutMs: 600000 });
        await Promise.all([
            waitForResourceState('standalone', ['Running'], 600000),
            waitForResourceState('hosted-global', ['Running'], 600000),
            waitForResourceState('hosted-per-page', ['Running'], 600000),
        ]);
    });

    suiteTeardown(async function () {
        this.timeout(600000);
        if (!shouldRunBrowserDebuggerE2E()) {
            return;
        }

        await runE2eTeardown([
            () => stopPrimaryAppHostIfRunning(),
            () => waitForNoRunningAppHost(300000),
        ], 'Blazor browser debugger E2E teardown failed.');
    });

    test('maps managed Edge debugging to the C# Blazor WebAssembly attach contract', async () => {
        const configuration = await createBrowserDebugConfiguration({
            type: 'browser',
            url: 'http://localhost:5000',
            browser: 'msedge',
            web_root: standaloneProjectPath,
        });

        assert.strictEqual(configuration.type, 'blazorwasm');
        assert.strictEqual(configuration.request, 'attach');
        assert.strictEqual(configuration.browser, 'edge');
        assert.ok(configuration.projectPath && isSamePath(configuration.projectPath, standaloneProjectPath));
    });

    test('maps managed Chrome debugging to the C# Blazor WebAssembly attach contract', async () => {
        const configuration = await createBrowserDebugConfiguration({
            type: 'browser',
            url: 'http://localhost:5000',
            browser: 'chrome',
            web_root: standaloneProjectPath,
        });

        assert.strictEqual(configuration.type, 'blazorwasm');
        assert.strictEqual(configuration.request, 'attach');
        assert.strictEqual(configuration.browser, 'chrome');
        assert.ok(configuration.projectPath && isSamePath(configuration.projectPath, standaloneProjectPath));
    });

    test('keeps a generic directory on hardened js-debug', async () => {
        const genericWebRoot = path.join(workspaceRoot, 'StandaloneClient', 'wwwroot');
        const configuration = await createBrowserDebugConfiguration({
            type: 'browser',
            url: 'http://localhost:5000',
            browser: 'chrome',
            web_root: genericWebRoot,
        });

        assert.strictEqual(configuration.type, 'pwa-chrome');
        assert.strictEqual(configuration.request, 'launch');
        assert.strictEqual(configuration.webRoot, genericWebRoot);
        assert.strictEqual(configuration.userDataDir, true);
        assert.deepStrictEqual(configuration.runtimeArgs, [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-mode',
        ]);
    });

    test('reports an actionable localized error when C# is missing', async () => {
        const expectedMessage = `Debugging this Blazor client requires ms-dotnettools.csharp version ${minimumCsharpBlazorWasmDebuggingVersion} or later. Install the C# extension, then start debugging again.`;

        await assertConfigurationRejected(null, expectedMessage);
    });

    test('reports installed and minimum C# versions when C# is outdated', async () => {
        const installedVersion = '2.145.14';
        const expectedMessage = `Debugging this Blazor client requires ms-dotnettools.csharp version ${minimumCsharpBlazorWasmDebuggingVersion} or later. Installed version: ${installedVersion}. Update the C# extension, then start debugging again.`;

        await assertConfigurationRejected(installedVersion, expectedMessage);
    });

    const scenarios = [
        {
            resourceName: 'standalone',
            sourcePath: path.join(workspaceRoot, 'StandaloneClient', 'Pages', 'Counter.razor'),
            clientProjectPath: standaloneProjectPath,
            requestPath: '/counter',
            closeMode: 'explicit',
        },
        {
            resourceName: 'hosted-global',
            sourcePath: path.join(workspaceRoot, 'HostedGlobal', 'HostedGlobal.Client', 'Pages', 'Counter.razor'),
            clientProjectPath: path.join(workspaceRoot, 'HostedGlobal', 'HostedGlobal.Client', 'HostedGlobal.Client.csproj'),
            requestPath: '/counter',
            closeMode: 'natural',
        },
        {
            resourceName: 'hosted-per-page',
            sourcePath: path.join(workspaceRoot, 'HostedPerPage', 'HostedPerPage.Client', 'Pages', 'Counter.razor'),
            clientProjectPath: path.join(workspaceRoot, 'HostedPerPage', 'HostedPerPage.Client', 'HostedPerPage.Client.csproj'),
            requestPath: '/counter',
            closeMode: 'explicit',
        },
    ] as const;

    for (const scenario of scenarios) {
        test(`hits a managed breakpoint for ${scenario.resourceName}`, async function () {
            this.timeout(300000);

            const proof = await proveBlazorScenario({
                appHostPath,
                resourceName: scenario.resourceName,
                sourcePath: scenario.sourcePath,
                breakpointMarker: '// ASPIRE_E2E_MANAGED_BREAKPOINT',
                requestPath: scenario.requestPath,
                expectedBrowser,
                clientProjectPath: scenario.clientProjectPath,
                closeMode: scenario.closeMode,
                timeoutMs: 300000,
            });
            await waitForNoBrowserDebugSessions(300000);

            const proofSessionIds = new Set([proof.rootSession.id, proof.browserSession.id, proof.managedSession.id]);
            assert.ok(
                getBrowserDebugSessions().every(session => !proofSessionIds.has(session.id)),
                `Expected no proof-owned browser sessions after stopping ${scenario.resourceName}.`);
        });
    }

    async function createBrowserDebugConfiguration(launchConfig: BrowserLaunchConfiguration): Promise<BrowserDebugConfiguration> {
        const status = await executeE2eControlCommand({
            name: 'createResourceDebugConfiguration',
            launchConfig,
            csharpExtensionVersion: minimumCsharpBlazorWasmDebuggingVersion,
        });

        return status.result as BrowserDebugConfiguration;
    }

    async function assertConfigurationRejected(csharpExtensionVersion: string | null, expectedMessage: string): Promise<void> {
        const launchConfig: BrowserLaunchConfiguration = {
            type: 'browser',
            url: 'http://localhost:5000',
            browser: 'chrome',
            web_root: standaloneProjectPath,
        };
        await assert.rejects(
            () => executeE2eControlCommand({
                name: 'createResourceDebugConfiguration',
                launchConfig,
                csharpExtensionVersion,
            }),
            (error: Error) => {
                assert.ok(error.message.includes(expectedMessage), error.message);
                return true;
            });
    }
});

function shouldRunBrowserDebuggerE2E(): boolean {
    return process.env.ASPIRE_EXTENSION_E2E_SHARD === 'browser-debugger';
}
