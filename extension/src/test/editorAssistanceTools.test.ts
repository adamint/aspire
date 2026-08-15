import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { type AspireOperationKind } from '../dcp/types';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import {
    type AppHostEditorStateLaunchService,
    type AppHostLifecycleDiscoveryService,
    type AppHostLifecycleEditorSessions,
} from '../lm/appHostLifecycleToolContracts';
import {
    AspireDebugSessionStatusLanguageModelTool,
    AspireExplainLaunchFailureLanguageModelTool,
    AspireListDebugSessionsLanguageModelTool,
    AspireOpenDashboardLanguageModelTool,
    AspireOpenOutputLanguageModelTool,
    registerEditorAssistanceTools,
} from '../lm/editorAssistanceToolAdapters';
import {
    aspireDebugSessionStatusToolName,
    aspireExplainLaunchFailureToolName,
    aspireListDebugSessionsToolName,
    aspireOpenDashboardToolName,
    aspireOpenOutputToolName,
    type EditorAssistanceResourceRepository,
    type EditorAssistanceToolResult,
    type EditorUiHandoffDebugSession,
} from '../lm/editorAssistanceToolContracts';
import { EditorAssistanceToolService } from '../lm/editorAssistanceToolService';
import { EditorUiHandoffService } from '../lm/editorUiHandoffService';
import { EditorStateSnapshotService } from '../lm/editorStateSnapshotService';
import {
    __resetLaunchFailureJournalForTests,
    LaunchFailureJournal,
    normalizeLaunchFailure,
    readLatestLaunchFailures,
    recordLaunchFailureForAppHostPath,
    type LaunchFailureInput,
    type SanitizedLaunchFailure,
} from '../services/launchFailureJournal';
import { SafeAppHostTargetResolver } from '../lm/safeAppHostTargetResolver';
import { type EditorResourceSessionSnapshot } from '../services/appHostLaunchContracts';
import { AspireCliParseError, type AppHostDisplayInfo, type ResourceJson } from '../data/appHostCliContracts';
import { type CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';
import {
    __resetAppHostIdentityRegistryForTests,
    compareAppHostIdentity,
    getOrCreateIdentityForAbsolutePath,
    type OpaqueAppHostIdentity,
} from '../utils/appHostIdentity';
import { extensionLogOutputChannel } from '../utils/logging';
import { directLink } from '../loc/strings';

interface TestEditorSession {
    readonly appHostPath: string | undefined;
    readonly resolvedAppHostPath: string | undefined;
    readonly operationKind: AspireOperationKind;
    readonly startupCompleted: boolean;
    readonly noDebug: boolean | undefined;
    readonly isStopping: boolean;
}

class FakeDiscoveryService implements AppHostLifecycleDiscoveryService {
    readonly candidatesByFolder = new Map<string, CandidateAppHostDisplayInfo[]>();
    readonly discoverErrorsByFolder = new Map<string, Error>();
    discoverCalls = 0;
    discoverError: Error | undefined;

    async discover(workspaceFolder: vscode.WorkspaceFolder, _forceRefresh?: boolean, cancellationToken?: vscode.CancellationToken): Promise<readonly CandidateAppHostDisplayInfo[]> {
        this.discoverCalls++;
        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.discoverError) {
            throw this.discoverError;
        }

        const folderError = this.discoverErrorsByFolder.get(workspaceFolder.uri.fsPath);
        if (folderError) {
            throw folderError;
        }

        return this.candidatesByFolder.get(workspaceFolder.uri.fsPath) ?? [];
    }
}

class FakeEditorStateLaunchService implements AppHostEditorStateLaunchService {
    readonly launchingPaths = new Set<string>();
    readonly pendingOrActiveRunLaunchPaths = new Set<string>();
    readonly editorSessions: TestEditorSession[] = [];

    isLaunching(appHostPath: string): boolean {
        return this.launchingPaths.has(path.resolve(appHostPath));
    }

    hasPendingOrActiveRunLaunch(appHostPath: string): boolean {
        return this.pendingOrActiveRunLaunchPaths.has(path.resolve(appHostPath));
    }

    getEditorRunSessions(appHostPath: string): AppHostLifecycleEditorSessions {
        const sessions = [] as Array<{
            appHostPath: string | undefined;
            startupCompleted: boolean;
            configuration: { noDebug?: boolean; command?: string };
            stopDebugging(): Promise<void>;
        }>;
        let ambiguous = false;
        for (const session of this.editorSessions) {
            if (session.operationKind !== 'run') {
                continue;
            }

            switch (compareAppHostIdentity(session.resolvedAppHostPath ?? session.appHostPath, appHostPath)) {
                case 'same':
                    sessions.push({
                        appHostPath: session.appHostPath,
                        startupCompleted: session.startupCompleted,
                        configuration: { noDebug: session.noDebug, command: session.operationKind },
                        stopDebugging: async () => { },
                    });
                    break;
                case 'ambiguous':
                    ambiguous = true;
                    break;
            }
        }

        return { sessions, ambiguous };
    }

    getEditorSessions(): readonly TestEditorSession[] {
        return this.editorSessions;
    }
}

class FakeEditorAssistanceResourceRepository implements EditorAssistanceResourceRepository {
    readonly resourcesByAppHost = new Map<string, readonly ResourceJson[]>();
    readonly requests: string[] = [];
    error: unknown;

    async fetchAppHostResourcesOnce(appHostPath: string, token: vscode.CancellationToken): Promise<readonly ResourceJson[]> {
        this.requests.push(appHostPath);
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.error) {
            throw this.error;
        }

        return this.resourcesByAppHost.get(path.resolve(appHostPath)) ?? [];
    }
}

class FakeEditorUiHandoffRepository {
    readonly requests: vscode.CancellationToken[] = [];
    appHosts: readonly AppHostDisplayInfo[] = [];
    error: unknown;

    async fetchRunningAppHostsOnce(token: vscode.CancellationToken): Promise<readonly AppHostDisplayInfo[]> {
        this.requests.push(token);
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.error) {
            throw this.error;
        }

        return this.appHosts;
    }
}

class FakeEditorOutput {
    readonly showCalls: Array<boolean | undefined> = [];
    error: unknown;

    show(preserveFocus?: boolean): void {
        this.showCalls.push(preserveFocus);
        if (this.error) {
            throw this.error;
        }
    }
}

const appHostProjectContents = `<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.0.0" />
</Project>`;

