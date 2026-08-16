import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { AspireDebugSession } from '../debugger/AspireDebugSession';
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
    isValidAppHostPathOnlyInput,
    type EditorAssistanceResourceRepository,
    type EditorAssistanceToolResult,
    type EditorUiHandoffDebugSession,
} from '../lm/editorAssistanceToolContracts';
import { EditorAssistanceToolService } from '../lm/editorAssistanceToolService';
import {
    EditorAssistanceTelemetry,
    type EditorAssistanceTelemetryEvent,
} from '../lm/editorAssistanceTelemetry';
import { EditorUiHandoffService } from '../lm/editorUiHandoffService';
import { EditorStateSnapshotService } from '../lm/editorStateSnapshotService';
import {
    __resetLaunchFailureJournalForTests,
    normalizeLaunchFailure,
    readLatestLaunchFailures,
    type SanitizedLaunchFailure,
} from '../services/launchFailureJournal';
import { SafeAppHostTargetResolver } from '../lm/safeAppHostTargetResolver';
import { type EditorResourceSessionSnapshot } from '../services/appHostLaunchContracts';
import { AspireCliParseError, type AppHostDisplayInfo, type ResourceJson } from '../data/appHostCliContracts';
import {
    __resetAppHostIdentityRegistryForTests,
    type OpaqueAppHostIdentity,
} from '../utils/appHostIdentity';
import { extensionLogOutputChannel } from '../utils/logging';
import { directLink } from '../loc/strings';
import {
    addCandidate,
    appHostProjectContents,
    createFixtureDirectory,
    createWorkspaceFolder,
    FakeDiscoveryService,
    FakeEditorStateLaunchService,
    type TestEditorSession,
} from './helpers/editorAssistanceTestSupport';

class FakeEditorAssistanceResourceRepository implements EditorAssistanceResourceRepository {
    readonly resourcesByAppHost = new Map<string, readonly ResourceJson[]>();
    readonly requests: string[] = [];
    error: unknown;

