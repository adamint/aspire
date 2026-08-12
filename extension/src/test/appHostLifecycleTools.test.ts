import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import {
    AppHostLifecycleToolService,
    AppHostStartLanguageModelTool,
    AppHostStopLanguageModelTool,
    aspireAppHostStartToolName,
    aspireAppHostStopToolName,
    registerAppHostLifecycleTools,
    type AppHostLifecycleDiscoveryService,
    type AppHostLifecycleEditorSession,
    type AppHostLifecycleLaunchService,
    type AppHostLifecycleToolResult,
} from '../lm/appHostLifecycleTools';
import { compareAppHostIdentity } from '../utils/appHostIdentity';
import { type CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';

interface LaunchCall {
    readonly appHostPath: string;
    readonly command: string;
    readonly noDebug: boolean;
}

interface AppHostLifecycleToolServiceTestAccess {
    discoverTargets(token: vscode.CancellationToken): Promise<{
        readonly targets: readonly {
            readonly launchPath: string;
            readonly absolutePath: string;
            readonly selector: string;
        }[];
        readonly hadFailures: boolean;
        readonly hadSuppressedCandidates: boolean;
    }>;
}

class FakeLaunchService implements AppHostLifecycleLaunchService {
    readonly launchCalls: LaunchCall[] = [];
    readonly launchingPaths = new Set<string>();
    launchAccepted = true;
    launchGate: Promise<void> | undefined;
    launchToken: vscode.CancellationToken | undefined;
    onLaunch: (() => void) | undefined;

    async launch(
        appHostPath: string,
        command: 'run',
        noDebug: boolean,
        _doStep: undefined,
        token: vscode.CancellationToken,
    ): Promise<boolean> {
        this.launchToken = token;
        this.launchCalls.push({ appHostPath, command, noDebug });
        this.onLaunch?.();
        await this.launchGate;
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        return this.launchAccepted;
    }
}

class FakeDiscoveryService implements AppHostLifecycleDiscoveryService {
    readonly candidatesByFolder = new Map<string, CandidateAppHostDisplayInfo[]>();
    readonly errorsByFolder = new Map<string, Error>();
    discoverGate: Promise<void> | undefined;
    onDiscover: ((folder: vscode.WorkspaceFolder) => void) | undefined;
    error: Error | undefined;

    async discover(folder: vscode.WorkspaceFolder): Promise<readonly CandidateAppHostDisplayInfo[]> {
        this.onDiscover?.(folder);
        await this.discoverGate;

        const error = this.errorsByFolder.get(folder.uri.fsPath) ?? this.error;
        if (error) {
            throw error;
        }

        return this.candidatesByFolder.get(folder.uri.fsPath) ?? [];
    }
}

suite('AppHost lifecycle language model tools', () => {
    const fixtureRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'apphost-lifecycle');
    const token = new vscode.CancellationTokenSource().token;
    let sandbox: sinon.SinonSandbox;
    let fixtureDirectories: string[];
    let workspaceRoot: string;
    let appHostPath: string;
    let workspaceFolder: vscode.WorkspaceFolder;
    let launchService: FakeLaunchService;
    let discoveryService: FakeDiscoveryService;
    let debugSessions: AppHostLifecycleEditorSession[];
    let stoppedSessions: AppHostLifecycleEditorSession[];
    let runningAppHostPaths: string[];
    let runningAppHostError: Error | undefined;
    let runningAppHostsGate: Promise<void> | undefined;
    let onRunningAppHostsRequested: (() => void) | undefined;
    let service: AppHostLifecycleToolService;
    let workspaceFoldersStub: sinon.SinonStub;
    let isTrustedStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        fixtureDirectories = [];
        fs.mkdirSync(fixtureRoot, { recursive: true });
        workspaceRoot = createFixtureDirectory('workspace');
        appHostPath = path.join(workspaceRoot, 'AppHost', 'AppHost.csproj');
        fs.mkdirSync(path.dirname(appHostPath), { recursive: true });
        fs.writeFileSync(appHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        workspaceFolder = createWorkspaceFolder(workspaceRoot, 'workspace', 0);
        workspaceFoldersStub = sandbox.stub(vscode.workspace, 'workspaceFolders').value([workspaceFolder]);
        isTrustedStub = sandbox.stub(vscode.workspace, 'isTrusted').value(true);

        launchService = new FakeLaunchService();
        discoveryService = new FakeDiscoveryService();
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(appHostPath)]);
        debugSessions = [];
        stoppedSessions = [];
        runningAppHostPaths = [];
        runningAppHostError = undefined;
        runningAppHostsGate = undefined;
        onRunningAppHostsRequested = undefined;
        service = new AppHostLifecycleToolService({
            launchService,
            discoveryService,
            getEditorSessions: () => debugSessions,
            getRunningAppHosts: async () => {
                onRunningAppHostsRequested?.();
                await runningAppHostsGate;
                if (runningAppHostError) {
                    throw runningAppHostError;
                }

                return runningAppHostPaths.map(runningPath => ({ appHostPath: runningPath }));
            },
        });
    });

    teardown(() => {
        service.dispose();
        sandbox.restore();
        for (const directory of fixtureDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('starts the discovered AppHost through the editor launch service', async () => {
        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, token);

        assert.deepStrictEqual(result, {
            tool: aspireAppHostStartToolName,
            outcome: 'started',
            appHostPath: 'AppHost/AppHost.csproj',
            controller: 'editor',
            requestedMode: 'debug',
            effectiveMode: 'debug',
        });
        assert.deepStrictEqual(launchService.launchCalls, [{
            appHostPath: path.resolve(appHostPath),
            command: 'run',
            noDebug: false,
        }]);
    });

    test('passes run mode as a no-debug editor launch', async () => {
        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'started');
        assert.strictEqual(launchService.launchCalls[0].noDebug, true);
    });

    test('serializes concurrent starts from the language model tools', async () => {
        const launchStarted = createDeferred<void>();
        const releaseLaunch = createDeferred<void>();
        launchService.onLaunch = () => launchStarted.resolve();
        launchService.launchGate = releaseLaunch.promise;

        const firstStart = service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);
        await launchStarted.promise;
        const secondResult = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, token);

        assert.strictEqual(secondResult.outcome, 'alreadyStarting');
        assert.strictEqual(launchService.launchCalls.length, 1);

        releaseLaunch.resolve();
        assert.strictEqual((await firstStart).outcome, 'started');
    });

    test('reports alreadyStarting when the shared launch service loses an atomic claim race', async () => {
        launchService.launchAccepted = false;

        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'alreadyStarting');
        assert.strictEqual(result.controller, 'editor');
        assert.strictEqual(launchService.launchCalls.length, 1);
    });

    test('propagates cancellation through launch gating instead of reporting the AppHost started', async () => {
        const launchStarted = createDeferred<void>();
        const releaseLaunch = createDeferred<void>();
        const cancellationSource = new vscode.CancellationTokenSource();
        launchService.onLaunch = () => launchStarted.resolve();
        launchService.launchGate = releaseLaunch.promise;

        const startPromise = service.start(
            { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' },
            cancellationSource.token);
        await launchStarted.promise;
        cancellationSource.cancel();
        releaseLaunch.resolve();

        const result = await startPromise;

        assert.strictEqual(launchService.launchToken?.isCancellationRequested, true);
        assert.strictEqual(result.outcome, 'cancelled');
    });

    test('propagates disposal through launch gating instead of reporting the AppHost started', async () => {
        const launchStarted = createDeferred<void>();
        const releaseLaunch = createDeferred<void>();
        launchService.onLaunch = () => launchStarted.resolve();
        launchService.launchGate = releaseLaunch.promise;

        const startPromise = service.start(
            { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' },
            token);
        await launchStarted.promise;
        service.dispose();
        releaseLaunch.resolve();

        const result = await startPromise;

        assert.strictEqual(launchService.launchToken?.isCancellationRequested, true);
        assert.strictEqual(result.outcome, 'cancelled');
    });

    test('uses the lexical discovery path when the AppHost is already launching through a symlinked directory', async () => {
        const realAppHostDirectory = path.join(workspaceRoot, 'RealAppHost');
        const linkedAppHostDirectory = path.join(workspaceRoot, 'LinkedAppHost');
        const linkedAppHostPath = path.join(linkedAppHostDirectory, 'AppHost.csproj');
        const realAppHostPath = path.join(realAppHostDirectory, 'AppHost.csproj');
        fs.mkdirSync(realAppHostDirectory, { recursive: true });
        fs.writeFileSync(realAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        createDirectoryLink(linkedAppHostDirectory, realAppHostDirectory);

        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(linkedAppHostPath)]);
        launchService.launchingPaths.add(normalizeLexicalPath(linkedAppHostPath));

        const result = await service.start({ appHostPath: 'RealAppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'alreadyStarting');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('matches an already-launching real path to an AppHost discovered through a symlinked directory', async () => {
        const realAppHostDirectory = path.join(workspaceRoot, 'RealAppHost');
        const linkedAppHostDirectory = path.join(workspaceRoot, 'LinkedAppHost');
        const linkedAppHostPath = path.join(linkedAppHostDirectory, 'AppHost.csproj');
        const realAppHostPath = path.join(realAppHostDirectory, 'AppHost.csproj');
        fs.mkdirSync(realAppHostDirectory, { recursive: true });
        fs.writeFileSync(realAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        createDirectoryLink(linkedAppHostDirectory, realAppHostDirectory);

        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(linkedAppHostPath)]);
        launchService.launchingPaths.add(normalizeLexicalPath(realAppHostPath));

        const result = await service.start({ appHostPath: 'RealAppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'alreadyStarting');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('does not start a second editor-owned session', async () => {
        debugSessions.push(createDebugSession(appHostPath, false));

        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'alreadyRunning');
        assert.strictEqual(result.controller, 'editor');
        assert.strictEqual(result.effectiveMode, 'debug');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('does not start a second externally-owned AppHost', async () => {
        const sourcePath = path.join(path.dirname(appHostPath), 'Program.cs');
        fs.writeFileSync(sourcePath, 'Console.WriteLine();');
        runningAppHostPaths.push(sourcePath);

        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'alreadyRunning');
        assert.strictEqual(result.controller, 'external');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('prefers an editor session that appears while the running AppHost probe is in flight', async () => {
        runningAppHostPaths.push(appHostPath);
        onRunningAppHostsRequested = () => debugSessions.push(createDebugSession(appHostPath, false));

        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'alreadyRunning');
        assert.strictEqual(result.controller, 'editor');
    });

    test('stops the matching editor debug session', async () => {
        const session = createDebugSession(appHostPath, true, stoppedSession => stoppedSessions.push(stoppedSession));
        debugSessions.push(session);

        const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);

        assert.strictEqual(result.outcome, 'stopped');
        assert.strictEqual(result.controller, 'editor');
        assert.strictEqual(result.effectiveMode, 'run');
        assert.deepStrictEqual(stoppedSessions, [session]);
    });

    test('does not stop the editor session when cancellation wins the discovery race', async () => {
        const session = createDebugSession(appHostPath, true, stoppedSession => stoppedSessions.push(stoppedSession));
        const discoveryStarted = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        const cancellationSource = new vscode.CancellationTokenSource();

        debugSessions.push(session);
        discoveryService.onDiscover = () => discoveryStarted.resolve();
        discoveryService.discoverGate = releaseDiscovery.promise;

        const stopPromise = service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, cancellationSource.token);
        await discoveryStarted.promise;
        cancellationSource.cancel();
        releaseDiscovery.resolve();

        const result = await stopPromise;

        assert.strictEqual(result.outcome, 'cancelled');
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('does not stop the editor session when disposal wins the discovery race', async () => {
        const session = createDebugSession(appHostPath, true, stoppedSession => stoppedSessions.push(stoppedSession));
        const discoveryStarted = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();

        debugSessions.push(session);
        discoveryService.onDiscover = () => discoveryStarted.resolve();
        discoveryService.discoverGate = releaseDiscovery.promise;

        const stopPromise = service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);
        await discoveryStarted.promise;
        service.dispose();
        releaseDiscovery.resolve();

        const result = await stopPromise;

        assert.strictEqual(result.outcome, 'cancelled');
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('refuses to stop an externally-owned AppHost', async () => {
        runningAppHostPaths.push(appHostPath);

        const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);

        assert.strictEqual(result.outcome, 'notEditorOwned');
        assert.strictEqual(result.controller, 'external');
        assert.strictEqual(stoppedSessions.length, 0);
    });

    test('reports notRunning when neither VS Code nor aspire ps sees the AppHost', async () => {
        const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);

        assert.strictEqual(result.outcome, 'notRunning');
        assert.strictEqual(result.controller, 'none');
    });

    test('stops an editor session that appears while the running AppHost probe is in flight', async () => {
        const probeStarted = createDeferred<void>();
        const releaseProbe = createDeferred<void>();
        const session = createDebugSession(appHostPath, true, stoppedSession => stoppedSessions.push(stoppedSession));
        onRunningAppHostsRequested = () => probeStarted.resolve();
        runningAppHostsGate = releaseProbe.promise;

        const stopPromise = service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);
        await probeStarted.promise;
        debugSessions.push(session);
        releaseProbe.resolve();

        const result = await stopPromise;

        assert.strictEqual(result.outcome, 'stopped');
        assert.strictEqual(result.controller, 'editor');
        assert.deepStrictEqual(stoppedSessions, [session]);
    });

    test('refuses an ambiguous Program.cs alias when sibling C# projects exist', async () => {
        const directory = path.dirname(appHostPath);
        fs.writeFileSync(path.join(directory, 'Second.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
        const sourcePath = path.join(directory, 'Program.cs');
        fs.writeFileSync(sourcePath, 'Console.WriteLine();');
        debugSessions.push(createDebugSession(sourcePath, false));

        const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);

        assert.strictEqual(result.outcome, 'ambiguousSession');
        assert.strictEqual(stoppedSessions.length, 0);
    });

    test('rejects absolute selectors without reading them as filesystem targets', async () => {
        const absoluteResult = await service.start({ appHostPath, mode: 'run' }, token);

        assert.strictEqual(absoluteResult.outcome, 'invalidInput');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('auto-selects the only discovered AppHost before requesting start confirmation', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const prepareInput = { appHostPath: 'the discovered AppHost', mode: 'run' as const };

        const prepared = await tool.prepareInvocation({ input: prepareInput }, token);
        const result = getToolResult(await tool.invoke({
            input: { ...prepareInput },
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(
            getMarkdownValue(prepared.confirmationMessages?.message),
            'Start&nbsp;the&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/AppHost.csproj&nbsp;in&nbsp;run&nbsp;mode?');
        assert.strictEqual(result.outcome, 'started');
        assert.strictEqual(result.appHostPath, 'AppHost/AppHost.csproj');
        assert.deepStrictEqual(launchService.launchCalls.map(call => call.appHostPath), [path.resolve(appHostPath)]);
    });

    test('does not auto-select a sole safe AppHost for an identity-changing selector', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const input = { appHostPath: `AppHost/Bad\u202E.csproj`, mode: 'run' as const };

        const prepared = await tool.prepareInvocation({ input }, token);
        const result = getToolResult(await tool.invoke({
            input,
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(prepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'invalidInput');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('does not auto-select when another discovered candidate is unsafe to expose', async () => {
        const unsafeAppHostPath = path.join(workspaceRoot, 'Unsafe', `Bad\u202E.csproj`);
        fs.mkdirSync(path.dirname(unsafeAppHostPath), { recursive: true });
        fs.writeFileSync(unsafeAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [
            createCandidate(appHostPath),
            createCandidate(unsafeAppHostPath),
        ]);
        const tool = new AppHostStartLanguageModelTool(service);
        const input = { appHostPath: 'the discovered AppHost', mode: 'run' as const };

        const prepared = await tool.prepareInvocation({ input }, token);
        const result = getToolResult(await tool.invoke({
            input,
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(prepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'unknownAppHost');
        assert.deepStrictEqual(result.knownAppHosts, ['AppHost/AppHost.csproj']);
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('does not start a different sole AppHost when discovery changes after confirmation', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const input = { appHostPath: 'the discovered AppHost', mode: 'run' as const };
        const prepared = await tool.prepareInvocation({ input }, token);
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(secondAppHostPath)]);

        const result = getToolResult(await tool.invoke({
            input,
            toolInvocationToken: undefined,
        }, token));

        assert.ok(prepared.confirmationMessages);
        assert.strictEqual(result.outcome, 'unknownAppHost');
        assert.deepStrictEqual(result.knownAppHosts, ['SecondAppHost/SecondAppHost.csproj']);
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('does not stop a different sole AppHost when discovery changes after confirmation', async () => {
        const tool = new AppHostStopLanguageModelTool(service);
        const input = { appHostPath: 'the discovered AppHost' };
        const prepared = await tool.prepareInvocation({ input }, token);
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(secondAppHostPath)]);
        debugSessions.push(createDebugSession(secondAppHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession)));

        const result = getToolResult(await tool.invoke({
            input,
            toolInvocationToken: undefined,
        }, token));

        assert.ok(prepared.confirmationMessages);
        assert.strictEqual(result.outcome, 'unknownAppHost');
        assert.deepStrictEqual(result.knownAppHosts, ['SecondAppHost/SecondAppHost.csproj']);
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('does not start when an unresolved preparation becomes an exact selector before invocation', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const input = { appHostPath: 'Future/Future.csproj', mode: 'run' as const };
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [
            createCandidate(appHostPath),
            createCandidate(secondAppHostPath),
        ]);
        const prepared = await tool.prepareInvocation({ input }, token);
        const futureAppHostPath = path.join(workspaceRoot, 'Future', 'Future.csproj');
        fs.mkdirSync(path.dirname(futureAppHostPath), { recursive: true });
        fs.writeFileSync(futureAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(futureAppHostPath)]);

        const result = getToolResult(await tool.invoke({
            input: { ...input },
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(prepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'unknownAppHost');
        assert.deepStrictEqual(result.knownAppHosts, [
            'AppHost/AppHost.csproj',
            'SecondAppHost/SecondAppHost.csproj',
        ]);
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('does not stop when an unresolved preparation becomes an exact selector before invocation', async () => {
        const tool = new AppHostStopLanguageModelTool(service);
        const input = { appHostPath: 'Future/Future.csproj' };
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [
            createCandidate(appHostPath),
            createCandidate(secondAppHostPath),
        ]);
        const prepared = await tool.prepareInvocation({ input }, token);
        const futureAppHostPath = path.join(workspaceRoot, 'Future', 'Future.csproj');
        fs.mkdirSync(path.dirname(futureAppHostPath), { recursive: true });
        fs.writeFileSync(futureAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(futureAppHostPath)]);
        debugSessions.push(createDebugSession(futureAppHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession)));

        const result = getToolResult(await tool.invoke({
            input: { ...input },
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(prepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'unknownAppHost');
        assert.deepStrictEqual(result.knownAppHosts, [
            'AppHost/AppHost.csproj',
            'SecondAppHost/SecondAppHost.csproj',
        ]);
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('fails closed when lifecycle tools are invoked without preparation', async () => {
        const startTool = new AppHostStartLanguageModelTool(service);
        const stopTool = new AppHostStopLanguageModelTool(service);
        debugSessions.push(createDebugSession(appHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession)));

        const startResult = getToolResult(await startTool.invoke({
            input: { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' },
            toolInvocationToken: undefined,
        }, token));
        const stopResult = getToolResult(await stopTool.invoke({
            input: { appHostPath: 'AppHost/AppHost.csproj' },
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(startResult.outcome, 'failed');
        assert.strictEqual(stopResult.outcome, 'failed');
        assert.strictEqual(launchService.launchCalls.length, 0);
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('fails duplicate start preparations closed when one becomes unresolved', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const firstInput = { appHostPath: 'the discovered AppHost', mode: 'run' as const };
        const secondInput = { ...firstInput };
        const firstPrepared = await tool.prepareInvocation({ input: firstInput }, token);
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [
            createCandidate(appHostPath),
            createCandidate(secondAppHostPath),
        ]);
        const secondPrepared = await tool.prepareInvocation({ input: secondInput }, token);

        const secondResult = getToolResult(await tool.invoke({
            input: secondInput,
            toolInvocationToken: undefined,
        }, token));
        const firstResult = getToolResult(await tool.invoke({
            input: firstInput,
            toolInvocationToken: undefined,
        }, token));

        assert.ok(firstPrepared.confirmationMessages);
        assert.strictEqual(secondPrepared.confirmationMessages, undefined);
        assert.strictEqual(secondResult.outcome, 'failed');
        assert.strictEqual(firstResult.outcome, 'failed');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('fails duplicate stop preparations closed when one becomes unresolved', async () => {
        const tool = new AppHostStopLanguageModelTool(service);
        const firstInput = { appHostPath: 'the discovered AppHost' };
        const secondInput = { ...firstInput };
        debugSessions.push(createDebugSession(appHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession)));
        const firstPrepared = await tool.prepareInvocation({ input: firstInput }, token);
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [
            createCandidate(appHostPath),
            createCandidate(secondAppHostPath),
        ]);
        const secondPrepared = await tool.prepareInvocation({ input: secondInput }, token);

        const secondResult = getToolResult(await tool.invoke({
            input: secondInput,
            toolInvocationToken: undefined,
        }, token));
        const firstResult = getToolResult(await tool.invoke({
            input: firstInput,
            toolInvocationToken: undefined,
        }, token));

        assert.ok(firstPrepared.confirmationMessages);
        assert.strictEqual(secondPrepared.confirmationMessages, undefined);
        assert.strictEqual(secondResult.outcome, 'failed');
        assert.strictEqual(firstResult.outcome, 'failed');
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('fails duplicate start preparations closed when they resolve different targets', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const firstInput = { appHostPath: 'the discovered AppHost', mode: 'run' as const };
        const secondInput = { ...firstInput };
        const firstPrepared = await tool.prepareInvocation({ input: firstInput }, token);
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(secondAppHostPath)]);
        const secondPrepared = await tool.prepareInvocation({ input: secondInput }, token);

        const secondResult = getToolResult(await tool.invoke({
            input: secondInput,
            toolInvocationToken: undefined,
        }, token));
        const firstResult = getToolResult(await tool.invoke({
            input: firstInput,
            toolInvocationToken: undefined,
        }, token));

        assert.ok(firstPrepared.confirmationMessages);
        assert.strictEqual(secondPrepared.confirmationMessages, undefined);
        assert.strictEqual(secondResult.outcome, 'failed');
        assert.strictEqual(firstResult.outcome, 'failed');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('fails duplicate stop preparations closed when they resolve different targets', async () => {
        const tool = new AppHostStopLanguageModelTool(service);
        const firstInput = { appHostPath: 'the discovered AppHost' };
        const secondInput = { ...firstInput };
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        debugSessions.push(
            createDebugSession(appHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession)),
            createDebugSession(secondAppHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession)));
        const firstPrepared = await tool.prepareInvocation({ input: firstInput }, token);
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(secondAppHostPath)]);
        const secondPrepared = await tool.prepareInvocation({ input: secondInput }, token);

        const secondResult = getToolResult(await tool.invoke({
            input: secondInput,
            toolInvocationToken: undefined,
        }, token));
        const firstResult = getToolResult(await tool.invoke({
            input: firstInput,
            toolInvocationToken: undefined,
        }, token));

        assert.ok(firstPrepared.confirmationMessages);
        assert.strictEqual(secondPrepared.confirmationMessages, undefined);
        assert.strictEqual(secondResult.outcome, 'failed');
        assert.strictEqual(firstResult.outcome, 'failed');
        assert.deepStrictEqual(stoppedSessions, []);
    });

    test('keeps duplicate preparation overflow fail closed', async () => {
        const tool = new AppHostStartLanguageModelTool(service);

        for (let index = 0; index <= 64; index++) {
            const input = { appHostPath: `discovered AppHost ${index}`, mode: 'run' as const };
            const firstPrepared = await tool.prepareInvocation({ input }, token);
            const duplicatePrepared = await tool.prepareInvocation({ input: { ...input } }, token);

            assert.ok(firstPrepared.confirmationMessages);
            assert.strictEqual(duplicatePrepared.confirmationMessages, undefined);
        }

        const oldestInput = { appHostPath: 'discovered AppHost 0', mode: 'run' as const };
        const prepared = await tool.prepareInvocation({ input: oldestInput }, token);
        const result = getToolResult(await tool.invoke({
            input: { ...oldestInput },
            toolInvocationToken: undefined,
        }, token));

        assert.strictEqual(prepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'failed');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('tombstones an evicted live preparation while keeping the new input usable', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const firstInput = { appHostPath: 'discovered AppHost 0', mode: 'run' as const };

        for (let index = 0; index < 64; index++) {
            const prepared = await tool.prepareInvocation({
                input: { appHostPath: `discovered AppHost ${index}`, mode: 'run' },
            }, token);
            assert.ok(prepared.confirmationMessages);
        }

        const overflowPrepared = await tool.prepareInvocation({
            input: { appHostPath: 'discovered AppHost overflow', mode: 'run' },
        }, token);
        const firstResult = getToolResult(await tool.invoke({
            input: firstInput,
            toolInvocationToken: undefined,
        }, token));
        const overflowResult = getToolResult(await tool.invoke({
            input: { appHostPath: 'discovered AppHost overflow', mode: 'run' },
            toolInvocationToken: undefined,
        }, token));

        assert.ok(overflowPrepared.confirmationMessages);
        assert.strictEqual(firstResult.outcome, 'failed');
        assert.strictEqual(overflowResult.outcome, 'started');
        assert.strictEqual(launchService.launchCalls.length, 1);
    });

    test('fails closed after an unconsumed preparation expires', async () => {
        const clock = sandbox.useFakeTimers({
            now: Date.now(),
            toFake: ['Date'],
        });
        const tool = new AppHostStartLanguageModelTool(service);
        const input = { appHostPath: 'the discovered AppHost', mode: 'run' as const };
        const firstPrepared = await tool.prepareInvocation({ input }, token);
        clock.tick((5 * 60 * 1000) + 1);

        const secondPrepared = await tool.prepareInvocation({ input: { ...input } }, token);
        const result = getToolResult(await tool.invoke({
            input: { ...input },
            toolInvocationToken: undefined,
        }, token));

        assert.ok(firstPrepared.confirmationMessages);
        assert.strictEqual(secondPrepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'failed');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('keeps distinct inputs usable after an unconsumed preparation expires', async () => {
        const clock = sandbox.useFakeTimers({
            now: Date.now(),
            toFake: ['Date'],
        });
        const tool = new AppHostStartLanguageModelTool(service);
        const abandonedInput = { appHostPath: 'the discovered AppHost', mode: 'run' as const };
        const abandonedPrepared = await tool.prepareInvocation({ input: abandonedInput }, token);
        clock.tick((5 * 60 * 1000) + 1);
        const distinctInput = { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' as const };

        const distinctPrepared = await tool.prepareInvocation({ input: distinctInput }, token);
        const result = getToolResult(await tool.invoke({
            input: { ...distinctInput },
            toolInvocationToken: undefined,
        }, token));

        assert.ok(abandonedPrepared.confirmationMessages);
        assert.ok(distinctPrepared.confirmationMessages);
        assert.strictEqual(result.outcome, 'started');
        assert.strictEqual(launchService.launchCalls.length, 1);
    });

    test('POSIX selectors distinguish literal backslashes from path separators', async () => {
        sandbox.stub(process, 'platform').value('linux');
        const backslashLaunchPath = path.resolve(workspaceRoot, 'literal-backslash.csproj');
        const slashLaunchPath = path.resolve(workspaceRoot, 'slash-separated.csproj');
        sandbox.stub(service as unknown as AppHostLifecycleToolServiceTestAccess, 'discoverTargets').resolves({
            targets: [
                {
                    launchPath: backslashLaunchPath,
                    absolutePath: backslashLaunchPath,
                    selector: 'foo\\bar.csproj',
                },
                {
                    launchPath: slashLaunchPath,
                    absolutePath: slashLaunchPath,
                    selector: 'foo/bar.csproj',
                },
            ],
            hadFailures: false,
            hadSuppressedCandidates: false,
        });

        const backslashResult = await service.start({ appHostPath: 'foo\\bar.csproj', mode: 'run' }, token);
        const slashResult = await service.start({ appHostPath: 'foo/bar.csproj', mode: 'run' }, token);

        assert.strictEqual(backslashResult.outcome, 'started');
        assert.strictEqual(slashResult.outcome, 'started');
        assert.deepStrictEqual(launchService.launchCalls.map(call => call.appHostPath), [
            backslashLaunchPath,
            slashLaunchPath,
        ]);
    });

    test('POSIX selectors treat Windows absolute syntax as opaque discovery values', async () => {
        sandbox.stub(process, 'platform').value('linux');
        const driveLaunchPath = path.resolve(workspaceRoot, 'drive-selector.csproj');
        const rootedLaunchPath = path.resolve(workspaceRoot, 'rooted-selector.csproj');
        sandbox.stub(service as unknown as AppHostLifecycleToolServiceTestAccess, 'discoverTargets').resolves({
            targets: [
                {
                    launchPath: driveLaunchPath,
                    absolutePath: driveLaunchPath,
                    selector: 'C:\\AppHost.csproj',
                },
                {
                    launchPath: rootedLaunchPath,
                    absolutePath: rootedLaunchPath,
                    selector: '\\AppHost.csproj',
                },
            ],
            hadFailures: false,
            hadSuppressedCandidates: false,
        });

        const driveResult = await service.start({ appHostPath: 'C:\\AppHost.csproj', mode: 'run' }, token);
        const rootedResult = await service.start({ appHostPath: '\\AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(driveResult.outcome, 'started');
        assert.strictEqual(rootedResult.outcome, 'started');
        assert.deepStrictEqual(launchService.launchCalls.map(call => call.appHostPath), [
            driveLaunchPath,
            rootedLaunchPath,
        ]);
    });

    test('Windows selectors normalize backslash separators and reject Windows absolute syntax', async () => {
        sandbox.stub(process, 'platform').value('win32');
        const launchPath = path.resolve(workspaceRoot, 'windows-selector.csproj');
        sandbox.stub(service as unknown as AppHostLifecycleToolServiceTestAccess, 'discoverTargets').resolves({
            targets: [{
                launchPath,
                absolutePath: launchPath,
                selector: 'foo/bar.csproj',
            }],
            hadFailures: false,
            hadSuppressedCandidates: false,
        });

        const relativeResult = await service.start({ appHostPath: 'foo\\bar.csproj', mode: 'run' }, token);
        const driveResult = await service.start({ appHostPath: 'C:\\AppHost.csproj', mode: 'run' }, token);
        const rootedResult = await service.start({ appHostPath: '\\AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(relativeResult.outcome, 'started');
        assert.strictEqual(driveResult.outcome, 'invalidInput');
        assert.strictEqual(rootedResult.outcome, 'invalidInput');
        assert.deepStrictEqual(launchService.launchCalls.map(call => call.appHostPath), [launchPath]);
    });

    test('uses unique folder qualifiers to disambiguate multi-root selectors', async () => {
        const secondRoot = createFixtureDirectory('workspace');
        const secondAppHostPath = path.join(secondRoot, 'AppHost', 'AppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        const secondFolder = createWorkspaceFolder(secondRoot, 'workspace', 1);
        workspaceFoldersStub.value([workspaceFolder, secondFolder]);
        discoveryService.candidatesByFolder.set(secondRoot, [createCandidate(secondAppHostPath)]);

        const firstPath = await service.describeTarget('workspace~1/AppHost/AppHost.csproj', token);
        const secondPath = await service.describeTarget('workspace~2/AppHost/AppHost.csproj', token);

        assert.strictEqual(firstPath, 'workspace~1/AppHost/AppHost.csproj');
        assert.strictEqual(secondPath, 'workspace~2/AppHost/AppHost.csproj');
    });

    test('uses successful workspace roots when another root discovery fails', async () => {
        const secondRoot = createFixtureDirectory('workspace');
        const secondFolder = createWorkspaceFolder(secondRoot, 'workspace', 1);
        workspaceFoldersStub.value([workspaceFolder, secondFolder]);
        discoveryService.errorsByFolder.set(secondRoot, new Error('discovery failed'));

        const result = await service.start({ appHostPath: 'workspace~1/AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'started');
        assert.deepStrictEqual(launchService.launchCalls, [{
            appHostPath: path.resolve(appHostPath),
            command: 'run',
            noDebug: true,
        }]);
    });

    test('reports discoveryFailed when a selector is unresolved and another workspace root failed discovery', async () => {
        const secondRoot = createFixtureDirectory('workspace');
        const secondFolder = createWorkspaceFolder(secondRoot, 'workspace', 1);
        workspaceFoldersStub.value([workspaceFolder, secondFolder]);
        discoveryService.errorsByFolder.set(secondRoot, new Error('discovery failed'));

        const result = await service.start({ appHostPath: 'workspace~1/Missing/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'discoveryFailed');
        assert.strictEqual(result.knownAppHosts, undefined);
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('returns cancellation instead of throwing when the running AppHost probe is cancelled', async () => {
        runningAppHostError = new vscode.CancellationError();

        const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);

        assert.strictEqual(result.outcome, 'cancelled');
    });

    test('does not request confirmation for unresolved or identity-changing paths', async () => {
        const unsafePath = path.join(workspaceRoot, 'AppHost', `Bad\u202E.csproj`);
        fs.writeFileSync(unsafePath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(unsafePath)]);
        const tool = new AppHostStartLanguageModelTool(service);

        const prepared = await tool.prepareInvocation({
            input: { appHostPath: `AppHost/Bad\u202E.csproj`, mode: 'run' },
        }, token);

        assert.strictEqual(prepared.confirmationMessages, undefined);
    });

    test('returns candidates without confirmation when multiple AppHosts are discovered', async () => {
        const secondAppHostPath = path.join(workspaceRoot, 'SecondAppHost', 'SecondAppHost.csproj');
        fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
        fs.writeFileSync(secondAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [
            createCandidate(appHostPath),
            createCandidate(secondAppHostPath),
        ]);
        const startTool = new AppHostStartLanguageModelTool(service);
        const stopTool = new AppHostStopLanguageModelTool(service);

        const startPrepared = await startTool.prepareInvocation({
            input: { appHostPath: 'the discovered AppHost', mode: 'run' },
        }, token);
        const stopPrepared = await stopTool.prepareInvocation({
            input: { appHostPath: 'the discovered AppHost' },
        }, token);
        const result = await service.start({ appHostPath: 'the discovered AppHost', mode: 'run' }, token);

        assert.strictEqual(startPrepared.confirmationMessages, undefined);
        assert.strictEqual(stopPrepared.confirmationMessages, undefined);
        assert.strictEqual(result.outcome, 'unknownAppHost');
        assert.deepStrictEqual(result.knownAppHosts, [
            'AppHost/AppHost.csproj',
            'SecondAppHost/SecondAppHost.csproj',
        ]);
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('escapes Markdown metacharacters in start invocation and confirmation text while resolving the raw selector', async () => {
        const markdownAppHostPath = path.join(workspaceRoot, 'AppHost', '[prod]_AppHost_!.csproj');
        const selector = 'AppHost/[prod]_AppHost_!.csproj';
        fs.writeFileSync(markdownAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(markdownAppHostPath)]);
        const tool = new AppHostStartLanguageModelTool(service);

        const prepared = await tool.prepareInvocation({
            input: { appHostPath: selector, mode: 'debug' },
        }, token);

        assert.strictEqual(
            getMarkdownValue(prepared.invocationMessage),
            'Starting&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/\\[prod\\]\\_AppHost\\_\\!.csproj...');
        assert.strictEqual(
            getMarkdownValue(prepared.confirmationMessages?.message),
            'Start&nbsp;the&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/\\[prod\\]\\_AppHost\\_\\!.csproj&nbsp;in&nbsp;debug&nbsp;mode?');

        const result = await service.start({ appHostPath: selector, mode: 'debug' }, token);

        assert.strictEqual(result.outcome, 'started');
        assert.strictEqual(launchService.launchCalls[0].appHostPath, path.resolve(markdownAppHostPath));
    });

    test('renders Unicode line separators visibly in stop invocation and confirmation text while resolving the raw selector', async () => {
        const controlAppHostPath = path.join(workspaceRoot, 'AppHost', `Line\u2028Break.csproj`);
        const selector = `AppHost/Line\u2028Break.csproj`;
        fs.writeFileSync(controlAppHostPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(controlAppHostPath)]);
        const session = createDebugSession(controlAppHostPath, false, stoppedSession => stoppedSessions.push(stoppedSession));
        debugSessions.push(session);
        const tool = new AppHostStopLanguageModelTool(service);

        const prepared = await tool.prepareInvocation({
            input: { appHostPath: selector },
        }, token);

        assert.strictEqual(
            getMarkdownValue(prepared.invocationMessage),
            'Stopping&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/Line\\\\u2028Break.csproj...');
        assert.strictEqual(
            getMarkdownValue(prepared.confirmationMessages?.message),
            'Stop&nbsp;the&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/Line\\\\u2028Break.csproj?');

        const result = await service.stop({ appHostPath: selector }, token);

        assert.strictEqual(result.outcome, 'stopped');
        assert.deepStrictEqual(stoppedSessions, [session]);
    });

    test('distinguishes generated Unicode escapes from literal backslash sequences in invocation and confirmation text', async () => {
        const preparedPath = path.resolve(workspaceRoot, 'AppHost', `Actual\u2028Literal\\u2028.csproj`);
        sandbox.stub(service, 'prepareResolution').resolves({
            resolved: true,
            target: {
                launchPath: preparedPath,
                absolutePath: preparedPath,
                selector: `AppHost/Actual\u2028Literal\\u2028.csproj`,
            },
        });
        const tool = new AppHostStartLanguageModelTool(service);

        const prepared = await tool.prepareInvocation({
            input: { appHostPath: 'ignored', mode: 'run' },
        }, token);

        assert.strictEqual(
            getMarkdownValue(prepared.invocationMessage),
            'Starting&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/Actual\\\\u2028Literal\\\\\\\\u2028.csproj...');
        assert.strictEqual(
            getMarkdownValue(prepared.confirmationMessages?.message),
            'Start&nbsp;the&nbsp;Aspire&nbsp;AppHost&nbsp;AppHost/Actual\\\\u2028Literal\\\\\\\\u2028.csproj&nbsp;in&nbsp;run&nbsp;mode?');
    });

    test('returns workspaceNotTrusted without running discovery', async () => {
        isTrustedStub.value(false);

        const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(result.outcome, 'workspaceNotTrusted');
        assert.strictEqual(launchService.launchCalls.length, 0);
    });

    test('registers and disposes both tools when the API is available', () => {
        const disposed: string[] = [];
        const registerToolStub = sandbox.stub(vscode.lm, 'registerTool')
            .callsFake((name: string) => new vscode.Disposable(() => disposed.push(name)));

        const registration = registerAppHostLifecycleTools(service);

        assert.deepStrictEqual(
            registerToolStub.getCalls().map(call => call.args[0]),
            [aspireAppHostStartToolName, aspireAppHostStopToolName]);
        registration.dispose();
        assert.deepStrictEqual(disposed, [aspireAppHostStartToolName, aspireAppHostStopToolName]);
    });

    test('serializes tool results as one bounded text part', async () => {
        const tool = new AppHostStartLanguageModelTool(service);
        const input = { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' as const };
        await tool.prepareInvocation({ input }, token);

        const result = await tool.invoke({
            input: { ...input },
            toolInvocationToken: undefined,
        }, token);

        const content = result.content as Array<{ value?: unknown }>;
        assert.strictEqual(content.length, 1);
        assert.strictEqual(typeof content[0].value, 'string');
        const payload = JSON.parse(content[0].value as string) as AppHostLifecycleToolResult;
        assert.strictEqual(payload.outcome, 'started');
    });

    function createFixtureDirectory(prefix: string): string {
        const directory = fs.mkdtempSync(path.join(fixtureRoot, `${prefix}-`));
        fixtureDirectories.push(directory);
        return directory;
    }
});

suite('AppHost lifecycle identity', () => {
    const fixtureRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'apphost-identity');
    let directory: string;

    setup(() => {
        fs.mkdirSync(fixtureRoot, { recursive: true });
        directory = fs.mkdtempSync(path.join(fixtureRoot, 'identity-'));
    });

    teardown(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('matches a single C# project with Program.cs', () => {
        const projectPath = path.join(directory, 'AppHost.csproj');
        const sourcePath = path.join(directory, 'Program.cs');
        fs.writeFileSync(projectPath, '');
        fs.writeFileSync(sourcePath, '');

        assert.strictEqual(compareAppHostIdentity(projectPath, sourcePath), 'same');
    });

    test('reports an ambiguous alias when multiple C# projects share Program.cs', () => {
        const projectPath = path.join(directory, 'First.csproj');
        const sourcePath = path.join(directory, 'Program.cs');
        fs.writeFileSync(projectPath, '');
        fs.writeFileSync(path.join(directory, 'Second.csproj'), '');
        fs.writeFileSync(sourcePath, '');

        assert.strictEqual(compareAppHostIdentity(projectPath, sourcePath), 'ambiguous');
    });
});

function createWorkspaceFolder(folderPath: string, name: string, index: number): vscode.WorkspaceFolder {
    return {
        uri: vscode.Uri.file(folderPath),
        name,
        index,
    };
}

function createDirectoryLink(linkPath: string, targetPath: string): void {
    try {
        fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
    catch (error) {
        throw new Error(`Test setup failed: unable to create ${process.platform === 'win32' ? 'junction' : 'directory symlink'} '${linkPath}' -> '${targetPath}': ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!fs.lstatSync(linkPath).isSymbolicLink()) {
        throw new Error(`Test setup failed: expected '${linkPath}' to be a symbolic link or junction.`);
    }
}

function normalizeLexicalPath(value: string): string {
    const normalizedPath = path.resolve(value);
    return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

function getMarkdownValue(value: string | vscode.MarkdownString | undefined): string {
    assert.ok(value instanceof vscode.MarkdownString);
    return value.value;
}

function getToolResult(value: vscode.LanguageModelToolResult): AppHostLifecycleToolResult {
    const content = value.content as Array<{ value?: unknown }>;
    assert.strictEqual(content.length, 1);
    assert.strictEqual(typeof content[0].value, 'string');
    return JSON.parse(content[0].value as string) as AppHostLifecycleToolResult;
}

function createCandidate(candidatePath: string): CandidateAppHostDisplayInfo {
    return {
        path: candidatePath,
        language: 'csharp',
        status: 'buildable',
    };
}

function createDebugSession(
    program: string,
    noDebug: boolean,
    onStop: (session: AppHostLifecycleEditorSession) => void = () => { },
): AppHostLifecycleEditorSession {
    const session: AppHostLifecycleEditorSession = {
        appHostPath: program,
        configuration: {
            type: 'aspire',
            request: 'launch',
            name: 'Aspire',
            program,
            command: 'run',
            noDebug,
        },
        stopDebugging: async () => {
            onStop(session);
        },
    };
    return session;
}

function createDeferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value?: T) => void;
} {
    let resolvePromise: (value: T) => void = () => { };
    const promise = new Promise<T>(resolve => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: value => resolvePromise(value as T),
    };
}
