import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vm from 'vm';
import * as vscode from 'vscode';

import { AspireExtensionContext } from '../AspireExtensionContext';
import { registerTreeViewCommands } from '../activation/registerTreeViewCommands';
import { getCsharpBlazorWasmDebuggingSupport, useCsharpExtensionVersionProviderForTests } from '../capabilities';
import { AppHostDataRepository, ViewMode } from '../data/AppHostDataRepository';
import { AppHostLaunchService } from '../services/AppHostLaunchService';
import { executeE2eControlCommand, isBrowserDebugSessionType } from '../testing/e2eStateFileBridge';
import { pipelineInteractionCapability } from '../types/configInfo';
import { AspireExtensionE2EControlCommand } from '../types/extensionApi';
import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';
import * as cliPathModule from '../utils/cliPath';
import * as configInfoProvider from '../utils/configInfoProvider';
import { workspaceFolderCliPathTarget } from '../utils/cliPathVariables';
import * as workspaceModule from '../utils/workspace';
import { AspireAppHostTreeProvider } from '../views/AspireAppHostTreeProvider';

import { createWorkspaceFolder } from './testHelpers';

function createLaunchService(): AppHostLaunchService {
    return new AppHostLaunchService({
        getCapabilityStatus: async () => 'supported',
    });
}