    async getAppHostResources(
        appHostPath: string,
        _resourceName: string,
        waitForResource: boolean,
        token: vscode.CancellationToken): Promise<readonly ResourceJson[]> {
        this.requests.push(appHostPath);
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        if (!waitForResource) {
            return this.resourcesByAppHost.get(path.resolve(appHostPath)) ?? [];
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
        appHostPid: process.pid,
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

function createUnsafeModelTriggeredError(workspaceRoot: string): {
    readonly error: Error;
    readonly sentinels: readonly string[];
} {
    const sentinels = [
        path.join(workspaceRoot, 'private', 'AppHost.csproj'),
        'dashboard-token-sentinel',
        'RAW_CLI_STDOUT_SENTINEL',
        'CREDENTIAL_SENTINEL=editor-secret',
        'STACK_MESSAGE_SENTINEL',
    ] as const;
    const error = new Error([
        sentinels[0],
        `https://dashboard.example.invalid/login?t=${sentinels[1]}`,
        sentinels[2],
        sentinels[3],
    ].join(' | '));
    error.stack = `${error.name}: ${error.message}\n    at ${sentinels[4]}`;
    return { error, sentinels };
}

function readEditorAssistanceToolResult(result: vscode.LanguageModelToolResult): EditorAssistanceToolResult {
    const parts = result.content as Array<{ value?: unknown }>;
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(typeof parts[0]?.value, 'string');
    return JSON.parse(parts[0].value as string) as EditorAssistanceToolResult;
}

suite('Editor assistance AppHost services', () => {
    test('creates fixture directories directly under the extension test workspace', () => {
        const fixtureDirectory = createFixtureDirectory('support-root');

        try {
            const expectedRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'editor-assistance');
            assert.strictEqual(path.dirname(fixtureDirectory), expectedRoot);
        }
        finally {
            fs.rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test('strictly validates shared AppHost-path-only inputs', () => {
        assert.strictEqual(isValidAppHostPathOnlyInput({
            appHostPath: 'AppHost/AppHost.csproj',
        }), true);
        assert.strictEqual(isValidAppHostPathOnlyInput({
            appHostPath: '',
        }), true);

        for (const input of [
            {},
            { appHostPath: undefined },
            null,
            [],
            { appHostPath: 'AppHost/AppHost.csproj', extra: true },
        ]) {
            assert.strictEqual(isValidAppHostPathOnlyInput(input), false);
        }
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
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'API' },
                    token),
                {
                    success: false,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'resourceNotFound',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'API',
                });

            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                createResource('api', path.join(workspaceRoot, 'ExactApi', 'Api.csproj')),
                {
                    ...createResource('api-replica', path.join(workspaceRoot, 'ReplicaApi', 'Api.csproj')),
                    displayName: 'api',
                },
            ]);
            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'API' },
                    token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'notDebugging',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'API',
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

        test('matches logical resource display names and rejects duplicate replicas', async () => {
            const token = new vscode.CancellationTokenSource().token;
            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [{
                ...createResource('api-abc123', path.join(workspaceRoot, 'Api', 'Api.csproj')),
                displayName: 'api',
            }]);

            assert.deepStrictEqual(
                await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                    token),
                {
                    success: true,
                    tool: aspireDebugSessionStatusToolName,
                    outcome: 'notDebugging',
                    scope: 'resource',
                    controller: 'editor',
                    appHost: 'AppHost/AppHost.csproj',
                    resourceName: 'api',
                });

            resourceRepository.resourcesByAppHost.set(path.resolve(appHostProjectPath), [
                {
                    ...createResource('api-abc123', path.join(workspaceRoot, 'Api', 'Api.csproj')),
                    displayName: 'api',
                },
                {
                    ...createResource('api-def456', path.join(workspaceRoot, 'Api', 'Api.csproj')),
                    displayName: 'api',
                },
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

        test('fails closed for an unverified stopped resource without waiting and preserves active-session errors', async () => {
            resourceRepository.error = new AspireCliParseError(
                'aspire describe',
                '',
                new SyntaxError('Unexpected end of JSON input'));
            const stopped = await service.getDebugSessionStatus(
                { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(stopped, {
                success: false,
                tool: aspireDebugSessionStatusToolName,
                outcome: 'resourceNotFound',
                scope: 'resource',
                controller: 'editor',
                appHost: 'AppHost/AppHost.csproj',
                resourceName: 'api',
            });
            assert.deepStrictEqual(resourceRepository.requests, [path.resolve(appHostProjectPath)]);

            launchService.editorSessions.push({
                appHostPath: appHostProjectPath,
                resolvedAppHostPath: appHostProjectPath,
                operationKind: 'run',
                startupCompleted: true,
                noDebug: false,
                isStopping: false,
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

        test('keeps preflight, status, and explanation diagnostics free of raw error text', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const errorLog = sandbox.stub(extensionLogOutputChannel, 'error');
                const { error, sentinels } = createUnsafeModelTriggeredError(workspaceRoot);

                launchService.editorSessions.push({
                    appHostPath: appHostProjectPath,
                    resolvedAppHostPath: appHostProjectPath,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                });
                resourceRepository.error = error;
                const statusResult = await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj', resourceName: 'api' },
                    new vscode.CancellationTokenSource().token);

                failureReaderError = error;
                const explainResult = await service.explainLaunchFailure(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);

                resourceRepository.error = undefined;
                failureReaderError = undefined;
                sandbox.stub(resolver, 'resolveTarget').rejects(error);
                const preflightResult = await service.getDebugSessionStatus(
                    { appHostPath: 'AppHost/AppHost.csproj' },
                    new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(
                    [statusResult, explainResult, preflightResult].map(result => result.outcome),
                    ['error', 'error', 'error']);
                assert.deepStrictEqual(
                    errorLog.getCalls().map(call => call.args),
                    [
                        [`Aspire language model tool ${aspireDebugSessionStatusToolName} failed.`],
                        [`Aspire language model tool ${aspireExplainLaunchFailureToolName} failed.`],
                        [`Aspire language model tool ${aspireDebugSessionStatusToolName} failed while resolving an AppHost.`],
                    ]);

                const serialized = JSON.stringify({
                    results: [statusResult, explainResult, preflightResult],
                    logs: errorLog.getCalls().map(call => call.args),
                });
                for (const sentinel of sentinels) {
                    assert.strictEqual(serialized.includes(sentinel), false, `Leaked sentinel: ${sentinel}`);
                }
            }
            finally {
                sandbox.restore();
            }
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

        test('rechecks Output trust after confirmation before showing the view', async () => {
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

        test('rejects a Dashboard target that resolves to a different identity after confirmation', async () => {
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
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'appHostNotFound',
                });
                assert.strictEqual(openExternal.callCount, 0);

                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);
                const retry = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));

                assert.deepStrictEqual(retry, {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'appHostNotFound',
                });
                assert.strictEqual(openExternal.callCount, 0);
            }
            finally {
                sandbox.restore();
            }
        });

        test('fails closed when Dashboard invocation has no matching preparation', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const tool = new AspireOpenDashboardLanguageModelTool(service);
                uiRepository.appHosts = [
                    createRunningAppHost(appHostProjectPath, 'https://dashboard.example.invalid/login?t=private'),
                ];

                const result = readEditorAssistanceToolResult(await tool.invoke(
                    {
                        input: { appHostPath: 'AppHost/AppHost.csproj' },
                        toolInvocationToken: undefined,
                    },
                    new vscode.CancellationTokenSource().token));

                assert.deepStrictEqual(result, {
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'appHostNotFound',
                });
                assert.strictEqual(openExternal.callCount, 0);
            }
            finally {
                sandbox.restore();
            }
        });

        test('opens a prepared Dashboard identity once and rejects duplicate invocation', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const tool = new AspireOpenDashboardLanguageModelTool(service);
                const input = { appHostPath: 'AppHost/AppHost.csproj' };
                uiRepository.appHosts = [
                    createRunningAppHost(appHostProjectPath, 'https://dashboard.example.invalid/login?t=private'),
                ];
                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);

                const first = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));
                const second = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));