function createFixtureDirectory(prefix: string): string {
    const fixtureRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'editor-assistance');
    const directory = path.join(fixtureRoot, `${prefix}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function createWorkspaceFolder(root: string, name: string, index: number): vscode.WorkspaceFolder {
    return {
        uri: vscode.Uri.file(root),
        name,
        index,
    };
}

function addCandidate(discoveryService: FakeDiscoveryService, folderRoot: string, candidatePath: string): void {
    const existing = discoveryService.candidatesByFolder.get(folderRoot) ?? [];
    existing.push({ path: candidatePath, language: 'csharp', status: 'buildable' });
    discoveryService.candidatesByFolder.set(folderRoot, existing);
}

function assertResolved<T extends { resolved: boolean }>(resolution: T): asserts resolution is T & { resolved: true; target: { absolutePath: string; relativePath: string; displayPath: string; identity: string } } {
    assert.strictEqual(resolution.resolved, true, `Expected a resolved target but got ${JSON.stringify(resolution)}`);
}

function createResource(name: string, projectPath?: string, extraProperties: Record<string, string | null> = {}): ResourceJson {
    return {
        name,
        displayName: name,
        resourceType: 'Project',
        state: 'Running',
        stateStyle: null,
        healthStatus: null,
        healthReports: null,
        exitCode: null,
        dashboardUrl: null,
        urls: [],
        commands: null,
        properties: projectPath === undefined
            ? Object.keys(extraProperties).length > 0 ? extraProperties : null
            : { 'project.path': projectPath, ...extraProperties },
    };
}

function createRunningAppHost(
    appHostPath: string,
    dashboardUrl: string | null,
    status = 'running'): AppHostDisplayInfo {
    return {
        appHostPath,
        appHostPid: 1234,
        status,
        cliPid: null,
        dashboardUrl,
        resources: null,
    };
}

function createAspireConfiguration(values: Readonly<Record<string, unknown>> = {}): vscode.WorkspaceConfiguration {
    return {
        get<T>(section: string, defaultValue?: T): T | undefined {
            return Object.prototype.hasOwnProperty.call(values, section)
                ? values[section] as T
                : defaultValue;
        },
        inspect<T>(section: string): {
            key: string;
            defaultValue?: T;
            globalValue?: T;
            workspaceValue?: T;
            workspaceFolderValue?: T;
            defaultLanguageValue?: T;
            globalLanguageValue?: T;
            workspaceLanguageValue?: T;
            workspaceFolderLanguageValue?: T;
            languageIds?: string[];
        } | undefined {
            if (!Object.prototype.hasOwnProperty.call(values, section)) {
                return undefined;
            }

            return {
                key: section,
                globalValue: values[section] as T,
            };
        },
        has(section: string): boolean {
            return Object.prototype.hasOwnProperty.call(values, section);
        },
        update: async () => { },
    };
}

function readEditorAssistanceToolResult(result: vscode.LanguageModelToolResult): EditorAssistanceToolResult {
    const parts = result.content as Array<{ value?: unknown }>;
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(typeof parts[0]?.value, 'string');
    return JSON.parse(parts[0].value as string) as EditorAssistanceToolResult;
}

suite('Editor assistance AppHost services', () => {
    let workspaceRoot: string;
    let outsideRoot: string;
    let workspaceFoldersStub: sinon.SinonStub;
    let discoveryService: FakeDiscoveryService;
    let launchService: FakeEditorStateLaunchService;
    let resolver: SafeAppHostTargetResolver;
    let snapshotService: EditorStateSnapshotService;
    let appHostProjectPath: string;

    setup(() => {
        __resetAppHostIdentityRegistryForTests();
        __resetLaunchFailureJournalForTests();
        workspaceRoot = createFixtureDirectory('workspace');
        outsideRoot = createFixtureDirectory('outside');
        appHostProjectPath = path.join(workspaceRoot, 'AppHost', 'AppHost.csproj');
        fs.mkdirSync(path.dirname(appHostProjectPath), { recursive: true });
        fs.writeFileSync(appHostProjectPath, appHostProjectContents);

        workspaceFoldersStub = sinon.stub(vscode.workspace, 'workspaceFolders').value([
            createWorkspaceFolder(workspaceRoot, 'workspace', 0),
        ]);

        discoveryService = new FakeDiscoveryService();
        addCandidate(discoveryService, workspaceRoot, appHostProjectPath);
        launchService = new FakeEditorStateLaunchService();
        resolver = new SafeAppHostTargetResolver(discoveryService);
        snapshotService = new EditorStateSnapshotService({
            launchService,
            targetResolver: resolver,
        });
    });

    suite('Editor assistance language model tools', () => {
        let workspaceRoot: string;
        let secondWorkspaceRoot: string;
        let appHostProjectPath: string;
        let workspaceFoldersStub: sinon.SinonStub;
        let isTrustedStub: sinon.SinonStub;
        let discoveryService: FakeDiscoveryService;
        let launchService: FakeEditorStateLaunchService;
        let resolver: SafeAppHostTargetResolver;
        let snapshotService: EditorStateSnapshotService;
        let resourceRepository: FakeEditorAssistanceResourceRepository;
        let resourceSessions: EditorResourceSessionSnapshot[];
        let failuresByAppHost: Map<string, readonly SanitizedLaunchFailure[]>;
        let failureReaderError: unknown;
        let uiRepository: FakeEditorUiHandoffRepository;
        let editorOutput: FakeEditorOutput;
        let dashboardSessionsByIdentity: Map<OpaqueAppHostIdentity, readonly EditorUiHandoffDebugSession[]>;
        let uiHandoffService: EditorUiHandoffService;
        let service: EditorAssistanceToolService;

        setup(() => {
            __resetAppHostIdentityRegistryForTests();
            __resetLaunchFailureJournalForTests();
            workspaceRoot = createFixtureDirectory('tool-workspace');
            secondWorkspaceRoot = createFixtureDirectory('tool-second-workspace');
            appHostProjectPath = path.join(workspaceRoot, 'AppHost', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(appHostProjectPath), { recursive: true });
            fs.writeFileSync(appHostProjectPath, appHostProjectContents);

            workspaceFoldersStub = sinon.stub(vscode.workspace, 'workspaceFolders').value([
                createWorkspaceFolder(workspaceRoot, 'workspace', 0),
            ]);
            isTrustedStub = sinon.stub(vscode.workspace, 'isTrusted').value(true);
            discoveryService = new FakeDiscoveryService();
            addCandidate(discoveryService, workspaceRoot, appHostProjectPath);
            launchService = new FakeEditorStateLaunchService();
            resolver = new SafeAppHostTargetResolver(discoveryService);
            snapshotService = new EditorStateSnapshotService({
                launchService,
                targetResolver: resolver,
            });
            resourceRepository = new FakeEditorAssistanceResourceRepository();
            resourceSessions = [];
            failuresByAppHost = new Map();
            failureReaderError = undefined;
            uiRepository = new FakeEditorUiHandoffRepository();
            editorOutput = new FakeEditorOutput();
            dashboardSessionsByIdentity = new Map();
            uiHandoffService = new EditorUiHandoffService({
                targetResolver: resolver,
                appHostRepository: uiRepository,
                output: editorOutput,
                getAspireDebugSessions: identity => dashboardSessionsByIdentity.get(identity) ?? [],
            });
            service = new EditorAssistanceToolService({
                targetResolver: resolver,
                snapshotService,
                resourceRepository,
                getEditorResourceSessions: () => resourceSessions,
                readLatestLaunchFailures: appHostPath => {
                    if (failureReaderError) {
                        throw failureReaderError;
                    }

                    return failuresByAppHost.get(path.resolve(appHostPath)) ?? [];
                },
                uiHandoffService,
            });
        });

        teardown(() => {
            isTrustedStub.restore();
            workspaceFoldersStub.restore();
            __resetLaunchFailureJournalForTests();
            __resetAppHostIdentityRegistryForTests();
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
            fs.rmSync(secondWorkspaceRoot, { recursive: true, force: true });
        });

        test('rejects malformed status and explanation inputs before consulting dependencies', async () => {
            const token = new vscode.CancellationTokenSource().token;
            const invalidStatusInputs: unknown[] = [
                null,
                [],
                {},
                { appHostPath: 'AppHost/AppHost.csproj', extra: true },
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 42 },
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: '' },
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: '   ' },
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'a'.repeat(257) },
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api\nsecret' },
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api\u200dsecret' },
            ];
            for (const input of invalidStatusInputs) {
                assert.deepStrictEqual(await service.getDebugSessionStatus(input, token), {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'invalidInput',
                });
            }

            const invalidExplainInputs: unknown[] = [
                null,
                [],
                {},
                { appHostPath: 42 },
                { appHostPath: 'AppHost/AppHost.csproj', extra: true },
            ];
            for (const input of invalidExplainInputs) {
                assert.deepStrictEqual(await service.explainLaunchFailure(input, token), {
                    success: false,
                    tool: aspireExplainLaunchFailureToolName,
                    outcome: 'invalidInput',
                });
            }

            assert.strictEqual(discoveryService.discoverCalls, 0);
            assert.deepStrictEqual(resourceRepository.requests, []);
        });

        test('rejects absolute AppHost selectors through the shared resolver', async () => {
            const token = new vscode.CancellationTokenSource().token;

            assert.deepStrictEqual(await service.getDebugSessionStatus({ appHostPath: appHostProjectPath }, token), {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'invalidInput',
            });
            assert.deepStrictEqual(await service.explainLaunchFailure({ appHostPath: appHostProjectPath }, token), {
                success: false,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'invalidInput',
            });
            assert.strictEqual(discoveryService.discoverCalls, 0);
        });

        test('checks cancellation and workspace trust before doing work', async () => {
            const canceledSource = new vscode.CancellationTokenSource();
            canceledSource.cancel();

            assert.deepStrictEqual(
                await service.getDebugSessionStatus({ appHostPath: 'AppHost/AppHost.csproj' }, canceledSource.token),
                {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'canceled',
                });
            assert.deepStrictEqual(
                await service.explainLaunchFailure({ appHostPath: 'AppHost/AppHost.csproj' }, canceledSource.token),
                {
                    success: false,
                    tool: aspireExplainLaunchFailureToolName,
                    outcome: 'canceled',
                });

            isTrustedStub.value(false);
            const token = new vscode.CancellationTokenSource().token;
            assert.deepStrictEqual(await service.getDebugSessionStatus({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'workspaceNotTrusted',
            });
            assert.deepStrictEqual(await service.explainLaunchFailure({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                success: false,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'workspaceNotTrusted',
            });

            assert.strictEqual(discoveryService.discoverCalls, 0);
            assert.deepStrictEqual(resourceRepository.requests, []);
        });

        test('maps missing and ambiguous AppHost resolution without returning known AppHosts', async () => {
            const token = new vscode.CancellationTokenSource().token;
            const missing = await service.getDebugSessionStatus({ appHostPath: 'Missing/AppHost.csproj' }, token);
            assert.deepStrictEqual(missing, {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'appHostNotFound',
            });

            const secondAppHostPath = path.join(secondWorkspaceRoot, 'AppHost', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(secondAppHostPath), { recursive: true });
            fs.writeFileSync(secondAppHostPath, appHostProjectContents);
            addCandidate(discoveryService, secondWorkspaceRoot, secondAppHostPath);
            workspaceFoldersStub.value([
                createWorkspaceFolder(workspaceRoot, 'workspace', 0),
                createWorkspaceFolder(secondWorkspaceRoot, 'second', 1),
            ]);

            const ambiguous = await service.explainLaunchFailure({ appHostPath: 'AppHost/AppHost.csproj' }, token);
            assert.deepStrictEqual(ambiguous, {
                success: false,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'ambiguousAppHost',
            });
            assert.strictEqual(JSON.stringify([missing, ambiguous]).includes('knownAppHosts'), false);
        });

        test('returns exact sanitized AppHost-level states', async () => {
            const token = new vscode.CancellationTokenSource().token;
            const cases: Array<{
                sessions: TestEditorSession[];
                expected: EditorAssistanceToolResult;
            }> = [
                {
                    sessions: [],
                    expected: {
                        success: true,
                        tool: aspireDebugSessionStatusToolName,
                        outcome: 'notDebugging',
                        scope: 'appHost',
                        controller: 'editor',
                        appHost: 'AppHost/AppHost.csproj',
                    },
                },
                {
                    sessions: [{
                        appHostPath: appHostProjectPath,
                        resolvedAppHostPath: appHostProjectPath,
                        operationKind: 'run',
                        startupCompleted: false,
                        noDebug: true,
                        isStopping: false,
                    }],
                    expected: {
                        success: true,
                        tool: aspireDebugSessionStatusToolName,
                        outcome: 'starting',
                        scope: 'appHost',
                        controller: 'editor',
                        mode: 'run',
                        appHost: 'AppHost/AppHost.csproj',
                    },
                },
                {
                    sessions: [{
                        appHostPath: appHostProjectPath,
                        resolvedAppHostPath: appHostProjectPath,
                        operationKind: 'run',
                        startupCompleted: true,
                        noDebug: false,
                        isStopping: false,
                    }],
                    expected: {
                        success: true,
                        tool: aspireDebugSessionStatusToolName,
                        outcome: 'running',
                        scope: 'appHost',
                        controller: 'editor',
                        mode: 'debug',
                        appHost: 'AppHost/AppHost.csproj',
                    },
                },
                {
                    sessions: [{
                        appHostPath: appHostProjectPath,
                        resolvedAppHostPath: appHostProjectPath,
                        operationKind: 'run',
                        startupCompleted: true,
                        noDebug: true,
                        isStopping: true,
                    }],
                    expected: {
                        success: true,
                        tool: aspireDebugSessionStatusToolName,
                        outcome: 'stopping',
                        scope: 'appHost',
                        controller: 'editor',
                        mode: 'run',
                        appHost: 'AppHost/AppHost.csproj',
                    },
                },
            ];

            for (const testCase of cases) {
                launchService.editorSessions.splice(0, launchService.editorSessions.length, ...testCase.sessions);
                assert.deepStrictEqual(
                    await service.getDebugSessionStatus({ appHostPath: 'AppHost/AppHost.csproj' }, token),
                    testCase.expected);
            }

            launchService.editorSessions.push({ ...launchService.editorSessions[0] });
            assert.deepStrictEqual(
                await service.getDebugSessionStatus({ appHostPath: 'AppHost/AppHost.csproj' }, token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'multipleSessions',
                    scope: 'appHost',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                });
            assert.deepStrictEqual(resourceRepository.requests, []);
        });

        test('resolves the exact requested AppHost instead of inferring from the bounded list', async () => {
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            for (let index = 0; index < 20; index++) {
                const candidatePath = path.join(workspaceRoot, `Project${index.toString().padStart(2, '0')}`, 'AppHost.csproj');
                fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
                fs.writeFileSync(candidatePath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, candidatePath);
            }

            const exactAppHostPath = path.join(workspaceRoot, 'ZExact', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(exactAppHostPath), { recursive: true });
            fs.writeFileSync(exactAppHostPath, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, exactAppHostPath);
            launchService.editorSessions.push({
                appHostPath: exactAppHostPath,
                resolvedAppHostPath: exactAppHostPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const result = await service.getDebugSessionStatus(
                { appHostPath: 'ZExact/AppHost.csproj' },
                new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(result, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'running',
                scope: 'appHost',
                controller: 'editor',
                mode: 'debug',
                appHost: 'ZExact/AppHost.csproj',
            });
        });

        test('scopes a resource name and child session to the exact resolved AppHost', async () => {
            const otherAppHostPath = path.join(workspaceRoot, 'OtherAppHost', 'AppHost.csproj');
            const requestedProjectPath = path.join(workspaceRoot, 'Api', 'Api.csproj');
            const otherProjectPath = path.join(workspaceRoot, 'OtherApi', 'Api.csproj');
            fs.mkdirSync(path.dirname(otherAppHostPath), { recursive: true });
            fs.writeFileSync(otherAppHostPath, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, otherAppHostPath);
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('api', requestedProjectPath),
            ]);
            resourceRepository.resourcesByAppHost.set(path.resolve(otherAppHostPath), [
                createResource('api', otherProjectPath),
            ]);
            resourceSessions.push({
                appHostPath: otherAppHostPath,
                targetPath: otherProjectPath,
                state: 'running',
                mode: 'debug',
            });

            const noMatch = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(noMatch, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'notDebugging',
                scope: 'resource',
                controller: 'editor',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });

            resourceSessions.push({
                appHostPath: appHostProjectPath,
                targetPath: path.join(workspaceRoot, 'Api', '.', 'Api.csproj'),
                state: 'running',
                mode: 'debug',
            });
            const match = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(match, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'running',
                scope: 'resource',
                controller: 'editor',
                mode: 'debug',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });
            assert.deepStrictEqual(resourceRepository.requests, [appHostProjectPath, appHostProjectPath]);
        });

        test('matches resource sessions across AppHost project and source aliases', async () => {
            const programPath = path.join(path.dirname(appHostProjectPath), 'Program.cs');
            fs.writeFileSync(programPath, '// Program');

            const sourceAliasDirectory = path.join(workspaceRoot, 'SourceAlias');
            const sourceAliasProjectPath = path.join(sourceAliasDirectory, 'SourceAlias.csproj');
            const sourceAliasPath = path.join(sourceAliasDirectory, 'apphost.cs');
            fs.mkdirSync(sourceAliasDirectory, { recursive: true });
            fs.writeFileSync(sourceAliasProjectPath, appHostProjectContents);
            fs.writeFileSync(sourceAliasPath, '// AppHost');

            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            addCandidate(discoveryService, workspaceRoot, programPath);
            addCandidate(discoveryService, workspaceRoot, sourceAliasProjectPath);

            const programResourcePath = path.join(workspaceRoot, 'Api', 'Api.csproj');
            const sourceAliasResourcePath = path.join(workspaceRoot, 'Worker', 'Worker.csproj');
            resourceRepository.resourcesByAppHost.set(path.resolve(programPath), [
                createResource('api', programResourcePath),
            ]);
            resourceRepository.resourcesByAppHost.set(path.resolve(sourceAliasProjectPath), [
                createResource('worker', sourceAliasResourcePath),
            ]);
            resourceSessions.push(
                {
                    appHostPath: appHostProjectPath,
                    targetPath: programResourcePath,
                    state: 'running',
                    mode: 'debug',
                },
                {
                    appHostPath: sourceAliasPath,
                    targetPath: sourceAliasResourcePath,
                    state: 'running',
                    mode: 'run',
                });

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/Program.cs', resourceName: 'api' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'running',
                    scope: 'resource',
                    controller: 'editor',
                    mode: 'debug',
                    appHost: 'AppHost/Program.cs',
                    resourceName: 'api',
                });
            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'SourceAlias/SourceAlias.csproj', resourceName: 'worker' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'running',
                    scope: 'resource',
                    controller: 'editor',
                    mode: 'run',
                    appHost: 'SourceAlias/SourceAlias.csproj',
                    resourceName: 'worker',
                });
        });

        test('does not match AppHost aliases across workspace roots', async () => {
            const firstProgramPath = path.join(path.dirname(appHostProjectPath), 'Program.cs');
            const secondAppHostDirectory = path.join(secondWorkspaceRoot, 'AppHost');
            const secondAppHostProjectPath = path.join(secondAppHostDirectory, 'AppHost.csproj');
            const secondProgramPath = path.join(secondAppHostDirectory, 'Program.cs');
            fs.writeFileSync(firstProgramPath, '// Program');
            fs.mkdirSync(secondAppHostDirectory, { recursive: true });
            fs.writeFileSync(secondAppHostProjectPath, appHostProjectContents);
            fs.writeFileSync(secondProgramPath, '// Program');

            workspaceFoldersStub.value([
                createWorkspaceFolder(workspaceRoot, 'workspace', 0),
                createWorkspaceFolder(secondWorkspaceRoot, 'second', 1),
            ]);
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            addCandidate(discoveryService, workspaceRoot, firstProgramPath);
            addCandidate(discoveryService, secondWorkspaceRoot, secondProgramPath);

            const resourcePath = path.join(workspaceRoot, 'Api', 'Api.csproj');
            resourceRepository.resourcesByAppHost.set(path.resolve(firstProgramPath), [
                createResource('api', resourcePath),
            ]);
            resourceSessions.push({
                appHostPath: secondAppHostProjectPath,
                targetPath: resourcePath,
                state: 'running',
                mode: 'debug',
            });

            const crossRootResult = await service.getDebugSessionStatus(
                { appHostPath: 'workspace/AppHost/Program.cs', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(crossRootResult, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'notDebugging',
                scope: 'resource',
                controller: 'editor',
                appHost: 'workspace/AppHost/Program.cs',
                resourceName: 'api',
            });

            resourceSessions.push({
                appHostPath: appHostProjectPath,
                targetPath: resourcePath,
                state: 'running',
                mode: 'debug',
            });

            const exactRootResult = await service.getDebugSessionStatus(
                { appHostPath: 'workspace/AppHost/Program.cs', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(exactRootResult, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'running',
                scope: 'resource',
                controller: 'editor',
                mode: 'debug',
                appHost: 'workspace/AppHost/Program.cs',
                resourceName: 'api',
            });
        });

        test('correlates Node, Python, Go, and Rust-like resources through executable.path', async () => {
            const cases = [
                ['node', path.join(workspaceRoot, 'Web', 'server.js'), 'node'],
                ['python', path.join(workspaceRoot, 'Python', 'main.py'), path.join(workspaceRoot, 'Python', '.venv', 'bin', 'python')],
                ['go', path.join(workspaceRoot, 'Go', 'cmd', 'api'), 'go'],
                ['rust', path.join(workspaceRoot, 'Rust', 'target', 'debug', 'api'), 'cargo'],
            ] as const;

            for (const [resourceName, targetPath, resourceExecutablePath] of cases) {
                resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                    createResource(resourceName, undefined, { 'executable.path': resourceExecutablePath }),
                ]);
                resourceSessions.splice(0, resourceSessions.length, {
                    appHostPath: appHostProjectPath,
                    targetPath: path.join(path.dirname(targetPath), '.', path.basename(targetPath)),
                    resourceExecutablePaths: [path.join(
                        path.dirname(resourceExecutablePath),
                        '.',
                        path.basename(resourceExecutablePath))],
                    state: 'running',
                    mode: 'debug',
                });

                assert.deepStrictEqual(
                    await service.getDebugSessionStatus(
                        { appHostPath: 'AppHost/AppHost.csproj', resourceName },
                        new vscode.CancellationTokenSource().token),
                    {
                        success: true,
                        tool: aspireDebugSessionStatusToolName,
                        outcome: 'running',
                        scope: 'resource',
                        controller: 'editor',
                        mode: 'debug',
                        appHost: 'AppHost/AppHost.csproj',
                        resourceName,
                    });
            }
        });

        test('returns resourceAmbiguous when different exact resource names share one target path', async () => {
            const sharedTargetPath = 'node';
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('api', undefined, { 'executable.path': sharedTargetPath }),
                createResource('worker', undefined, { 'executable.path': sharedTargetPath }),
            ]);
            resourceSessions.push({
                appHostPath: appHostProjectPath,
                targetPath: path.join(workspaceRoot, 'Api', 'server.js'),
                resourceExecutablePaths: [sharedTargetPath],
                state: 'running',
                mode: 'debug',
            });

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'resourceAmbiguous',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'api',
                });
        });

        test('correlates Python executable entrypoints and fails closed when candidates span resources', async () => {
            const scriptsDirectory = path.join(
                workspaceRoot,
                'Python',
                '.venv',
                process.platform === 'win32' ? 'Scripts' : 'bin');
            const interpreterPath = path.join(
                scriptsDirectory,
                process.platform === 'win32' ? 'python.exe' : 'python');
            const executablePath = path.join(
                scriptsDirectory,
                process.platform === 'win32' ? 'pytest.exe' : 'pytest');
            const session = {
                appHostPath: appHostProjectPath,
                targetPath: path.join(workspaceRoot, 'Python'),
                resourceExecutablePaths: [interpreterPath, executablePath],
                state: 'running',
                mode: 'debug',
            } as const;
            resourceSessions.push(session);
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('tests', undefined, { 'executable.path': executablePath }),
            ]);

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'tests' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'running',
                    scope: 'resource',
                    controller: 'editor',
                    mode: 'debug',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'tests',
                });

            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('module', undefined, { 'executable.path': interpreterPath }),
                createResource('tests', undefined, { 'executable.path': executablePath }),
            ]);

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'tests' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'resourceAmbiguous',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'tests',
                });
        });

        test('does not report shared-target ambiguity when no child session needs attribution', async () => {
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('api', undefined, { 'executable.path': 'node' }),
                createResource('worker', undefined, { 'executable.path': 'node' }),
            ]);

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'notDebugging',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'api',
                });
        });

        test('fails closed for missing or duplicate exact resource names', async () => {
            const token = new vscode.CancellationTokenSource().token;
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('worker', path.join(workspaceRoot, 'Worker', 'Worker.csproj')),
            ]);

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                    token),
                {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'resourceNotFound',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'api',
                });

            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('api', path.join(workspaceRoot, 'Api1', 'Api.csproj')),
                createResource('api', path.join(workspaceRoot, 'Api2', 'Api.csproj')),
            ]);
            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                    token),
                {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'resourceAmbiguous',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'api',
                });
        });

        test('returns notDebugging when a resource has no usable target path', async () => {
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('container'),
            ]);
            resourceSessions.push({
                appHostPath: appHostProjectPath,
                targetPath: path.join(workspaceRoot, 'Container', 'Container.csproj'),
                state: 'running',
                mode: 'debug',
            });

            const result = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'container' },
                new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(result, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'notDebugging',
                scope: 'resource',
                controller: 'editor',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'container',
            });
        });

        test('reports resource starting, stopping, and multiple child sessions without exposing internals', async () => {
            const projectPath = path.join(workspaceRoot, 'Api', 'Api.csproj');
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('api', projectPath, {
                    connectionString: 'secret-connection',
                    dashboardUrl: 'https://private.example',
                }),
            ]);
            resourceSessions.push({
                appHostPath: appHostProjectPath,
                targetPath: projectPath,
                state: 'starting',
                mode: 'other',
                sessionId: 'secret-session',
                pid: 4242,
            } as EditorResourceSessionSnapshot & { sessionId?: string; pid?: number });

            const starting = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(starting, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'starting',
                scope: 'resource',
                controller: 'editor',
                mode: 'other',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });

            resourceSessions[0] = {
                appHostPath: appHostProjectPath,
                targetPath: projectPath,
                state: 'stopping',
                mode: 'debug',
            };
            const stopping = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(stopping, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'stopping',
                scope: 'resource',
                controller: 'editor',
                mode: 'debug',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });

            resourceSessions.push({ ...resourceSessions[0], state: 'running' });
            const multiple = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(multiple, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'multipleSessions',
                scope: 'resource',
                controller: 'editor',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });

            const serialized = JSON.stringify([starting, stopping, multiple]);
            assert.strictEqual(serialized.includes(workspaceRoot), false);
            assert.strictEqual(serialized.includes('targetPath'), false);
            assert.strictEqual(serialized.includes('resourceExecutablePaths'), false);
            assert.strictEqual(serialized.includes('project.path'), false);
            assert.strictEqual(serialized.includes('executable.path'), false);
            assert.strictEqual(serialized.includes('properties'), false);
            assert.strictEqual(serialized.includes('secret-connection'), false);
            assert.strictEqual(serialized.includes('private.example'), false);
            assert.strictEqual(serialized.includes('sessionId'), false);
            assert.strictEqual(serialized.includes('pid'), false);
        });

        test('handles stopped AppHost fetch failures without swallowing cancellation or other errors', async () => {
            resourceRepository.error = new AspireCliParseError(
                'aspire describe',
                '',
                new SyntaxError('Unexpected end of JSON input'));
            const stopped = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(stopped, {
                success: true,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'notDebugging',
                scope: 'resource',
                controller: 'editor',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });

            resourceRepository.error = new vscode.CancellationError();
            const canceled = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(canceled, {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'canceled',
            });

            resourceRepository.error = new AspireCliParseError(
                'aspire describe',
                'not json',
                new SyntaxError('Unexpected token'));
            const malformed = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(malformed, {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'error',
            });

            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });
            resourceRepository.error = new AspireCliParseError(
                'aspire describe',
                '',
                new SyntaxError('Unexpected end of JSON input'));
            const running = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(running, {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'error',
            });

            launchService.editorSessions.length = 0;
            resourceRepository.error = new Error(`secret ${workspaceRoot}`);
            const failed = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(failed, {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'error',
            });
            assert.strictEqual(JSON.stringify(failed).includes(workspaceRoot), false);
        });

        test('maps every launch failure category to finite recommended actions', async () => {
            const expectedActions = new Map<SanitizedLaunchFailure['category'], readonly string[]>([
                ['invalidConfiguration', ['checkAspireOutput']],
                ['missingDependency', ['checkDependencies']],
                ['cliUnavailable', ['installAspireCli']],
                ['buildFailed', ['fixBuildErrors']],
                ['processExited', ['checkAspireOutput']],
                ['timeout', ['retryLaunch']],
                ['portConflict', ['freeRequiredPort']],
                ['permissionDenied', ['checkPermissions']],
                ['unsupported', ['checkDependencies']],
                ['canceled', ['retryLaunch']],
                ['unknown', ['checkAspireOutput']],
            ]);

            for (const [category, recommendedActions] of expectedActions) {
                failuresByAppHost.set(path.resolve(appHostProjectPath), [normalizeLaunchFailure({
                    stage: 'debugSession',
                    category,
                    controller: 'editor',
                    mode: 'debug',
                    providerKind: 'dotnet',
                    exitCode: 1,
                })]);

                const result = await service.explainLaunchFailure(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'failureFound');
                if (result.outcome !== 'failureFound') {
                    assert.fail(`Expected failureFound for ${category}`);
                }
                assert.strictEqual(result.category, category);
                assert.deepStrictEqual(result.recommendedActions, recommendedActions);
            }
        });

        test('returns only the latest sanitized journal entry and no raw metadata', async () => {
            const latest = {
                ...normalizeLaunchFailure({
                    stage: 'build',
                    category: 'buildFailed',
                    controller: 'cli',
                    mode: 'run',
                    providerKind: 'node',
                    exitCode: 17,
                }),
                appHostIdentity: 'apphost-99',
                recordedAt: 123456,
                sequence: 42,
                detail: `secret ${workspaceRoot}`,
            };
            const older = normalizeLaunchFailure({
                stage: 'dashboard',
                category: 'unknown',
                controller: 'editor',
                mode: 'debug',
                providerKind: 'browser',
            });
            failuresByAppHost.set(path.resolve(appHostProjectPath), [latest, older]);

            const result = await service.explainLaunchFailure(
                { appHostPath: 'AppHost/AppHost.csproj' },
                new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(result, {
                success: true,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'failureFound',
                appHost: 'AppHost/AppHost.csproj',
                stage: 'build',
                category: 'buildFailed',
                controller: 'cli',
                mode: 'run',
                providerKind: 'node',
                exitCodeBucket: 'other',
                recommendedActions: ['fixBuildErrors'],
            });
            const serialized = JSON.stringify(result);
            assert.strictEqual(serialized.includes(workspaceRoot), false);
            assert.strictEqual(serialized.includes('apphost-99'), false);
            assert.strictEqual(serialized.includes('recordedAt'), false);
            assert.strictEqual(serialized.includes('sequence'), false);
            assert.strictEqual(serialized.includes('detail'), false);
        });

        test('reports noRecordedFailure when the unexpired journal has no entry', async () => {
            const result = await service.explainLaunchFailure(
                { appHostPath: 'AppHost/AppHost.csproj' },
                new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(result, {
                success: true,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'noRecordedFailure',
                appHost: 'AppHost/AppHost.csproj',
            });
        });

        test('sanitizes launch failure reader errors and cancellation', async () => {
            failureReaderError = new vscode.CancellationError();
            assert.deepStrictEqual(
                await service.explainLaunchFailure(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token),
                {
                    success: false,
                    tool: aspireExplainLaunchFailureToolName,
                    outcome: 'canceled',
                });

            failureReaderError = new Error(`secret ${workspaceRoot}`);
            const failed = await service.explainLaunchFailure(
                { appHostPath: 'AppHost/AppHost.csproj' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(failed, {
                success: false,
                tool: aspireExplainLaunchFailureToolName,
                outcome: 'error',
            });
            assert.strictEqual(JSON.stringify(failed).includes(workspaceRoot), false);
        });

        test('strictly validates dashboard and empty-object tool inputs before consulting dependencies', async () => {
            const token = new vscode.CancellationTokenSource().token;
            for (const input of [
                null,
                [],
                {},
                { appHostPath: 42 },
                { appHostPath: 'AppHost/AppHost.csproj', extra: true },
            ]) {
                assert.deepStrictEqual(await service.openDashboard(input, token), {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'invalidInput',
                });
            }

            for (const input of [null, [], new Date(), { extra: true }]) {
                assert.deepStrictEqual(await service.openOutput(input, token), {
                    success: false,
                    tool: aspireOpenOutputToolName,
                    outcome: 'invalidInput',
                });
                assert.deepStrictEqual(await service.listDebugSessions(input, token), {
                    success: false,
                    tool: aspireListDebugSessionsToolName,
                    outcome: 'invalidInput',
                    sessions: [],
                });
            }

            assert.strictEqual(discoveryService.discoverCalls, 0);
            assert.strictEqual(uiRepository.requests.length, 0);
            assert.deepStrictEqual(editorOutput.showCalls, []);
        });

        test('checks cancellation and workspace trust for every handoff tool', async () => {
            const canceledSource = new vscode.CancellationTokenSource();
            canceledSource.cancel();

            assert.deepStrictEqual(
                await service.openDashboard({ appHostPath: 'AppHost/AppHost.csproj' }, canceledSource.token),
                {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'canceled',
                });
            assert.deepStrictEqual(await service.openOutput({}, canceledSource.token), {
                success: false,
                tool: aspireOpenOutputToolName,
                outcome: 'canceled',
            });
            assert.deepStrictEqual(await service.listDebugSessions({}, canceledSource.token), {
                success: false,
                tool: aspireListDebugSessionsToolName,
                outcome: 'canceled',
                sessions: [],
            });

            isTrustedStub.value(false);
            const token = new vscode.CancellationTokenSource().token;
            assert.deepStrictEqual(await service.openDashboard({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                success: false,
                tool: aspireOpenDashboardToolName,
                outcome: 'workspaceNotTrusted',
            });
            assert.deepStrictEqual(await service.openOutput({}, token), {
                success: false,
                tool: aspireOpenOutputToolName,
                outcome: 'workspaceNotTrusted',
            });
            assert.deepStrictEqual(await service.listDebugSessions({}, token), {
                success: false,
                tool: aspireListDebugSessionsToolName,
                outcome: 'workspaceNotTrusted',
                sessions: [],
            });

            assert.strictEqual(discoveryService.discoverCalls, 0);
            assert.strictEqual(uiRepository.requests.length, 0);
            assert.deepStrictEqual(editorOutput.showCalls, []);
        });

        test('rechecks Output trust after confirmation before focusing the editor', async () => {
            const tool = new AspireOpenOutputLanguageModelTool(service);
            const input = {};
            const prepared = await tool.prepareInvocation(
                { input },
                new vscode.CancellationTokenSource().token);
            assert.ok(prepared.confirmationMessages);

            isTrustedStub.value(false);
            const result = readEditorAssistanceToolResult(await tool.invoke(
                { input, toolInvocationToken: undefined },
                new vscode.CancellationTokenSource().token));

            assert.deepStrictEqual(result, {
                success: false,
                tool: aspireOpenOutputToolName,
                outcome: 'workspaceNotTrusted',
            });
            assert.deepStrictEqual(editorOutput.showCalls, []);
        });

        test('prepares localized Dashboard and Output confirmations without UI or URL lookup', async () => {
            const dashboardTool = new AspireOpenDashboardLanguageModelTool(service);
            const outputTool = new AspireOpenOutputLanguageModelTool(service);
            const token = new vscode.CancellationTokenSource().token;

            const dashboard = await dashboardTool.prepareInvocation(
                { input: { appHostPath: 'AppHost/AppHost.csproj' } },
                token);
            const output = await outputTool.prepareInvocation({ input: {} }, token);

            assert.deepStrictEqual(dashboard, {
                invocationMessage: 'Opening Aspire Dashboard for AppHost/AppHost.csproj...',
                confirmationMessages: {
                    title: 'Open Aspire Dashboard',
                    message: 'Open the Aspire Dashboard for AppHost/AppHost.csproj?',
                },
            });
            assert.deepStrictEqual(output, {
                invocationMessage: 'Showing Aspire Output...',
                confirmationMessages: {
                    title: 'Show Aspire Output',
                    message: 'The Aspire Output view will be shown.',
                },
            });
            assert.strictEqual(uiRepository.requests.length, 0);
            assert.deepStrictEqual(editorOutput.showCalls, []);
        });

        test('prepares Dashboard confirmation with safe Markdown and never echoes unresolved input', async () => {
            const directoryName = process.platform === 'win32' ? 'foo_bar[x](y)&copy;' : 'foo_bar*[x](y)&copy;';
            const expectedDirectory = process.platform === 'win32'
                ? 'foo\\_bar\\[x\\]\\(y\\)\\&copy;'
                : 'foo\\_bar\\*\\[x\\]\\(y\\)\\&copy;';
            const specialPath = path.join(workspaceRoot, directoryName, 'AppHost.csproj');
            fs.mkdirSync(path.dirname(specialPath), { recursive: true });
            fs.writeFileSync(specialPath, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, specialPath);
            const tool = new AspireOpenDashboardLanguageModelTool(service);
            const token = new vscode.CancellationTokenSource().token;

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: `${directoryName}/AppHost.csproj` } },
                token);
            const injected = '../raw **model text** https://example.invalid/private';
            const unresolved = await tool.prepareInvocation(
                { input: { appHostPath: injected } },
                token);

            assert.strictEqual(
                prepared.confirmationMessages?.message,
                `Open the Aspire Dashboard for ${expectedDirectory}/AppHost.csproj?`);
            assert.strictEqual(
                unresolved.confirmationMessages?.message,
                'Open the Aspire Dashboard for an unresolved path?');
            assert.strictEqual(JSON.stringify(unresolved).includes(injected), false);
            assert.strictEqual(uiRepository.requests.length, 0);
        });

        test('re-resolves the Dashboard target after confirmation before opening anything', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const tool = new AspireOpenDashboardLanguageModelTool(service);
                const input = { appHostPath: 'AppHost/AppHost.csproj' };
                const prepared = await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);
                assert.strictEqual(
                    prepared.confirmationMessages?.message,
                    'Open the Aspire Dashboard for AppHost/AppHost.csproj?');

                const replacementPath = path.join(secondWorkspaceRoot, 'AppHost', 'AppHost.csproj');
                fs.mkdirSync(path.dirname(replacementPath), { recursive: true });
                fs.writeFileSync(replacementPath, appHostProjectContents);
                addCandidate(discoveryService, secondWorkspaceRoot, replacementPath);
                workspaceFoldersStub.value([
                    createWorkspaceFolder(secondWorkspaceRoot, 'second', 0),
                ]);
                uiRepository.appHosts = [
                    createRunningAppHost(replacementPath, 'https://replacement.example.invalid/login?t=private'),
                ];

                const result = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));

                assert.deepStrictEqual(result, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'externalBrowser',
                });
                assert.strictEqual(openExternal.callCount, 1);
                assert.strictEqual(
                    (openExternal.firstCall.args[0] as vscode.Uri).toString(true),
                    'https://replacement.example.invalid/login?t=private');
            }
            finally {
                sandbox.restore();
            }
        });

        test('opens only the exact current running AppHost and never returns its URL', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const secretUrl = 'https://dashboard.example.invalid/login?t=secret';
                uiRepository.appHosts = [
                    createRunningAppHost(path.join(workspaceRoot, 'Other', 'AppHost.csproj'), 'https://other.example.invalid/login?t=other'),
                    createRunningAppHost(appHostProjectPath, secretUrl),
                ];

                const result = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(result, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'externalBrowser',
                });
                assert.strictEqual(openExternal.callCount, 1);
                assert.strictEqual((openExternal.firstCall.args[0] as vscode.Uri).toString(true), secretUrl);
                assert.strictEqual(JSON.stringify(result).includes(secretUrl), false);
            }
            finally {
                sandbox.restore();
            }
        });

        test('correlates fresh running rows through AppHost path equivalence', async function () {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const sourceAppHostPath = path.join(path.dirname(appHostProjectPath), 'Program.cs');
                fs.writeFileSync(sourceAppHostPath, 'var builder = DistributedApplication.CreateBuilder(args);');
                const linkedDirectory = path.join(workspaceRoot, 'Linked');
                const linkedAppHostPath = path.join(linkedDirectory, 'AppHost.csproj');
                fs.mkdirSync(linkedDirectory, { recursive: true });
                try {
                    fs.symlinkSync(appHostProjectPath, linkedAppHostPath);
                }
                catch {
                    this.skip();
                    return;
                }

                for (const appHostPath of [sourceAppHostPath, linkedAppHostPath]) {
                    uiRepository.appHosts = [
                        createRunningAppHost(appHostPath, 'https://dashboard.example.invalid/login?t=private'),
                    ];

                    const result = await service.openDashboard(
                        { appHostPath: 'AppHost/AppHost.csproj' },
                        new vscode.CancellationTokenSource().token);

                    assert.deepStrictEqual(result, {
                        success: true,
                        tool: aspireOpenDashboardToolName,
                        outcome: 'opened',
                        presentation: 'externalBrowser',
                    });
                }

                assert.strictEqual(openExternal.callCount, 2);
            }
            finally {
                sandbox.restore();
            }
        });

        test('fails closed when any fresh running row has an ambiguous AppHost relationship', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const sourceAppHostPath = path.join(path.dirname(appHostProjectPath), 'Program.cs');
                const secondProjectPath = path.join(path.dirname(appHostProjectPath), 'Other.csproj');
                fs.writeFileSync(sourceAppHostPath, 'var builder = DistributedApplication.CreateBuilder(args);');
                fs.writeFileSync(secondProjectPath, appHostProjectContents);
                uiRepository.appHosts = [
                    createRunningAppHost(appHostProjectPath, 'https://dashboard.example.invalid/login?t=private'),
                    createRunningAppHost(sourceAppHostPath, 'https://dashboard.example.invalid/login?t=other'),
                ];

                const result = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(result, {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'ambiguousAppHost',
                });
                assert.strictEqual(openExternal.callCount, 0);
            }
            finally {
                sandbox.restore();
            }
        });

        test('reports missing, stopped, duplicate, and unavailable Dashboard targets without UI', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration());
                const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const startDebugging = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
                const token = new vscode.CancellationTokenSource().token;

                assert.deepStrictEqual(await service.openDashboard({ appHostPath: 'Missing/AppHost.csproj' }, token), {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'appHostNotFound',
                });

                assert.deepStrictEqual(await service.openDashboard({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'appHostNotRunning',
                });

                uiRepository.appHosts = [createRunningAppHost(appHostProjectPath, 'https://stopped.example.invalid', 'stopped')];
                assert.deepStrictEqual(await service.openDashboard({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'appHostNotRunning',
                });

                uiRepository.appHosts = [
                    createRunningAppHost(appHostProjectPath, 'https://one.example.invalid'),
                    createRunningAppHost(appHostProjectPath, 'https://two.example.invalid'),
                ];
                assert.deepStrictEqual(await service.openDashboard({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'ambiguousAppHost',
                });

                for (const dashboardUrl of [null, 'file:///workspace/private', 'not a URL']) {
                    uiRepository.appHosts = [createRunningAppHost(appHostProjectPath, dashboardUrl)];
                    assert.deepStrictEqual(await service.openDashboard({ appHostPath: 'AppHost/AppHost.csproj' }, token), {
                        success: false,
                        tool: aspireOpenDashboardToolName,
                        outcome: 'dashboardUnavailable',
                    });
                }

                assert.strictEqual(executeCommand.callCount, 0);
                assert.strictEqual(openExternal.callCount, 0);
                assert.strictEqual(startDebugging.callCount, 0);
            }
            finally {
                sandbox.restore();
            }
        });

        test('uses each configured Dashboard presentation and overrides automatic none', async () => {
            const cases: Array<{
                values: Readonly<Record<string, unknown>>;
                expectedPresentation: 'integratedBrowser' | 'externalBrowser' | 'debugBrowser' | 'notification';
                expectedDebugType?: string;
            }> = [
                {
                    values: { dashboardBrowser: 'integratedBrowser' },
                    expectedPresentation: 'integratedBrowser',
                },
                {
                    values: { dashboardBrowser: 'openExternalBrowser' },
                    expectedPresentation: 'externalBrowser',
                },
                {
                    values: { dashboardBrowser: 'debugChrome' },
                    expectedPresentation: 'debugBrowser',
                    expectedDebugType: 'pwa-chrome',
                },
                {
                    values: { dashboardBrowser: 'debugEdge' },
                    expectedPresentation: 'debugBrowser',
                    expectedDebugType: 'pwa-msedge',
                },
                {
                    values: { dashboardBrowser: 'debugFirefox' },
                    expectedPresentation: 'debugBrowser',
                    expectedDebugType: 'firefox',
                },
                {
                    values: { dashboardBrowser: 'notification' },
                    expectedPresentation: 'notification',
                },
                {
                    values: { dashboardBrowser: 'none' },
                    expectedPresentation: 'integratedBrowser',
                },
                {
                    values: {
                        dashboardBrowser: 'openExternalBrowser',
                        enableAspireDashboardAutoLaunch: 'off',
                    },
                    expectedPresentation: 'externalBrowser',
                },
                {
                    values: {
                        dashboardBrowser: 'none',
                        enableAspireDashboardAutoLaunch: 'notification',
                    },
                    expectedPresentation: 'notification',
                },
            ];

            for (const testCase of cases) {
                const sandbox = sinon.createSandbox();
                try {
                    sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration(testCase.values));
                    const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
                    const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                    const startDebugging = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
                    const showInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
                    uiRepository.appHosts = [
                        createRunningAppHost(appHostProjectPath, 'https://dashboard.example.invalid/login?t=private'),
                    ];

                    const result = await service.openDashboard(
                        { appHostPath: 'AppHost/AppHost.csproj' },
                        new vscode.CancellationTokenSource().token);

                    assert.deepStrictEqual(result, {
                        success: true,
                        tool: aspireOpenDashboardToolName,
                        outcome: 'opened',
                        presentation: testCase.expectedPresentation,
                    });
                    if (testCase.expectedPresentation === 'integratedBrowser') {
                        assert.strictEqual(executeCommand.calledWith('simpleBrowser.show'), true);
                    }
                    if (testCase.expectedPresentation === 'externalBrowser') {
                        assert.strictEqual(openExternal.callCount, 1);
                    }
                    if (testCase.expectedPresentation === 'debugBrowser') {
                        assert.strictEqual(startDebugging.callCount, 1);
                        assert.strictEqual(
                            (startDebugging.firstCall.args[1] as vscode.DebugConfiguration).type,
                            testCase.expectedDebugType);
                    }
                    if (testCase.expectedPresentation === 'notification') {
                        assert.strictEqual(showInformationMessage.callCount, 1);
                    }
                }
                finally {
                    sandbox.restore();
                }
            }
        });

        test('reuses the exact editor-owned Dashboard launcher and reports external debug fallback', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const ownedOpenDashboard = sandbox.stub().resolves('debugBrowser');
                dashboardSessionsByIdentity.set(
                    resolver.getIdentityForAppHostPath(appHostProjectPath),
                    [{
                        cliProcessId: 2001,
                        configuration: { dashboardBrowser: 'debugEdge' },
                        isShuttingDown: false,
                        openDashboard: ownedOpenDashboard,
                    }]);
                uiRepository.appHosts = [{
                    ...createRunningAppHost(
                        appHostProjectPath,
                        'https://dashboard.example.invalid/login?t=private'),
                    cliPid: 2001,
                }];

                const ownedResult = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);
                assert.deepStrictEqual(ownedResult, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'debugBrowser',
                });
                assert.strictEqual(ownedOpenDashboard.callCount, 1);
                assert.strictEqual(ownedOpenDashboard.firstCall.args[1], 'debugEdge');

                dashboardSessionsByIdentity.clear();
                sandbox.stub(vscode.debug, 'startDebugging').resolves(false);
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                (vscode.workspace.getConfiguration as sinon.SinonStub).returns(createAspireConfiguration({
                    dashboardBrowser: 'debugChrome',
                }));

                const fallback = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);
                assert.deepStrictEqual(fallback, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'externalBrowser',
                });
                assert.strictEqual(openExternal.callCount, 1);
            }
            finally {
                sandbox.restore();
            }
        });

        test('reports an error instead of presenting Dashboard UI for a shutting editor session', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const matchingCliPid = 2001;
                const parentDebugSession = {
                    id: 'aspire-session',
                    type: 'aspire',
                    name: 'Aspire',
                    configuration: {
                        type: 'aspire',
                        request: 'launch',
                        name: 'Aspire',
                        program: appHostProjectPath,
                        command: 'run',
                    },
                } as unknown as vscode.DebugSession;
                const resourceStop = sandbox.stub().rejects(new Error('Resource stop failed'));
                sandbox.stub(vscode.debug, 'stopDebugging').resolves();
                const onDidStartDebugSession = sandbox.stub(vscode.debug, 'onDidStartDebugSession').returns({
                    dispose: sandbox.stub(),
                });
                const startDebugging = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
                const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const showInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
                const aspireDebugSession = new AspireDebugSession(
                    parentDebugSession,
                    {} as any,
                    {} as any,
                    {} as any,
                    () => { });
                (aspireDebugSession as any)._cliProcess = { pid: matchingCliPid };
                (aspireDebugSession as any)._resourceDebugSessions = [{
                    id: 'resource-session',
                    session: { id: 'resource-session', name: 'Resource' } as unknown as vscode.DebugSession,
                    stopSession: resourceStop,
                }];
                dashboardSessionsByIdentity.set(
                    resolver.getIdentityForAppHostPath(appHostProjectPath),
                    [aspireDebugSession]);
                uiRepository.appHosts = [{
                    ...createRunningAppHost(
                        appHostProjectPath,
                        'https://dashboard.example.invalid/login?t=private'),
                    cliPid: matchingCliPid,
                }];

                await assert.rejects(() => aspireDebugSession.stopDebugging(), /Resource stop failed/);

                const results = [];
                for (const browserType of [
                    'integratedBrowser',
                    'openExternalBrowser',
                    'debugEdge',
                    'notification',
                ] as const) {
                    aspireDebugSession.configuration.dashboardBrowser = browserType;
                    results.push(await service.openDashboard(
                        { appHostPath: 'AppHost/AppHost.csproj' },
                        new vscode.CancellationTokenSource().token));
                }

                assert.deepStrictEqual(results, Array.from({ length: 4 }, () => ({
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'error',
                })));
                sinon.assert.notCalled(executeCommand);
                sinon.assert.notCalled(openExternal);
                sinon.assert.notCalled(onDidStartDebugSession);
                sinon.assert.notCalled(startDebugging);
                sinon.assert.notCalled(showInformationMessage);

                resourceStop.resetBehavior();
                resourceStop.resolves();
                await aspireDebugSession.stopDebugging();
                sinon.assert.calledTwice(resourceStop);
            }
            finally {
                sandbox.restore();
            }
        });

        test('uses ownerless Dashboard configuration when fresh CLI ownership is unproven', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const ownedOpenDashboard = sandbox.stub().resolves('debugBrowser');
                dashboardSessionsByIdentity.set(
                    resolver.getIdentityForAppHostPath(appHostProjectPath),
                    [{
                        cliProcessId: 1001,
                        configuration: { dashboardBrowser: 'debugEdge' },
                        isShuttingDown: false,
                        openDashboard: ownedOpenDashboard,
                    } as EditorUiHandoffDebugSession]);

                for (const cliPid of [null, 2002]) {
                    uiRepository.appHosts = [{
                        ...createRunningAppHost(
                            appHostProjectPath,
                            'https://dashboard.example.invalid/login?t=private'),
                        cliPid,
                    }];

                    const result = await service.openDashboard(
                        { appHostPath: 'AppHost/AppHost.csproj' },
                        new vscode.CancellationTokenSource().token);

                    assert.deepStrictEqual(result, {
                        success: true,
                        tool: aspireOpenDashboardToolName,
                        outcome: 'opened',
                        presentation: 'externalBrowser',
                    });
                }

                assert.strictEqual(openExternal.callCount, 2);
                assert.strictEqual(ownedOpenDashboard.callCount, 0);
            }
            finally {
                sandbox.restore();
            }
        });

        test('uses only the editor Dashboard session whose CLI process owns the fresh row', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const matchingCliPid = 2002;
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const staleOpenDashboard = sandbox.stub().resolves('integratedBrowser');
                const ownedOpenDashboard = sandbox.stub().resolves('debugBrowser');
                dashboardSessionsByIdentity.set(
                    resolver.getIdentityForAppHostPath(appHostProjectPath),
                    [{
                        cliProcessId: 1001,
                        configuration: { dashboardBrowser: 'integratedBrowser' },
                        isShuttingDown: false,
                        openDashboard: staleOpenDashboard,
                    }, {
                        cliProcessId: matchingCliPid,
                        configuration: { dashboardBrowser: 'debugEdge' },
                        isShuttingDown: false,
                        openDashboard: ownedOpenDashboard,
                    }] as unknown as readonly EditorUiHandoffDebugSession[]);
                uiRepository.appHosts = [{
                    ...createRunningAppHost(
                        appHostProjectPath,
                        'https://dashboard.example.invalid/login?t=private'),
                    cliPid: matchingCliPid,
                }];

                const result = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(result, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'debugBrowser',
                });
                assert.strictEqual(staleOpenDashboard.callCount, 0);
                assert.strictEqual(ownedOpenDashboard.callCount, 1);
                assert.strictEqual(ownedOpenDashboard.firstCall.args[1], 'debugEdge');
                assert.strictEqual(openExternal.callCount, 0);
                assert.strictEqual(JSON.stringify(result).includes(String(matchingCliPid)), false);
            }
            finally {
                sandbox.restore();
            }
        });

        test('returns after presenting a Dashboard notification without waiting for selection', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'notification',
                }));
                const showInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage')
                    .returns(new Promise<vscode.MessageItem | undefined>(() => { }));
                uiRepository.appHosts = [
                    createRunningAppHost(appHostProjectPath, 'https://dashboard.example.invalid/login?t=private'),
                ];

                const result = await Promise.race([
                    service.openDashboard(
                        { appHostPath: 'AppHost/AppHost.csproj' },
                        new vscode.CancellationTokenSource().token),
                    new Promise<'timedOut'>(resolve => setTimeout(() => resolve('timedOut'), 100)),
                ]);

                assert.deepStrictEqual(result, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'notification',
                });
                assert.strictEqual(showInformationMessage.callCount, 1);
            }
            finally {
                sandbox.restore();
            }
        });

        test('keeps notification selection failures URL-free after presentation', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const secretUrl = 'https://dashboard.example.invalid/login?t=secret';
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'notification',
                }));
                sandbox.stub(vscode.window, 'showInformationMessage')
                    .rejects(new Error(`Selection failed for ${secretUrl}`));
                const errorLog = sandbox.stub(extensionLogOutputChannel, 'error');
                uiRepository.appHosts = [createRunningAppHost(appHostProjectPath, secretUrl)];

                const result = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);
                await new Promise(resolve => setTimeout(resolve, 0));

                assert.deepStrictEqual(result, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'notification',
                });
                sinon.assert.calledOnceWithExactly(
                    errorLog,
                    'Failed to handle the Aspire Dashboard notification.');
                assert.strictEqual(JSON.stringify(errorLog.getCalls()).includes(secretUrl), false);
            }
            finally {
                sandbox.restore();
            }
        });

        test('reports notification after display even when its optional link cannot open', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const secretUrl = 'https://dashboard.example.invalid/login?t=secret';
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'notification',
                }));
                sandbox.stub(vscode.window, 'showInformationMessage').resolves({ title: directLink });
                sandbox.stub(vscode.env, 'openExternal').rejects(new Error(`Could not open ${secretUrl}`));
                const errorLog = sandbox.stub(extensionLogOutputChannel, 'error');
                uiRepository.appHosts = [createRunningAppHost(appHostProjectPath, secretUrl)];

                const result = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);
                await Promise.resolve();

                assert.deepStrictEqual(result, {
                    success: true,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'opened',
                    presentation: 'notification',
                });
                assert.strictEqual(JSON.stringify(errorLog.getCalls()).includes(secretUrl), false);
            }
            finally {
                sandbox.restore();
            }
        });

        test('focuses Aspire Output exactly once without reading or appending content', async () => {
            const unexpectedProperties: PropertyKey[] = [];
            const output = new Proxy({
                showCalls: [] as Array<boolean | undefined>,
                show(preserveFocus?: boolean) {
                    this.showCalls.push(preserveFocus);
                },
            }, {
                get(target, property, receiver) {
                    if (property !== 'show' && property !== 'showCalls') {
                        unexpectedProperties.push(property);
                        throw new Error(`Unexpected Output access: ${String(property)}`);
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            const localUiService = new EditorUiHandoffService({
                targetResolver: resolver,
                appHostRepository: uiRepository,
                output,
                getAspireDebugSessions: () => [],
            });
            const localService = new EditorAssistanceToolService({
                targetResolver: resolver,
                snapshotService,
                resourceRepository,
                getEditorResourceSessions: () => resourceSessions,
                readLatestLaunchFailures: () => [],
                uiHandoffService: localUiService,
            });

            const result = await localService.openOutput({}, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(result, {
                success: true,
                tool: aspireOpenOutputToolName,
                outcome: 'opened',
            });
            assert.deepStrictEqual(output.showCalls, [true]);
            assert.deepStrictEqual(unexpectedProperties, []);
        });

        test('sanitizes handoff errors and keeps Dashboard URLs out of diagnostics', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const secretUrl = 'https://dashboard.example.invalid/login?t=secret';
                const errorLog = sandbox.stub(extensionLogOutputChannel, 'error');
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                sandbox.stub(vscode.env, 'openExternal').rejects(new Error(`Could not open ${secretUrl}`));
                uiRepository.appHosts = [createRunningAppHost(appHostProjectPath, secretUrl)];

                const dashboardResult = await service.openDashboard(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);
                editorOutput.error = new Error('raw output failure');
                const outputResult = await service.openOutput(
                    {},
                    new vscode.CancellationTokenSource().token);
                discoveryService.discoverError = new Error('raw snapshot failure');
                const listResult = await service.listDebugSessions(
                    {},
                    new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(dashboardResult, {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'error',
                });
                assert.deepStrictEqual(outputResult, {
                    success: false,
                    tool: aspireOpenOutputToolName,
                    outcome: 'error',
                });
                assert.deepStrictEqual(listResult, {
                    success: false,
                    tool: aspireListDebugSessionsToolName,
                    outcome: 'error',
                    sessions: [],
                });
                const serializedLogs = JSON.stringify(errorLog.getCalls().map(call => call.args));
                assert.strictEqual(serializedLogs.includes(secretUrl), false);
                assert.strictEqual(serializedLogs.includes('raw output failure'), false);
                assert.strictEqual(serializedLogs.includes('raw snapshot failure'), false);
            }
            finally {
                sandbox.restore();
            }
        });

        test('lists only active editor-owned AppHosts in sorted sanitized summaries', async () => {
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            const paths = {
                notDebugging: path.join(workspaceRoot, 'ZNotDebugging', 'AppHost.csproj'),
                running: path.join(workspaceRoot, 'BRunning', 'AppHost.csproj'),
                starting: path.join(workspaceRoot, 'AStarting', 'AppHost.csproj'),
                stopping: path.join(workspaceRoot, 'CStopping', 'AppHost.csproj'),
                multiple: path.join(workspaceRoot, 'DMultiple', 'AppHost.csproj'),
            };
            for (const candidatePath of Object.values(paths)) {
                fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
                fs.writeFileSync(candidatePath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, candidatePath);
            }

            launchService.pendingOrActiveRunLaunchPaths.add(path.resolve(paths.starting));
            launchService.editorSessions.push(
                {
                    appHostPath: paths.running,
                    resolvedAppHostPath: paths.running,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                },
                {
                    appHostPath: paths.stopping,
                    resolvedAppHostPath: paths.stopping,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: true,
                    isStopping: true,
                },
                {
                    appHostPath: paths.multiple,
                    resolvedAppHostPath: paths.multiple,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                },
                {
                    appHostPath: paths.multiple,
                    resolvedAppHostPath: paths.multiple,
                    operationKind: 'run',
                    startupCompleted: false,
                    noDebug: true,
                    isStopping: false,
                });

            const result = await service.listDebugSessions({}, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(result, {
                success: true,
                tool: aspireListDebugSessionsToolName,
                outcome: 'sessionsFound',
                sessions: [
                    {
                        appHost: 'AStarting/AppHost.csproj',
                        state: 'starting',
                        mode: 'other',
                        controller: 'editor',
                    },
                    {
                        appHost: 'BRunning/AppHost.csproj',
                        state: 'running',
                        mode: 'debug',
                        controller: 'editor',
                    },
                    {
                        appHost: 'CStopping/AppHost.csproj',
                        state: 'stopping',
                        mode: 'run',
                        controller: 'editor',
                    },
                    {
                        appHost: 'DMultiple/AppHost.csproj',
                        state: 'multipleSessions',
                        mode: 'other',
                        controller: 'editor',
                    },
                ],
            });
            assert.deepStrictEqual(Object.keys(result), ['success', 'tool', 'outcome', 'sessions']);
            assert.strictEqual(JSON.stringify(result).includes(workspaceRoot), false);
        });

        test('returns noSessions and bounds active session summaries with only a truncated flag', async () => {
            assert.deepStrictEqual(
                await service.listDebugSessions({}, new vscode.CancellationTokenSource().token),
                {
                    success: true,
                    tool: aspireListDebugSessionsToolName,
                    outcome: 'noSessions',
                    sessions: [],
                });

            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            for (let index = 20; index >= 0; index--) {
                const candidatePath = path.join(
                    workspaceRoot,
                    `Project${index.toString().padStart(2, '0')}`,
                    'AppHost.csproj');
                fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
                fs.writeFileSync(candidatePath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, candidatePath);
                launchService.editorSessions.push({
                    appHostPath: candidatePath,
                    resolvedAppHostPath: candidatePath,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                });
            }

            const result = await service.listDebugSessions({}, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'sessionsFound');
            assert.strictEqual(result.sessions.length, 20);
            assert.deepStrictEqual(
                result.sessions.map(session => session.appHost),
                Array.from({ length: 20 }, (_, index) =>
                    `Project${index.toString().padStart(2, '0')}/AppHost.csproj`));
            assert.strictEqual(result.truncated, true);
            assert.deepStrictEqual(
                Object.keys(result),
                ['success', 'tool', 'outcome', 'sessions', 'truncated']);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'total'), false);
        });

        test('registers five adapters with confirmation only for Dashboard and Output', async () => {
            const disposed: string[] = [];
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').callsFake((name: string) =>
                new vscode.Disposable(() => disposed.push(name)));
            try {
                const registration = registerEditorAssistanceTools(service);
                assert.strictEqual(registration.registered, true);
                assert.deepStrictEqual(
                    registerToolStub.getCalls().map(call => call.args[0]),
                    [
                        aspireDebugSessionStatusToolName,
                        aspireExplainLaunchFailureToolName,
                        aspireOpenDashboardToolName,
                        aspireOpenOutputToolName,
                        aspireListDebugSessionsToolName,
                    ]);
                assert.deepStrictEqual([...registration.tools.keys()], [
                    aspireDebugSessionStatusToolName,
                    aspireExplainLaunchFailureToolName,
                    aspireOpenDashboardToolName,
                    aspireOpenOutputToolName,
                    aspireListDebugSessionsToolName,
                ]);

                const statusTool = registration.tools.get(aspireDebugSessionStatusToolName);
                const explainTool = registration.tools.get(aspireExplainLaunchFailureToolName);
                const dashboardTool = registration.tools.get(aspireOpenDashboardToolName);
                const outputTool = registration.tools.get(aspireOpenOutputToolName);
                const listTool = registration.tools.get(aspireListDebugSessionsToolName);
                assert.ok(statusTool instanceof AspireDebugSessionStatusLanguageModelTool);
                assert.ok(explainTool instanceof AspireExplainLaunchFailureLanguageModelTool);
                assert.ok(dashboardTool instanceof AspireOpenDashboardLanguageModelTool);
                assert.ok(outputTool instanceof AspireOpenOutputLanguageModelTool);
                assert.ok(listTool instanceof AspireListDebugSessionsLanguageModelTool);
                assert.strictEqual((statusTool as any).prepareInvocation, undefined);
                assert.strictEqual((explainTool as any).prepareInvocation, undefined);
                assert.strictEqual(typeof (dashboardTool as any).prepareInvocation, 'function');
                assert.strictEqual(typeof (outputTool as any).prepareInvocation, 'function');
                assert.strictEqual((listTool as any).prepareInvocation, undefined);

                const payload = readEditorAssistanceToolResult(await statusTool.invoke(
                    { input: { appHostPath: 'AppHost/AppHost.csproj' }, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));
                assert.deepStrictEqual(payload, {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'notDebugging',
                    scope: 'appHost',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                });
                const explanation = readEditorAssistanceToolResult(await explainTool.invoke(
                    { input: { appHostPath: 'AppHost/AppHost.csproj' }, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));
                assert.deepStrictEqual(explanation, {
                    success: true,
                    tool: aspireExplainLaunchFailureToolName,
                    outcome: 'noRecordedFailure',
                    appHost: 'AppHost/AppHost.csproj',
                });

                registration.dispose();
                assert.deepStrictEqual(disposed, [
                    aspireDebugSessionStatusToolName,
                    aspireExplainLaunchFailureToolName,
                    aspireOpenDashboardToolName,
                    aspireOpenOutputToolName,
                    aspireListDebugSessionsToolName,
                ]);
            }
            finally {
                registerToolStub.restore();
            }
        });

        test('feature-detects the stable language model tool API', () => {
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').value(undefined);
            try {
                const registration = registerEditorAssistanceTools(service);
                assert.strictEqual(registration.registered, false);
                assert.deepStrictEqual([...registration.tools.keys()], [
                    aspireDebugSessionStatusToolName,
                    aspireExplainLaunchFailureToolName,
                    aspireOpenDashboardToolName,
                    aspireOpenOutputToolName,
                    aspireListDebugSessionsToolName,
                ]);
                registration.dispose();
            }
            finally {
                registerToolStub.restore();
            }
        });
    });

    teardown(() => {
        __resetLaunchFailureJournalForTests();
        __resetAppHostIdentityRegistryForTests();
        workspaceFoldersStub.restore();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    });

    suite('SafeAppHostTargetResolver', () => {
        test('rejects non-string, blank, and overly long selectors without consulting discovery', async () => {
            const token = new vscode.CancellationTokenSource().token;
            const inputs = [undefined, '   ', 'a'.repeat(4097)] as const;

            for (const input of inputs) {
                const resolution = await resolver.resolveTarget(input, token);
                assert.deepStrictEqual(resolution, { resolved: false, outcome: 'invalidInput' });
            }

            assert.strictEqual(discoveryService.discoverCalls, 0);
        });

        test('rejects absolute selectors as invalidInput', async () => {
            const resolution = await resolver.resolveTarget(appHostProjectPath, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(resolution, { resolved: false, outcome: 'invalidInput' });
            assert.strictEqual(discoveryService.discoverCalls, 0);
        });

        test('requires workspace-folder qualification in a multi-root workspace even when only one root currently matches', async () => {
            const secondRoot = createFixtureDirectory('second-workspace');
            try {
                const secondAppHost = path.join(secondRoot, 'Other', 'AppHost.csproj');
                fs.mkdirSync(path.dirname(secondAppHost), { recursive: true });
                fs.writeFileSync(secondAppHost, appHostProjectContents);
                addCandidate(discoveryService, secondRoot, secondAppHost);
                workspaceFoldersStub.value([
                    createWorkspaceFolder(workspaceRoot, 'workspace', 0),
                    createWorkspaceFolder(secondRoot, 'second', 1),
                ]);

                const resolution = await resolver.resolveTarget('Other/AppHost.csproj', new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(resolution, {
                    resolved: false,
                    outcome: 'ambiguousAppHost',
                    knownAppHosts: ['second/Other/AppHost.csproj'],
                });
            }
            finally {
                fs.rmSync(secondRoot, { recursive: true, force: true });
            }
        });

        test('resolves a workspace-folder-qualified selector with safe display paths', async () => {
            const secondRoot = createFixtureDirectory('second-workspace');
            try {
                const secondAppHost = path.join(secondRoot, 'Nested', 'AppHost.csproj');
                fs.mkdirSync(path.dirname(secondAppHost), { recursive: true });
                fs.writeFileSync(secondAppHost, appHostProjectContents);
                addCandidate(discoveryService, secondRoot, secondAppHost);
                workspaceFoldersStub.value([
                    createWorkspaceFolder(workspaceRoot, 'workspace', 0),
                    createWorkspaceFolder(secondRoot, 'second', 1),
                ]);

                const resolution = await resolver.resolveTarget('second/Nested/AppHost.csproj', new vscode.CancellationTokenSource().token);

                assertResolved(resolution);
                assert.strictEqual(resolution.target.absolutePath, secondAppHost);
                assert.strictEqual(resolution.target.relativePath, 'Nested/AppHost.csproj');
                assert.strictEqual(resolution.target.displayPath, 'second/Nested/AppHost.csproj');
            }
            finally {
                fs.rmSync(secondRoot, { recursive: true, force: true });
            }
        });

        test('resolves duplicate workspace folder names with deterministic qualifiers', async () => {
            const secondRoot = createFixtureDirectory('second-workspace');
            try {
                const secondAppHost = path.join(secondRoot, 'AppHost', 'AppHost.csproj');
                fs.mkdirSync(path.dirname(secondAppHost), { recursive: true });
                fs.writeFileSync(secondAppHost, appHostProjectContents);
                addCandidate(discoveryService, secondRoot, secondAppHost);
                workspaceFoldersStub.value([
                    createWorkspaceFolder(workspaceRoot, 'workspace', 0),
                    createWorkspaceFolder(secondRoot, 'workspace', 1),
                ]);

                const firstResolution = await resolver.resolveTarget('workspace (1)/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);
                const secondResolution = await resolver.resolveTarget('workspace (2)/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);

                assertResolved(firstResolution);
                assertResolved(secondResolution);
                assert.strictEqual(firstResolution.target.absolutePath, appHostProjectPath);
                assert.strictEqual(firstResolution.target.displayPath, 'workspace (1)/AppHost/AppHost.csproj');
                assert.strictEqual(secondResolution.target.absolutePath, secondAppHost);
                assert.strictEqual(secondResolution.target.displayPath, 'workspace (2)/AppHost/AppHost.csproj');
            }
            finally {
                fs.rmSync(secondRoot, { recursive: true, force: true });
            }
        });

        test('uses selector comparison keys to disambiguate case-insensitive workspace folder names', async () => {
            const secondRoot = createFixtureDirectory('second-workspace');
            try {
                const secondAppHost = path.join(secondRoot, 'AppHost', 'AppHost.csproj');
                fs.mkdirSync(path.dirname(secondAppHost), { recursive: true });
                fs.writeFileSync(secondAppHost, appHostProjectContents);
                addCandidate(discoveryService, secondRoot, secondAppHost);
                workspaceFoldersStub.value([
                    createWorkspaceFolder(workspaceRoot, 'Foo', 0),
                    createWorkspaceFolder(secondRoot, 'foo', 1),
                ]);
                const windowsSelectorKey = (value: string) =>
                    value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
                const caseInsensitiveResolver = new SafeAppHostTargetResolver(discoveryService, windowsSelectorKey);

                const knownTargets = await caseInsensitiveResolver.enumerateKnownAppHosts(new vscode.CancellationTokenSource().token);
                const firstResolution = await caseInsensitiveResolver.resolveTarget('foo (1)/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);
                const secondResolution = await caseInsensitiveResolver.resolveTarget('FOO (2)/AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(knownTargets.map(target => target.displayPath), [
                    'Foo (1)/AppHost/AppHost.csproj',
                    'foo (2)/AppHost/AppHost.csproj',
                ]);
                assertResolved(firstResolution);
                assertResolved(secondResolution);
                assert.strictEqual(firstResolution.target.absolutePath, appHostProjectPath);
                assert.strictEqual(secondResolution.target.absolutePath, secondAppHost);
            }
            finally {
                fs.rmSync(secondRoot, { recursive: true, force: true });
            }
        });

        test('reports canceled when discovery is canceled', async () => {
            discoveryService.discoverError = new vscode.CancellationError();

            const resolution = await resolver.resolveTarget('AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(resolution, { resolved: false, outcome: 'canceled' });
        });

        test('reports error when discovery fails', async () => {
            discoveryService.discoverError = new Error('aspire ls failed');

            const resolution = await resolver.resolveTarget('AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(resolution, { resolved: false, outcome: 'error' });
        });

        test('omits candidates that are outside every workspace folder', async () => {
            const outsideAppHost = path.join(outsideRoot, 'External', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(outsideAppHost), { recursive: true });
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, outsideAppHost);

            const knownTargets = await resolver.enumerateKnownAppHosts(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(knownTargets.map(target => target.displayPath), ['AppHost/AppHost.csproj']);
        });

        test('drops candidates whose real target escapes the workspace', async function () {
            const outsideAppHost = path.join(outsideRoot, 'External.csproj');
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            const linkedAppHost = path.join(workspaceRoot, 'AppHost', 'Linked.csproj');
            try {
                fs.symlinkSync(outsideAppHost, linkedAppHost);
            }
            catch {
                this.skip();
                return;
            }

            addCandidate(discoveryService, workspaceRoot, linkedAppHost);
            const knownTargets = await resolver.enumerateKnownAppHosts(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(knownTargets.map(target => target.displayPath), ['AppHost/AppHost.csproj']);
        });

        test('drops registry entries whose identity cannot be rendered faithfully', async () => {
            const invisibleAppHost = path.join(workspaceRoot, 'AppHost', 'App\u200bHost.csproj');
            fs.writeFileSync(invisibleAppHost, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, invisibleAppHost);

            const resolution = await resolver.resolveTarget('AppHost/App\u200bHost.csproj', new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(resolution, {
                resolved: false,
                outcome: 'appHostNotFound',
                knownAppHosts: ['AppHost/AppHost.csproj'],
            });
        });

        test('keeps lexical symlink aliases independently selectable', async function () {
            const linkedTarget = path.join(workspaceRoot, 'Linked', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(linkedTarget), { recursive: true });
            try {
                fs.symlinkSync(appHostProjectPath, linkedTarget);
            }
            catch {
                this.skip();
                return;
            }

            addCandidate(discoveryService, workspaceRoot, linkedTarget);

            const realResolution = await resolver.resolveTarget('AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);
            const linkedResolution = await resolver.resolveTarget('Linked/AppHost.csproj', new vscode.CancellationTokenSource().token);

            assertResolved(realResolution);
            assertResolved(linkedResolution);
            assert.strictEqual(realResolution.target.absolutePath, appHostProjectPath);
            assert.strictEqual(linkedResolution.target.absolutePath, linkedTarget);
        });

        test('keeps lexical identities stable when a symlink retargets', async function () {
            const firstRealTarget = path.join(workspaceRoot, 'First', 'AppHost.csproj');
            const secondRealTarget = path.join(workspaceRoot, 'Second', 'AppHost.csproj');
            const linkedTarget = path.join(workspaceRoot, 'Linked', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(firstRealTarget), { recursive: true });
            fs.mkdirSync(path.dirname(secondRealTarget), { recursive: true });
            fs.mkdirSync(path.dirname(linkedTarget), { recursive: true });
            fs.writeFileSync(firstRealTarget, appHostProjectContents);
            fs.writeFileSync(secondRealTarget, appHostProjectContents);
            try {
                fs.symlinkSync(firstRealTarget, linkedTarget);
            }
            catch {
                this.skip();
                return;
            }

            addCandidate(discoveryService, workspaceRoot, linkedTarget);
            const firstResolution = await resolver.resolveTarget('Linked/AppHost.csproj', new vscode.CancellationTokenSource().token);
            const secondResolution = await resolver.resolveTarget('Linked/AppHost.csproj', new vscode.CancellationTokenSource().token);
            assertResolved(firstResolution);
            assertResolved(secondResolution);
            assert.strictEqual(firstResolution.target.identity, secondResolution.target.identity);

            fs.rmSync(linkedTarget, { force: true });
            fs.symlinkSync(secondRealTarget, linkedTarget);
            const thirdResolution = await resolver.resolveTarget('Linked/AppHost.csproj', new vscode.CancellationTokenSource().token);
            assertResolved(thirdResolution);
            assert.strictEqual(firstResolution.target.identity, thirdResolution.target.identity);
        });

        test('bounds known AppHosts on not-found results', async () => {
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            for (let index = 0; index < 40; index++) {
                const candidatePath = path.join(workspaceRoot, `Project${index.toString().padStart(2, '0')}`, 'AppHost.csproj');
                fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
                fs.writeFileSync(candidatePath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, candidatePath);
            }

            const resolution = await resolver.resolveTarget('Missing/AppHost.csproj', new vscode.CancellationTokenSource().token);

            assert.strictEqual(resolution.resolved, false);
            if (resolution.resolved) {
                assert.fail('Expected a missing AppHost resolution.');
            }

            assert.strictEqual(resolution.outcome, 'appHostNotFound');
            assert.strictEqual(resolution.knownAppHosts?.length, 32);
            assert.strictEqual(JSON.stringify(resolution).includes(workspaceRoot), false);
        });
    });

    suite('EditorStateSnapshotService', () => {
        test('reports notDebugging when a known AppHost has no active editor session', async () => {
            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot, {
                appHosts: [{
                    appHost: 'AppHost/AppHost.csproj',
                    state: 'notDebugging',
                    mode: 'other',
                    controller: 'editor',
                }],
            });
        });

        test('reports starting while a run launch is pending before a session exists', async () => {
            launchService.launchingPaths.add(path.resolve(appHostProjectPath));
            launchService.pendingOrActiveRunLaunchPaths.add(path.resolve(appHostProjectPath));

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'starting',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('does not report starting from a non-run launch reservation', async () => {
            launchService.launchingPaths.add(path.resolve(appHostProjectPath));

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'notDebugging',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('reports a running debug session from the editor', async () => {
            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'running',
                mode: 'debug',
                controller: 'editor',
            }]);
        });

        test('reports a starting run session before startup completes', async () => {
            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: false,
                noDebug: true,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'starting',
                mode: 'run',
                controller: 'editor',
            }]);
        });

        test('uses other mode for a run session with malformed debug configuration', async () => {
            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: undefined,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'running',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('ignores non-run editor sessions', async () => {
            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'publish',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'notDebugging',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('reports stopping when the matching editor session is shutting down', async () => {
            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: true,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'stopping',
                mode: 'debug',
                controller: 'editor',
            }]);
        });

        test('reports multipleSessions when more than one run session maps to the same AppHost', async () => {
            launchService.editorSessions.push(
                {
                    appHostPath: appHostProjectPath,
                    resolvedAppHostPath: appHostProjectPath,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                },
                {
                    appHostPath: appHostProjectPath,
                    resolvedAppHostPath: appHostProjectPath,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'multipleSessions',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('omits editor sessions that cannot be resolved back to a known AppHost', async () => {
            const externalSessionPath = path.join(outsideRoot, 'External', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(externalSessionPath), { recursive: true });
            fs.writeFileSync(externalSessionPath, appHostProjectContents);
            launchService.editorSessions.push({
                appHostPath: externalSessionPath,
                resolvedAppHostPath: externalSessionPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'notDebugging',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('does not attribute an ambiguous run session to a known AppHost', async () => {
            const ambiguousDirectory = path.join(workspaceRoot, 'Ambiguous');
            const firstProject = path.join(ambiguousDirectory, 'First.csproj');
            const secondProject = path.join(ambiguousDirectory, 'Second.csproj');
            const appHostSource = path.join(ambiguousDirectory, 'Program.cs');
            fs.mkdirSync(ambiguousDirectory, { recursive: true });
            fs.writeFileSync(firstProject, appHostProjectContents);
            fs.writeFileSync(secondProject, appHostProjectContents);
            fs.writeFileSync(appHostSource, 'var builder = DistributedApplication.CreateBuilder(args);');
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            addCandidate(discoveryService, workspaceRoot, appHostSource);
            launchService.editorSessions.push({
                appHostPath: firstProject,
                resolvedAppHostPath: undefined,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'Ambiguous/Program.cs',
                state: 'notDebugging',
                mode: 'other',
                controller: 'editor',
            }]);
        });

        test('keeps an active session attributed to its lexical launch path after a symlink retargets', async function () {
            const firstTarget = path.join(workspaceRoot, 'First', 'AppHost.csproj');
            const secondTarget = path.join(workspaceRoot, 'Second', 'AppHost.csproj');
            const linkedTarget = path.join(workspaceRoot, 'ZLinked', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(firstTarget), { recursive: true });
            fs.mkdirSync(path.dirname(secondTarget), { recursive: true });
            fs.mkdirSync(path.dirname(linkedTarget), { recursive: true });
            fs.writeFileSync(firstTarget, appHostProjectContents);
            fs.writeFileSync(secondTarget, appHostProjectContents);
            try {
                fs.symlinkSync(firstTarget, linkedTarget);
            }
            catch {
                this.skip();
                return;
            }

            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            addCandidate(discoveryService, workspaceRoot, firstTarget);
            addCandidate(discoveryService, workspaceRoot, secondTarget);
            addCandidate(discoveryService, workspaceRoot, linkedTarget);
            launchService.editorSessions.push({
                appHostPath: linkedTarget,
                resolvedAppHostPath: linkedTarget,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            fs.rmSync(linkedTarget);
            fs.symlinkSync(secondTarget, linkedTarget);

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [
                {
                    appHost: 'First/AppHost.csproj',
                    state: 'notDebugging',
                    mode: 'other',
                    controller: 'editor',
                },
                {
                    appHost: 'Second/AppHost.csproj',
                    state: 'notDebugging',
                    mode: 'other',
                    controller: 'editor',
                },
                {
                    appHost: 'ZLinked/AppHost.csproj',
                    state: 'running',
                    mode: 'debug',
                    controller: 'editor',
                },
            ]);
        });

        test('returns at most 20 AppHosts sorted by safe display path', async () => {
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            for (let index = 20; index >= 0; index--) {
                const candidatePath = path.join(workspaceRoot, `Project${index.toString().padStart(2, '0')}`, 'AppHost.csproj');
                fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
                fs.writeFileSync(candidatePath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, candidatePath);
            }

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);
            const appHosts = snapshot.appHosts.map(summary => summary.appHost);

            assert.strictEqual(appHosts.length, 20);
            assert.deepStrictEqual(appHosts, Array.from({ length: 20 }, (_, index) => `Project${index.toString().padStart(2, '0')}/AppHost.csproj`));
        });

        test('gets the exact requested AppHost summary beyond the bounded list snapshot', async () => {
            discoveryService.candidatesByFolder.set(workspaceRoot, []);
            for (let index = 0; index < 20; index++) {
                const candidatePath = path.join(workspaceRoot, `Project${index.toString().padStart(2, '0')}`, 'AppHost.csproj');
                fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
                fs.writeFileSync(candidatePath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, candidatePath);
            }

            const exactAppHostPath = path.join(workspaceRoot, 'ZExact', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(exactAppHostPath), { recursive: true });
            fs.writeFileSync(exactAppHostPath, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, exactAppHostPath);
            launchService.editorSessions.push({
                appHostPath: exactAppHostPath,
                resolvedAppHostPath: exactAppHostPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const resolution = await resolver.resolveTarget('ZExact/AppHost.csproj', new vscode.CancellationTokenSource().token);
            assertResolved(resolution);

            const summary = await snapshotService.getAppHostSummary(resolution.target, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(summary, {
                appHost: 'ZExact/AppHost.csproj',
                state: 'running',
                mode: 'debug',
                controller: 'editor',
            });
        });

        test('returns summaries with only safe AppHost state fields', async () => {
            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
            });

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);
            const [summary] = snapshot.appHosts;

            assert.deepStrictEqual(Object.keys(snapshot), ['appHosts']);
            assert.deepStrictEqual(Object.keys(summary).sort(), ['appHost', 'controller', 'mode', 'state']);
            assert.strictEqual(JSON.stringify(snapshot).includes(workspaceRoot), false);
        });
    });

    suite('LaunchFailureJournal', () => {
        const createFailure = (overrides: Partial<LaunchFailureInput> = {}) => normalizeLaunchFailure({
            stage: 'debugSession',
            category: 'unknown',
            controller: 'editor',
            mode: 'debug',
            providerKind: 'dotnet',
            ...overrides,
        });

        test('uses the shared opaque AppHost identity registry', () => {
            const journalIdentity = getOrCreateIdentityForAbsolutePath(appHostProjectPath);
            const resolverIdentity = resolver.getIdentityForAppHostPath(appHostProjectPath);

            assert.strictEqual(journalIdentity, resolverIdentity);
            assert.strictEqual(journalIdentity.startsWith('apphost-'), true);
            assert.strictEqual(journalIdentity.includes(workspaceRoot), false);
        });

        test('keeps opaque identities stable as sibling path shapes appear and disappear', () => {
            const directoryPath = path.join(workspaceRoot, 'ChangingIdentity');
            const projectPath = path.join(directoryPath, 'ChangingIdentity.csproj');
            const sourcePath = path.join(directoryPath, 'Program.cs');
            fs.mkdirSync(directoryPath, { recursive: true });
            fs.writeFileSync(projectPath, '<Project />');

            const identity = getOrCreateIdentityForAbsolutePath(projectPath);

            fs.writeFileSync(sourcePath, 'var builder = DistributedApplication.CreateBuilder(args);');
            assert.strictEqual(getOrCreateIdentityForAbsolutePath(sourcePath), identity);

            fs.unlinkSync(projectPath);
            assert.strictEqual(getOrCreateIdentityForAbsolutePath(sourcePath), identity);

            fs.writeFileSync(projectPath, '<Project />');
            assert.strictEqual(getOrCreateIdentityForAbsolutePath(projectPath), identity);

            fs.unlinkSync(sourcePath);
            assert.strictEqual(getOrCreateIdentityForAbsolutePath(projectPath), identity);
        });

        test('preserves issued path histories when project-source uniqueness changes', () => {
            const directoryPath = path.join(workspaceRoot, 'Rebinding');
            const projectPath = path.join(directoryPath, 'AppHost.csproj');
            const secondProjectPath = path.join(directoryPath, 'Other.csproj');
            const sourcePath = path.join(directoryPath, 'Program.cs');
            fs.mkdirSync(directoryPath, { recursive: true });
            fs.writeFileSync(projectPath, '<Project />');
            fs.writeFileSync(secondProjectPath, '<Project />');
            fs.writeFileSync(sourcePath, 'var builder = DistributedApplication.CreateBuilder(args);');

            const projectIdentity = getOrCreateIdentityForAbsolutePath(projectPath);
            const sourceIdentity = getOrCreateIdentityForAbsolutePath(sourcePath);
            assert.notStrictEqual(projectIdentity, sourceIdentity);

            recordLaunchFailureForAppHostPath(projectPath, {
                stage: 'build',
                category: 'buildFailed',
                controller: 'editor',
            });
            recordLaunchFailureForAppHostPath(sourcePath, {
                stage: 'dcpStartup',
                category: 'processExited',
                controller: 'editor',
            });

            fs.unlinkSync(secondProjectPath);

            assert.deepStrictEqual(
                readLatestLaunchFailures(projectPath).map(record => record.stage),
                ['build']);
            assert.deepStrictEqual(
                readLatestLaunchFailures(sourcePath).map(record => record.stage),
                ['dcpStartup']);
            assert.strictEqual(getOrCreateIdentityForAbsolutePath(projectPath), projectIdentity);
            assert.strictEqual(getOrCreateIdentityForAbsolutePath(sourcePath), sourceIdentity);
        });

        test('keeps the latest five failures per AppHost in latest-first order', () => {
            let now = 1_000;
            const journal = new LaunchFailureJournal({ now: () => now });
            const identity = getOrCreateIdentityForAbsolutePath(appHostProjectPath);

            for (let index = 0; index < 6; index++) {
                journal.record(identity, createFailure());
                now++;
            }

            assert.deepStrictEqual(journal.readLatest(identity).map(record => record.sequence), [6, 5, 4, 3, 2]);
        });

        test('keeps the latest fifty failures globally', () => {
            const journal = new LaunchFailureJournal({ now: () => 1_000 });

            for (let index = 0; index < 51; index++) {
                const identity = getOrCreateIdentityForAbsolutePath(path.join(workspaceRoot, `AppHost${index}.csproj`));
                journal.record(identity, createFailure());
            }

            const records = journal.readLatest();
            assert.strictEqual(records.length, 50);
            assert.deepStrictEqual(records.map(record => record.sequence), Array.from({ length: 50 }, (_, index) => 51 - index));
        });

        test('prunes failures after the thirty minute window on reads', () => {
            let now = 1_000;
            const journal = new LaunchFailureJournal({ now: () => now });
            const identity = getOrCreateIdentityForAbsolutePath(appHostProjectPath);
            journal.record(identity, createFailure());

            now += 30 * 60 * 1_000;
            assert.deepStrictEqual(journal.readLatest(identity), []);
            assert.deepStrictEqual(journal.readLatest(), []);
        });

        test('bounds provider kinds and exit code buckets', () => {
            const providers = [
                ['coreclr', 'dotnet'],
                ['pwa-node', 'node'],
                ['debugpy', 'python'],
                ['java', 'java'],
                ['go', 'go'],
                ['lldb', 'rust'],
                ['maui', 'maui'],
                ['azure-functions', 'azureFunctions'],
                ['pwa-msedge', 'browser'],
                ['bun', 'bun'],
                ['private-debugger', 'other'],
            ] as const;

            for (const [providerKind, expected] of providers) {
                assert.strictEqual(createFailure({ providerKind }).providerKind, expected);
            }

            assert.strictEqual(createFailure({ exitCode: undefined }).exitCodeBucket, 'none');
            assert.strictEqual(createFailure({ exitCode: 0 }).exitCodeBucket, 'zero');
            assert.strictEqual(createFailure({ exitCode: 1 }).exitCodeBucket, 'one');
            assert.strictEqual(createFailure({ exitCode: 17 }).exitCodeBucket, 'other');
            assert.strictEqual(createFailure({ exitCode: null, signal: 'SIGTERM' }).exitCodeBucket, 'signal');
        });

        test('does not retain raw failure data in normalized, stored, or returned records', () => {
            const secrets = {
                message: 'raw-message-secret',
                stack: 'raw-stack-secret',
                output: 'raw-output-secret',
                path: '/private/raw-path-secret',
                url: 'https://raw-url-secret.example',
                arguments: ['raw-argument-secret'],
                environment: { PRIVATE_ENV: 'raw-environment-secret' },
                token: 'raw-token-secret',
                resourceProperties: { connectionString: 'raw-resource-secret' },
                debugConfiguration: { program: 'raw-debug-config-secret' },
                pid: 424242,
                sessionId: 'raw-session-id-secret',
            };
            const error = Object.assign(new Error(secrets.message), {
                name: 'RawError',
                code: 'EACCES',
                stack: secrets.stack,
                output: secrets.output,
                path: secrets.path,
                url: secrets.url,
                arguments: secrets.arguments,
                environment: secrets.environment,
                token: secrets.token,
                resourceProperties: secrets.resourceProperties,
                debugConfiguration: secrets.debugConfiguration,
                pid: secrets.pid,
                sessionId: secrets.sessionId,
            });
            const rawFailure = {
                stage: 'debugSession',
                controller: 'editor',
                mode: 'debug',
                providerKind: 'node',
                exitCode: 17,
                error,
                ...secrets,
            } as unknown as LaunchFailureInput;
            const normalized = normalizeLaunchFailure(rawFailure);
            const journal = new LaunchFailureJournal({ now: () => 123_456 });
            const identity = getOrCreateIdentityForAbsolutePath(appHostProjectPath);
            journal.record(identity, normalized);
            const records = journal.readLatest(identity);

            assert.deepStrictEqual(normalized, {
                stage: 'debugSession',
                category: 'permissionDenied',
                controller: 'editor',
                mode: 'debug',
                providerKind: 'node',
                exitCodeBucket: 'other',
            });
            assert.deepStrictEqual(Object.keys(records[0]).sort(), [
                'appHostIdentity',
                'category',
                'controller',
                'exitCodeBucket',
                'mode',
                'providerKind',
                'recordedAt',
                'sequence',
                'stage',
            ]);

            const serialized = JSON.stringify({ journal, normalized, records });
            for (const secret of [
                secrets.message,
                secrets.stack,
                secrets.output,
                secrets.path,
                secrets.url,
                secrets.arguments[0],
                secrets.environment.PRIVATE_ENV,
                secrets.token,
                secrets.resourceProperties.connectionString,
                secrets.debugConfiguration.program,
                String(secrets.pid),
                secrets.sessionId,
            ]) {
                assert.strictEqual(serialized.includes(secret), false, `Retained raw value: ${secret}`);
            }
        });

        test('rejects a forged opaque identity instead of retaining a path', () => {
            const journal = new LaunchFailureJournal({ now: () => 123_456 });
            const rawPath = '/private/forged-apphost-path';

            assert.throws(() => journal.record(rawPath as any, createFailure()), /opaque AppHost identity/);
            assert.strictEqual(JSON.stringify(journal).includes(rawPath), false);
        });
    });
});