suite('E2E state file bridge', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('routes every AppHost action through the exact secondary tree element', async () => {
        const primaryPath = '/repo/primary/AppHost/AppHost.csproj';
        const secondaryPath = '/repo/secondary/AppHost/AppHost.csproj';
        const secondaryFolder = createWorkspaceFolder('secondary', '/repo/secondary');
        const secondaryTarget = workspaceFolderCliPathTarget(secondaryFolder);
        const cliPath = '/repo/secondary/tools/aspire';
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').callsFake(uri =>
            uri.path.startsWith(`${secondaryFolder.uri.path}/`) ? secondaryFolder : undefined);
        const repository = createRepository([primaryPath, secondaryPath], primaryPath);
        const terminalProvider = {
            resolveAspireCliPath: sandbox.stub().resolves({
                cliPath,
                available: true,
                source: 'configured',
            }),
        } as unknown as AspireTerminalProvider;
        const launchService = createLaunchService();
        const launchStub = sandbox.stub(launchService, 'launch').resolves();
        // The tree resolves the CLI itself through the canonical resolver, so pin it here rather
        // than letting a CLI installed on the test machine decide what the actions forward.
        sandbox.stub(cliPathModule, 'resolveCliPath').resolves({ cliPath, available: true, source: 'configured' });
        sandbox.stub(workspaceModule, 'checkCliAvailableOrRedirect').callsFake(
            async (_operation, _target, options) => ({
                cliPath: options?.pinnedCliPath ?? cliPath,
                available: true,
            }));
        sandbox.stub(configInfoProvider.ConfigInfoProvider.prototype, 'getCapabilityStatus').resolves('supported');
        sandbox.stub(configInfoProvider.ConfigInfoProvider.prototype, 'getConfigInfo').resolves({
            localSettingsPath: '/repo/secondary/aspire.config.json',
            globalSettingsPath: '/repo/global-aspire.config.json',
            availableFeatures: [],
            localSettingsSchema: { properties: [] },
            globalSettingsSchema: { properties: [] },
            capabilities: [
                pipelineInteractionCapability,
            ],
        });
        const provider = new AspireAppHostTreeProvider(repository, terminalProvider, launchService);
        const registeredCommands = captureRegisteredTreeCommands(sandbox, provider, repository);
        sandbox.stub(vscode.commands, 'executeCommand').callsFake(async (commandId: string, ...args: unknown[]) => {
            const command = registeredCommands.get(commandId);
            if (!command) {
                throw new Error(`Command '${commandId}' was not registered.`);
            }

            return await command(...args);
        });
        const markStarted = sandbox.spy();

        const commands: AspireExtensionE2EControlCommand[] = [
            { name: 'deployAppHostAction', appHostPath: secondaryPath },
            { name: 'publishAppHostAction', appHostPath: secondaryPath },
            { name: 'runPipelineStepAppHostAction', appHostPath: secondaryPath },
            { name: 'debugPipelineStepAppHostAction', appHostPath: secondaryPath },
        ];
        for (const command of commands) {
            await dispatchControlCommand(command, repository, launchService, provider, terminalProvider, markStarted);
        }

        assert.deepStrictEqual(launchStub.getCalls().map(call => call.args), [
            [secondaryPath, 'deploy', false, undefined, secondaryTarget, cliPath],
            [secondaryPath, 'publish', false, undefined, secondaryTarget, cliPath],
            [secondaryPath, 'do', true, undefined, secondaryTarget, cliPath],
            [secondaryPath, 'do', false, undefined, secondaryTarget, cliPath],
        ]);
        assert.strictEqual(markStarted.callCount, 4);
        provider.dispose();
    });

    test('fails explicitly when the requested AppHost tree element cannot be found', async () => {
        const requestedPath = '/repo/missing/AppHost/AppHost.csproj';
        const repository = createRepository(['/repo/primary/AppHost/AppHost.csproj']);
        const terminalProvider = {} as AspireTerminalProvider;
        const launchService = createLaunchService();
        const provider = new AspireAppHostTreeProvider(repository, terminalProvider, launchService);
        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);

        await assert.rejects(
            dispatchControlCommand(
                { name: 'deployAppHostAction', appHostPath: requestedPath },
                repository,
                launchService,
                provider,
                terminalProvider),
            error => error instanceof Error
                && error.message.includes('deployAppHostAction')
                && error.message.includes(requestedPath));

        assert.strictEqual(executeCommandStub.called, false);
        provider.dispose();
    });

    test('preserves existing command and legacy publish dispatch behavior', async () => {
        const appHostPath = '/repo/AppHost/AppHost.csproj';
        const repository = createRepository([appHostPath]);
        const terminalProvider = {} as AspireTerminalProvider;
        const launchService = createLaunchService();
        const launchStub = sandbox.stub(launchService, 'launch').resolves();
        const provider = new AspireAppHostTreeProvider(repository, terminalProvider, launchService);
        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves('refreshed');
        const markStarted = sandbox.spy();

        const refreshResult = await dispatchControlCommand(
            { name: 'refreshAppHosts' },
            repository,
            launchService,
            provider,
            terminalProvider,
            markStarted);
        await dispatchControlCommand(
            { name: 'publishAppHost', appHostPath },
            repository,
            launchService,
            provider,
            terminalProvider,
            markStarted);

        assert.strictEqual(refreshResult, 'refreshed');
        assert.deepStrictEqual(executeCommandStub.getCalls().map(call => call.args), [
            ['aspire-vscode.refreshAppHosts'],
        ]);
        assert.deepStrictEqual(launchStub.firstCall.args, [appHostPath, 'publish', true]);
        assert.strictEqual(markStarted.callCount, 2);
        provider.dispose();
    });

    test('scopes missing and exact C# extension version overrides to resource configuration creation', async () => {
        const repository = createRepository([]);
        const terminalProvider = {} as AspireTerminalProvider;
        const launchService = createLaunchService();
        const provider = {} as AspireAppHostTreeProvider;
        const clientProjectPath = path.resolve(__dirname, '..', '..', '..', 'src', 'Aspire.Cli', 'Aspire.Cli.csproj');
        const installedVersion = useCsharpExtensionVersionProviderForTests(() => '2.145.14');

        try {
            await assert.rejects(
                dispatchControlCommand({
                    name: 'createResourceDebugConfiguration',
                    launchConfig: {
                        type: 'browser',
                        url: 'https://localhost:7001',
                        browser: 'msedge',
                        web_root: clientProjectPath,
                    } as never,
                    csharpExtensionVersion: null,
                }, repository, launchService, provider, terminalProvider),
                /requires ms-dotnettools\.csharp/);
            assert.deepStrictEqual(getCsharpBlazorWasmDebuggingSupport(), {
                status: 'outdated',
                installedVersion: '2.145.14',
            });

            const result = await dispatchControlCommand({
                name: 'createResourceDebugConfiguration',
                launchConfig: {
                    type: 'browser',
                    url: 'https://localhost:7001',
                    browser: 'chrome',
                    web_root: clientProjectPath,
                } as never,
                csharpExtensionVersion: '2.145.15',
            }, repository, launchService, provider, terminalProvider) as Record<string, unknown>;

            assert.strictEqual(result.type, 'blazorwasm');
            assert.strictEqual(result.browser, 'chrome');
            assert.deepStrictEqual(getCsharpBlazorWasmDebuggingSupport(), {
                status: 'outdated',
                installedVersion: '2.145.14',
            });
        }
        finally {
            installedVersion.dispose();
        }
    });

    test('recognizes managed Blazor roots and supported browser children without recognizing Firefox', () => {
        assert.strictEqual(isBrowserDebugSessionType('blazorwasm'), true);
        assert.strictEqual(isBrowserDebugSessionType('pwa-msedge'), true);
        assert.strictEqual(isBrowserDebugSessionType('pwa-chrome'), true);
        assert.strictEqual(isBrowserDebugSessionType('chrome'), true);
        assert.strictEqual(isBrowserDebugSessionType('msedge'), true);
        assert.strictEqual(isBrowserDebugSessionType('firefox'), false);
        assert.strictEqual(isBrowserDebugSessionType('coreclr'), false);
    });

    for (const closeMode of ['explicit', 'natural'] as const) {
        test(`proves managed Blazor debugging and ${closeMode === 'explicit' ? 'runs the stop command' : 'closes the browser naturally'}`, async () => {
            const harness = createBlazorProofHarness(sandbox, {
                closeMode,
                expectedBrowser: closeMode === 'natural' ? 'chrome' : 'edge',
                managedTopology: closeMode === 'natural' ? 'sibling' : 'child',
            });

            const proof = await dispatchControlCommand(
                harness.command,
                harness.repository,
                harness.launchService,
                harness.provider,
                harness.terminalProvider) as Record<string, any>;

            assert.strictEqual(proof.proof, 'blazor-wasm-managed-breakpoint-hit');
            assert.strictEqual(proof.rootSession.type, 'blazorwasm');
            assert.strictEqual(proof.rootSession.configuration.browser, harness.command.expectedBrowser);
            assert.strictEqual(proof.rootSession.configuration.projectPath, harness.clientProjectPath);
            assert.strictEqual(proof.rootSession.configuration.resourceType, 'browser');
            assert.strictEqual(
                proof.browserSession.type,
                harness.command.expectedBrowser === 'edge' ? 'pwa-msedge' : 'pwa-chrome');
            assert.strictEqual(proof.browserSession.parentSessionId, proof.rootSession.id);
            if (closeMode === 'explicit') {
                assert.strictEqual(proof.managedSession.parentSessionId, proof.rootSession.id);
            }
            else {
                assert.strictEqual(proof.managedSession.parentSessionId, proof.rootSession.parentSessionId);
            }
            assert.strictEqual(proof.breakpointResponse.success, true);
            assert.strictEqual(proof.stoppedEvent.reason, 'breakpoint');
            assert.strictEqual(proof.stackTrace.stackFrames[0].source.path, harness.sourcePath);
            assert.strictEqual(proof.stackTrace.stackFrames[0].line, harness.command.breakpointLine + 1);
            assert.strictEqual(proof.commandStateAfterStop.state, 'Enabled');
            assert.strictEqual(harness.breakpoints.length, 0);
            assert.strictEqual(harness.startListenerDispose.calledOnce, true);
            assert.strictEqual(harness.terminateListenerDispose.calledOnce, true);
            assert.strictEqual(harness.trackerDispose.calledOnce, true);
            assert.strictEqual(harness.configurationDispose.calledOnce, true);
            assert.strictEqual(harness.stopDebugging.called, false);
            assert.strictEqual(harness.tracedConfiguration.trace, true);

            const navigationExpression = harness.browserEvaluateExpressions.find(expression => expression.startsWith('window.location.replace'));
            assert.ok(navigationExpression);
            let navigationUrl: string | undefined;
            vm.runInNewContext(navigationExpression, {
                URL,
                document: { baseURI: 'https://localhost:5000/standalone/' },
                window: { location: { replace: (url: string) => { navigationUrl = url; } } },
            });
            assert.strictEqual(navigationUrl, 'https://localhost:5000/standalone/counter');
            const readinessExpression = harness.browserEvaluateExpressions.find(expression => expression.includes('document.readyState'));
            assert.ok(readinessExpression);
            let interactive = false;
            const document = {
                readyState: 'complete',
                querySelector: (selector: string) => selector === 'button[data-aspire-e2e-interactive="true"]'
                    ? (interactive ? {} : null)
                    : {},
            };
            assert.strictEqual(vm.runInNewContext(readinessExpression, { document }), false);
            interactive = true;
            assert.strictEqual(vm.runInNewContext(readinessExpression, { document }), true);

            if (closeMode === 'explicit') {
                assert.strictEqual(harness.executedResourceCommands.includes('stop-browser-debug'), true);
                assert.deepStrictEqual(harness.continueRequests, []);
            }
            else {
                assert.strictEqual(harness.executedResourceCommands.includes('stop-browser-debug'), false);
                assert.deepStrictEqual(harness.continueRequests, [{ threadId: 42 }]);
                assert.strictEqual(harness.browserEvaluateExpressions.includes('setTimeout(() => window.close(), 0); undefined'), true);
            }
        });
    }

    for (const rootType of ['chrome', 'pwa-chrome'] as const) {
        for (const managedTopology of ['detached', 'sibling'] as const) {
            test(`recognizes a C#-rewritten ${rootType} root and ${managedTopology} WASM adapter`, async () => {
                const harness = createBlazorProofHarness(sandbox, {
                    expectedBrowser: 'chrome',
                    managedTopology,
                    rootType,
                });
                const proof = await dispatchControlCommand(
                    harness.command,
                    harness.repository,
                    harness.launchService,
                    harness.provider,
                    harness.terminalProvider) as Record<string, any>;

                assert.strictEqual(proof.rootSession.type, rootType);
                assert.strictEqual(proof.managedSession.type, 'monovsdbg_wasm');
                assert.strictEqual(proof.managedSession.parentSessionId,
                    managedTopology === 'detached' ? undefined : proof.rootSession.parentSessionId);
                assert.strictEqual(proof.stoppedEvent.reason, 'breakpoint');
                assert.strictEqual(proof.stackTrace.stackFrames[0].source.path, harness.sourcePath);
            });
        }
    }

    test('converts the first zero-based source line to DAP line one', async () => {
        const harness = createBlazorProofHarness(sandbox, { breakpointLine: 0 });
        const proof = await dispatchControlCommand(
            harness.command,
            harness.repository,
            harness.launchService,
            harness.provider,
            harness.terminalProvider) as Record<string, any>;

        assert.strictEqual(proof.breakpointResponse.body.breakpoints[0].line, 1);
        assert.strictEqual(proof.stackTrace.stackFrames[0].line, 1);
    });

    test('reports a rejected browser launch instead of timing out waiting for its child', async () => {
        const harness = createBlazorProofHarness(sandbox, { browserLaunchFailure: true, rootType: 'pwa-chrome', expectedBrowser: 'chrome' });
        await assert.rejects(
            dispatchControlCommand(
                { ...harness.command, timeoutMs: 1000 },
                harness.repository,
                harness.launchService,
                harness.provider,
                harness.terminalProvider),
            /Blazor debugger launch failed:.*Could not attach to main target/);
        assert.strictEqual(harness.configurationDispose.calledOnce, true);
        assert.strictEqual(harness.stopDebugging.called, true);
    });

    test('rejects invalid managed Blazor proof inputs before starting debugging', async () => {
        const harness = createBlazorProofHarness(sandbox);
        const invalidCommands = [
            { ...harness.command, sourcePath: '/outside/Counter.razor' },
            { ...harness.command, breakpointLine: -1 },
            { ...harness.command, breakpointLine: 0.5 },
            { ...harness.command, expectedBrowser: 'firefox' },
            { ...harness.command, expectedBrowser: 42 },
            { ...harness.command, timeoutMs: 0 },
        ] as unknown as AspireExtensionE2EControlCommand[];

        for (const command of invalidCommands) {
            await assert.rejects(
                dispatchControlCommand(
                    command,
                    harness.repository,
                    harness.launchService,
                    harness.provider,
                    harness.terminalProvider));
        }

        assert.strictEqual(harness.executeCommand.called, false);
    });

    test('requires a successful setBreakpoints response and cleans up proof state on failure', async () => {
        const harness = createBlazorProofHarness(sandbox, { breakpointResponseSuccess: false });

        const error = await captureError(() => dispatchControlCommand(
            harness.command,
            harness.repository,
            harness.launchService,
            harness.provider,
            harness.terminalProvider));

        assert.match(error.message, /setBreakpoints/);
        assert.match(error.message, /"launchRequests"/);
        assert.match(error.message, /"breakpointRequests"/);
        assert.match(error.message, /"breakpointResponses"/);
        assert.match(error.message, /"stoppedEvents"/);
        assert.match(error.message, /"stackTraceResponses"/);
        assert.strictEqual(harness.breakpoints.length, 0);
        assert.strictEqual(harness.startListenerDispose.calledOnce, true);
        assert.strictEqual(harness.terminateListenerDispose.calledOnce, true);
        assert.strictEqual(harness.trackerDispose.calledOnce, true);
        assert.strictEqual(harness.stopDebugging.callCount, 3);
    });

    test('finishes failed proof cleanup when an adapter never acknowledges stop', async () => {
        const clock = sandbox.useFakeTimers({ shouldClearNativeTimers: true });
        const harness = createBlazorProofHarness(sandbox, { breakpointResponseSuccess: false });
        harness.stopDebugging.callsFake(() => new Promise<void>(() => undefined));
        let failure: Error | undefined;
        const completion = captureError(() => dispatchControlCommand(
            harness.command,
            harness.repository,
            harness.launchService,
            harness.provider,
            harness.terminalProvider)).then(error => { failure = error; });

        await clock.tickAsync(100);

        assert.ok(failure, 'the bridge must respond even when adapter cleanup hangs');
        assert.match(failure.message, /setBreakpoints/);
        assert.strictEqual(harness.stopDebugging.callCount, 3);
        assert.strictEqual(harness.startListenerDispose.calledOnce, true);
        assert.strictEqual(harness.terminateListenerDispose.calledOnce, true);
        assert.strictEqual(harness.trackerDispose.calledOnce, true);
        await completion;
    });

    test('requires a breakpoint stopped event with a stack frame at the requested source and line', async () => {
        const harness = createBlazorProofHarness(sandbox, { stackSourcePath: '/repo/client/Pages/Other.razor' });

        const error = await captureError(() => dispatchControlCommand(
            harness.command,
            harness.repository,
            harness.launchService,
            harness.provider,
            harness.terminalProvider));

        assert.match(error.message, /managed breakpoint/);
        assert.match(error.message, /"reason": "breakpoint"/);
        assert.match(error.message, /Other\.razor/);
        assert.strictEqual(harness.breakpoints.length, 0);
        assert.strictEqual(harness.stopDebugging.callCount, 3);
    });
});