                assert.strictEqual(first.outcome, 'opened');
                assert.strictEqual(second.outcome, 'appHostNotFound');
                assert.strictEqual(openExternal.callCount, 1);
            }
            finally {
                sandbox.restore();
            }
        });

        test('allows a valid Dashboard preparation after an unresolved preparation', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const tool = new AspireOpenDashboardLanguageModelTool(service);
                const input = { appHostPath: 'Later/AppHost.csproj' };

                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);
                const unresolved = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));
                assert.strictEqual(unresolved.outcome, 'appHostNotFound');

                const laterPath = path.join(workspaceRoot, 'Later', 'AppHost.csproj');
                fs.mkdirSync(path.dirname(laterPath), { recursive: true });
                fs.writeFileSync(laterPath, appHostProjectContents);
                addCandidate(discoveryService, workspaceRoot, laterPath);
                uiRepository.appHosts = [
                    createRunningAppHost(laterPath, 'https://dashboard.example.invalid/login?t=private'),
                ];
                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);
                const resolved = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));

                assert.strictEqual(resolved.outcome, 'opened');
                assert.strictEqual(openExternal.callCount, 1);
            }
            finally {
                sandbox.restore();
            }
        });

        test('invalidates an unconsumed Dashboard preparation when a later preparation is unresolved', async () => {
            const sandbox = sinon.createSandbox();
            try {
                sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const tool = new AspireOpenDashboardLanguageModelTool(service);
                const input = { appHostPath: 'AppHost/AppHost.csproj' };
                uiRepository.appHosts = [
                    createRunningAppHost(appHostProjectPath, 'https://dashboard.example.invalid/login?t=private'),
                ];
                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);

                isTrustedStub.value(false);
                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);
                isTrustedStub.value(true);
                const invalidated = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));

                assert.strictEqual(invalidated.outcome, 'appHostNotFound');
                assert.strictEqual(openExternal.callCount, 0);

                await tool.prepareInvocation(
                    { input },
                    new vscode.CancellationTokenSource().token);
                const recovered = readEditorAssistanceToolResult(await tool.invoke(
                    { input, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));

                assert.strictEqual(recovered.outcome, 'opened');
                assert.strictEqual(openExternal.callCount, 1);
            }
            finally {
                sandbox.restore();
            }
        });

        test('fails closed when overlapping Dashboard preparations resolve different identities', async () => {
            const tool = new AspireOpenDashboardLanguageModelTool(service);
            const input = { appHostPath: 'AppHost/AppHost.csproj' };
            await tool.prepareInvocation(
                { input },
                new vscode.CancellationTokenSource().token);

            const replacementPath = path.join(secondWorkspaceRoot, 'AppHost', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(replacementPath), { recursive: true });
            fs.writeFileSync(replacementPath, appHostProjectContents);
            addCandidate(discoveryService, secondWorkspaceRoot, replacementPath);
            workspaceFoldersStub.value([
                createWorkspaceFolder(secondWorkspaceRoot, 'second', 0),
            ]);
            await tool.prepareInvocation(
                { input },
                new vscode.CancellationTokenSource().token);

            const first = readEditorAssistanceToolResult(await tool.invoke(
                { input, toolInvocationToken: undefined },
                new vscode.CancellationTokenSource().token));
            const second = readEditorAssistanceToolResult(await tool.invoke(
                { input, toolInvocationToken: undefined },
                new vscode.CancellationTokenSource().token));

            assert.strictEqual(first.outcome, 'appHostNotFound');
            assert.strictEqual(second.outcome, 'appHostNotFound');
            assert.strictEqual(uiRepository.requests.length, 0);
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
                sandbox.stub(process, 'kill').callsFake((pid, signal) => {
                    assert.strictEqual(signal, 0);
                    if (pid === 999999) {
                        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
                    }

                    return true;
                });
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

                uiRepository.appHosts = [{
                    ...createRunningAppHost(appHostProjectPath, 'https://stale.example.invalid'),
                    appHostPid: 999999,
                }];
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

        test('reuses the exact editor-owned Dashboard launcher and uses ownerless fallback only with zero editor sessions', async () => {
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

        test('fails closed when fresh CLI ownership is null or mismatched during editor session shutdown', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const getConfiguration = sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const startDebugging = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
                const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
                const showInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
                const ownedOpenDashboard = sandbox.stub().resolves('debugBrowser');
                dashboardSessionsByIdentity.set(
                    resolver.getIdentityForAppHostPath(appHostProjectPath),
                    [{
                        cliProcessId: 1001,
                        configuration: { dashboardBrowser: 'debugEdge' },
                        isShuttingDown: true,
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
                        success: false,
                        tool: aspireOpenDashboardToolName,
                        outcome: 'error',
                    });
                }

                sinon.assert.notCalled(getConfiguration);
                sinon.assert.notCalled(openExternal);
                sinon.assert.notCalled(startDebugging);
                sinon.assert.notCalled(executeCommand);
                sinon.assert.notCalled(showInformationMessage);
                assert.strictEqual(ownedOpenDashboard.callCount, 0);
            }
            finally {
                sandbox.restore();
            }
        });

        test('fails closed when multiple editor sessions match the fresh CLI owner', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const matchingCliPid = 2002;
                const getConfiguration = sandbox.stub(vscode.workspace, 'getConfiguration').returns(createAspireConfiguration({
                    dashboardBrowser: 'openExternalBrowser',
                }));
                const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
                const firstOpenDashboard = sandbox.stub().resolves('integratedBrowser');
                const secondOpenDashboard = sandbox.stub().resolves('debugBrowser');
                dashboardSessionsByIdentity.set(
                    resolver.getIdentityForAppHostPath(appHostProjectPath),
                    [{
                        cliProcessId: matchingCliPid,
                        configuration: { dashboardBrowser: 'integratedBrowser' },
                        isShuttingDown: false,
                        openDashboard: firstOpenDashboard,
                    }, {
                        cliProcessId: matchingCliPid,
                        configuration: { dashboardBrowser: 'debugEdge' },
                        isShuttingDown: false,
                        openDashboard: secondOpenDashboard,
                    }]);
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
                    success: false,
                    tool: aspireOpenDashboardToolName,
                    outcome: 'error',
                });
                sinon.assert.notCalled(getConfiguration);
                sinon.assert.notCalled(openExternal);
                sinon.assert.notCalled(firstOpenDashboard);
                sinon.assert.notCalled(secondOpenDashboard);
                assert.strictEqual(JSON.stringify(result).includes(String(matchingCliPid)), false);
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
                sinon.assert.calledWithExactly(
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

        test('shows Aspire Output exactly once without reading or appending content', async () => {
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
            const telemetryEvents: EditorAssistanceTelemetryEvent[] = [];
            let now = 100;
            const telemetry = new EditorAssistanceTelemetry({
                clock: { now: () => now++ },
                sendEvent: (eventName, properties, measurements) =>
                    telemetryEvents.push({ eventName, properties, measurements }),
            });
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').callsFake((name: string) =>
                new vscode.Disposable(() => disposed.push(name)));
            try {
                const registration = registerEditorAssistanceTools(service, telemetry);
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
                assert.deepStrictEqual(telemetryEvents, [
                    {
                        eventName: 'aspire/vscode/editorassistance/result',
                        properties: {
                            tool: aspireDebugSessionStatusToolName,
                            outcome: 'notDebugging',
                            source: 'languageModelTool',
                            scope: 'appHost',
                            controller: 'editor',
                            state_bucket: 'notDebugging',
                        },
                        measurements: { duration_ms: 1 },
                    },
                    {
                        eventName: 'aspire/vscode/editorassistance/result',
                        properties: {
                            tool: aspireExplainLaunchFailureToolName,
                            outcome: 'noRecordedFailure',
                            source: 'languageModelTool',
                        },
                        measurements: { duration_ms: 1 },
                    },
                ]);

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

});
