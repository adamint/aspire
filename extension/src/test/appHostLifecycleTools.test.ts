import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import {
    AppHostLifecycleToolService,
    AppHostStartLanguageModelTool,
    aspireAppHostStartToolName,
    aspireAppHostStopToolName,
    registerAppHostLifecycleTools,
    type AppHostLifecycleDiscoveryService,
    type AppHostLifecycleEditorSession,
    type AppHostLifecycleLaunchService,
    type AppHostLifecycleToolResult,
} from '../lm/appHostLifecycleTools';
import { compareAppHostIdentity, getAppHostPathComparisonKey } from '../utils/appHostIdentity';
import { type CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';

interface LaunchCall {
    readonly appHostPath: string;
    readonly command: string;
    readonly noDebug: boolean;
}

class FakeLaunchService implements AppHostLifecycleLaunchService {
    readonly launchCalls: LaunchCall[] = [];
    readonly launchingPaths = new Set<string>();
    launchGate: Promise<void> | undefined;
    onLaunch: (() => void) | undefined;

    isLaunching(appHostPath: string): boolean {
        return this.launchingPaths.has(getAppHostPathComparisonKey(appHostPath));
    }

    async launch(appHostPath: string, command: 'run', noDebug: boolean): Promise<void> {
        this.launchCalls.push({ appHostPath, command, noDebug });
        this.onLaunch?.();
        await this.launchGate;
    }
}

class FakeDiscoveryService implements AppHostLifecycleDiscoveryService {
    readonly candidatesByFolder = new Map<string, CandidateAppHostDisplayInfo[]>();
    error: Error | undefined;

    async discover(folder: vscode.WorkspaceFolder): Promise<readonly CandidateAppHostDisplayInfo[]> {
        if (this.error) {
            throw this.error;
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
        onRunningAppHostsRequested = undefined;
        service = new AppHostLifecycleToolService({
            launchService,
            discoveryService,
            getEditorSessions: () => debugSessions,
            getRunningAppHosts: async () => {
                onRunningAppHostsRequested?.();
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
            appHostPath: fs.realpathSync.native(appHostPath),
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

    test('rejects absolute and unknown selectors without reading them as filesystem targets', async () => {
        const absoluteResult = await service.start({ appHostPath, mode: 'run' }, token);
        const unknownResult = await service.start({ appHostPath: 'Other/AppHost.csproj', mode: 'run' }, token);

        assert.strictEqual(absoluteResult.outcome, 'invalidInput');
        assert.strictEqual(unknownResult.outcome, 'unknownAppHost');
        assert.deepStrictEqual(unknownResult.knownAppHosts, ['AppHost/AppHost.csproj']);
        assert.strictEqual(launchService.launchCalls.length, 0);
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

    test('returns cancellation instead of throwing when the running AppHost probe is cancelled', async () => {
        runningAppHostError = new vscode.CancellationError();

        const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, token);

        assert.strictEqual(result.outcome, 'cancelled');
    });

    test('does not echo unresolved or identity-changing paths into confirmations', async () => {
        const unsafePath = path.join(workspaceRoot, 'AppHost', `Bad\u202E.csproj`);
        fs.writeFileSync(unsafePath, '<Project Sdk="Microsoft.NET.Sdk" />');
        discoveryService.candidatesByFolder.set(workspaceRoot, [createCandidate(unsafePath)]);
        const tool = new AppHostStartLanguageModelTool(service);

        const prepared = await tool.prepareInvocation({
            input: { appHostPath: `AppHost/Bad\u202E.csproj`, mode: 'run' },
        }, token);

        assert.strictEqual(prepared.confirmationMessages?.title, 'Start Aspire AppHost');
        assert.strictEqual(prepared.confirmationMessages?.message, 'Start the Aspire AppHost an unresolved path in run mode?');
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

        const result = await tool.invoke({
            input: { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' },
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