function createRepository(candidatePaths: readonly string[], selectedPath?: string): AppHostDataRepository {
    const onDidChangeData: vscode.Event<void> = () => ({ dispose: () => { } });
    return {
        viewMode: 'workspace' as ViewMode,
        appHosts: [],
        workspaceResources: [],
        workspaceAppHostPath: selectedPath,
        workspaceAppHostCandidatePaths: candidatePaths,
        workspaceAppHostName: undefined,
        workspaceAppHostDescription: undefined,
        onDidChangeData,
    } as unknown as AppHostDataRepository;
}

function captureRegisteredTreeCommands(
    sandbox: sinon.SinonSandbox,
    provider: AspireAppHostTreeProvider,
    repository: AppHostDataRepository,
): ReadonlyMap<string, (...args: unknown[]) => Promise<unknown>> {
    const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    sandbox.stub(vscode.commands, 'registerCommand').callsFake((commandId, callback) => {
        commands.set(commandId, callback as (...args: unknown[]) => Promise<unknown>);
        return { dispose: () => { } };
    });
    registerTreeViewCommands(provider, repository);

    return commands;
}

async function dispatchControlCommand(
    command: AspireExtensionE2EControlCommand,
    repository: AppHostDataRepository,
    launchService: AppHostLaunchService,
    provider: AspireAppHostTreeProvider,
    terminalProvider: AspireTerminalProvider,
    markStarted: () => void = () => { },
): Promise<unknown> {
    return await executeE2eControlCommand(
        {} as vscode.ExtensionContext,
        {} as AspireExtensionContext,
        repository,
        launchService,
        provider,
        terminalProvider,
        { hasSnapshot: false },
        {},
        new Map(),
        command,
        markStarted);
}

interface BlazorProofHarnessOptions {
    closeMode?: 'explicit' | 'natural';
    breakpointResponseSuccess?: boolean;
    expectedBrowser?: 'edge' | 'chrome';
    stackSourcePath?: string;
    managedTopology?: 'child' | 'sibling' | 'detached';
    rootType?: 'chrome' | 'pwa-chrome';
    breakpointLine?: number;
    browserLaunchFailure?: boolean;
}

function createBlazorProofHarness(sandbox: sinon.SinonSandbox, options: BlazorProofHarnessOptions = {}) {
    const workspaceRoot = '/repo';
    const appHostPath = '/repo/AppHost/AppHost.csproj';
    const clientProjectPath = '/repo/client/Client.csproj';
    const sourcePath = '/repo/client/Pages/Counter.razor';
    const breakpointLine = options.breakpointLine ?? 12;
    const repository = createRepository([appHostPath], appHostPath);
    const launchService = createLaunchService();
    const terminalProvider = {} as AspireTerminalProvider;
    const startListenerDispose = sandbox.spy();
    const terminateListenerDispose = sandbox.spy();
    const trackerDispose = sandbox.spy();
    const configurationDispose = sandbox.spy();
    let configurationProvider: vscode.DebugConfigurationProvider | undefined;
    const continueRequests: unknown[] = [];
    let managedPaused = false;
    const breakpoints: vscode.Breakpoint[] = [{ enabled: true } as vscode.Breakpoint];
    const executedResourceCommands: string[] = [];
    const browserEvaluateExpressions: string[] = [];
    const expectedBrowser = options.expectedBrowser ?? 'edge';
    const activeSessions = new Map<string, vscode.DebugSession>();
    let startListener: ((session: vscode.DebugSession) => unknown) | undefined;
    let terminateListener: ((session: vscode.DebugSession) => unknown) | undefined;
    let trackerFactory: vscode.DebugAdapterTrackerFactory | undefined;
    let browserCommandState = 'Enabled';

    sandbox.stub(vscode.workspace, 'workspaceFolders').value([createWorkspaceFolder('repo', workspaceRoot)]);
    sandbox.stub(vscode.debug, 'breakpoints').get(() => breakpoints);
    sandbox.stub(vscode.debug, 'addBreakpoints').callsFake(added => breakpoints.push(...added));
    sandbox.stub(vscode.debug, 'removeBreakpoints').callsFake(removed => {
        for (const breakpoint of removed) {
            const index = breakpoints.indexOf(breakpoint);
            if (index >= 0) {
                breakpoints.splice(index, 1);
            }
        }
    });
    sandbox.stub(vscode.debug, 'onDidStartDebugSession').callsFake(listener => {
        startListener = listener;
        return { dispose: startListenerDispose };
    });
    sandbox.stub(vscode.debug, 'onDidTerminateDebugSession').callsFake(listener => {
        terminateListener = listener;
        return { dispose: terminateListenerDispose };
    });
    sandbox.stub(vscode.debug, 'registerDebugAdapterTrackerFactory').callsFake((_type, factory) => {
        trackerFactory = factory;
        return { dispose: trackerDispose };
    });
    sandbox.stub(vscode.debug, 'registerDebugConfigurationProvider').callsFake((_type, provider) => {
        configurationProvider = provider;
        return { dispose: configurationDispose };
    });

    const terminateAllSessions = () => {
        for (const session of [...activeSessions.values()]) {
            activeSessions.delete(session.id);
            terminateListener?.(session);
        }
        browserCommandState = 'Enabled';
    };

    const compoundSession = createDebugSession('compound', 'compound', 'Blazor compound', {
        type: 'compound',
        request: 'launch',
    });
    const rootType = options.rootType ?? 'blazorwasm';
    const rootSession = createDebugSession('root', rootType, 'Debug client', {
        type: rootType,
        request: 'attach',
        browser: expectedBrowser,
        projectPath: clientProjectPath,
        resourceType: 'browser',
    }, options.managedTopology === 'sibling' ? compoundSession : undefined);
    const managedType = options.managedTopology === 'detached' || options.rootType !== undefined ? 'monovsdbg_wasm' : 'coreclr';
    const managedSession = createDebugSession('managed', managedType, 'Managed client', {
        type: managedType,
        request: 'attach',
        monoDebuggerOptions: { platform: 'browser' },
    }, options.managedTopology === 'detached' ? undefined : options.managedTopology === 'sibling' ? compoundSession : rootSession);
    managedSession.customRequest = sandbox.stub().callsFake(async (request: string, args?: unknown) => {
        if (request === 'continue') {
            continueRequests.push(args);
            managedPaused = false;
        }
        if (request === 'stackTrace') {
            return {
                stackFrames: [{
                    id: 1,
                    name: 'IncrementCount',
                    source: { path: options.stackSourcePath ?? sourcePath },
                    line: breakpointLine + 1,
                    column: 1,
                }],
            };
        }
        return {};
    });

    const browserSession = createDebugSession('browser', expectedBrowser === 'edge' ? 'pwa-msedge' : 'pwa-chrome', 'Browser', {
        type: expectedBrowser === 'edge' ? 'pwa-msedge' : 'pwa-chrome',
        request: 'launch',
    }, rootSession);
    browserSession.customRequest = sandbox.stub().callsFake(async (request: string, args?: { expression?: string }) => {
        if (request !== 'evaluate') {
            return {};
        }

        const expression = args?.expression ?? '';
        browserEvaluateExpressions.push(expression);
        if (expression.includes("document.querySelector('button.btn-primary')?.click()")) {
            assert.ok(expression.startsWith('setTimeout('), 'The click must not pause managed execution inside evaluate.');
            managedPaused = true;
            const tracker = trackerFactory?.createDebugAdapterTracker(managedSession) as vscode.DebugAdapterTracker | undefined;
            tracker?.onDidSendMessage?.({
                type: 'event',
                event: 'output',
                body: { output: 'Managed breakpoint reached.' },
            });
            tracker?.onDidSendMessage?.({
                type: 'event',
                event: 'stopped',
                body: { reason: 'breakpoint', threadId: 42 },
            });
        }
        else if (expression === 'setTimeout(() => window.close(), 0); undefined') {
            assert.strictEqual(managedPaused, false, 'Resume managed execution before evaluating natural close.');
            terminateAllSessions();
        }

        return expression.includes('document.readyState')
            ? { result: 'true', variablesReference: 0 }
            : { result: '', variablesReference: 0 };
    });

    const startSession = (session: vscode.DebugSession) => {
        activeSessions.set(session.id, session);
        startListener?.(session);
    };
    const emitAdapterStartup = (session: vscode.DebugSession) => {
        const tracker = trackerFactory?.createDebugAdapterTracker(session) as vscode.DebugAdapterTracker | undefined;
        tracker?.onWillReceiveMessage?.({
            seq: 1,
            type: 'request',
            command: session.type === 'blazorwasm' ? 'attach' : 'launch',
            arguments: session.configuration,
        });
        if (session === managedSession) {
            tracker?.onWillReceiveMessage?.({
                seq: 2,
                type: 'request',
                command: 'setBreakpoints',
                arguments: {
                    source: { path: sourcePath },
                    breakpoints: [{ line: breakpointLine + 1 }],
                },
            });
            tracker?.onDidSendMessage?.({
                seq: 3,
                request_seq: 2,
                type: 'response',
                command: 'setBreakpoints',
                success: options.breakpointResponseSuccess ?? true,
                body: {
                    breakpoints: [{
                        verified: options.breakpointResponseSuccess ?? true,
                        line: breakpointLine + 1,
                        source: { path: sourcePath },
                    }],
                },
            });
        }
    };

    const provider = {
        findResourceCommandElement: ({ commandName }: { commandName: string }) => ({
            commandName,
            commandJson: {
                description: null,
                state: commandName === 'debug-in-browser' ? browserCommandState : 'Enabled',
                visibility: 'UI',
            },
            resourceItem: {
                resource: { name: 'client' },
                appHostPath,
            },
        }),
    } as unknown as AspireAppHostTreeProvider;

    const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').callsFake(async (commandId: string, element?: { commandName?: string }) => {
        assert.strictEqual(commandId, 'aspire-vscode.executeResourceCommandItem');
        const commandName = element?.commandName ?? '';
        executedResourceCommands.push(commandName);
        if (commandName === 'debug-in-browser') {
            browserCommandState = 'Disabled';
            await configurationProvider?.resolveDebugConfiguration?.(
                createWorkspaceFolder('repo', workspaceRoot), rootSession.configuration);
            for (const session of [rootSession, browserSession, managedSession]) {
                if (session === browserSession && options.browserLaunchFailure) {
                    continue;
                }
                emitAdapterStartup(session);
                startSession(session);
                if (session === rootSession && options.browserLaunchFailure) {
                    const tracker = trackerFactory?.createDebugAdapterTracker(session) as vscode.DebugAdapterTracker | undefined;
                    tracker?.onDidSendMessage?.({
                        type: 'response',
                        command: 'launch',
                        success: false,
                        body: { error: { format: 'Unable to launch browser: Could not attach to main target' } },
                    });
                }
            }
        }
        else if (commandName === 'stop-browser-debug') {
            terminateAllSessions();
        }
    });
    const stopDebugging = sandbox.stub(vscode.debug, 'stopDebugging').callsFake(async (session?: vscode.DebugSession) => {
        if (session) {
            activeSessions.delete(session.id);
            terminateListener?.(session);
        }
    });

    return {
        command: {
            name: 'proveBlazorWasmDebugging',
            appHostPath,
            resourceName: 'client',
            sourcePath,
            breakpointLine,
            requestPath: 'counter',
            expectedBrowser,
            closeMode: options.closeMode ?? 'explicit',
            timeoutMs: 5,
        } as const,
        repository,
        launchService,
        provider,
        terminalProvider,
        clientProjectPath,
        sourcePath,
        breakpoints,
        executedResourceCommands,
        browserEvaluateExpressions,
        startListenerDispose,
        terminateListenerDispose,
        trackerDispose,
        configurationDispose,
        tracedConfiguration: rootSession.configuration,
        continueRequests,
        executeCommand,
        stopDebugging,
    };
}

function createDebugSession(
    id: string,
    type: string,
    name: string,
    configuration: Record<string, unknown>,
    parentSession?: vscode.DebugSession,
): vscode.DebugSession {
    return {
        id,
        type,
        name,
        configuration: configuration as vscode.DebugConfiguration,
        parentSession,
        workspaceFolder: undefined,
        customRequest: async () => ({}),
        getDebugProtocolBreakpoint: async () => undefined,
    } as unknown as vscode.DebugSession;
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
    try {
        await action();
    }
    catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }

    assert.fail('Expected the action to fail.');
}
