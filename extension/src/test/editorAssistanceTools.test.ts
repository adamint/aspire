import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { type AspireOperationKind } from '../dcp/types';
import {
    type AppHostEditorStateLaunchService,
    type AppHostLifecycleDiscoveryService,
    type AppHostLifecycleEditorSessions,
} from '../lm/appHostLifecycleToolContracts';
import { EditorStateSnapshotService } from '../lm/editorStateSnapshotService';
import { SafeAppHostTargetResolver } from '../lm/safeAppHostTargetResolver';
import { type CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';
import { compareAppHostIdentity } from '../utils/appHostIdentity';

interface TestEditorSession {
    readonly appHostPath: string | undefined;
    readonly resolvedAppHostPath: string | undefined;
    readonly operationKind: AspireOperationKind;
    readonly startupCompleted: boolean;
    readonly noDebug: boolean;
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
    readonly editorSessions: TestEditorSession[] = [];

    isLaunching(appHostPath: string): boolean {
        return this.launchingPaths.has(path.resolve(appHostPath));
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

    teardown(() => {
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

        test('keeps identities stable for the same target and changes them when the resolved file changes', async function () {
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
            assert.notStrictEqual(firstResolution.target.identity, thirdResolution.target.identity);
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

        test('reports starting from a launch reservation before a session exists', async () => {
            launchService.launchingPaths.add(path.resolve(appHostProjectPath));

            const snapshot = await snapshotService.createSnapshot(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(snapshot.appHosts, [{
                appHost: 'AppHost/AppHost.csproj',
                state: 'starting',
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

        test('reports other-mode sessions without leaking debug configuration details', async () => {
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
                state: 'running',
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

        test('reports multipleSessions when more than one editor session maps to the same AppHost', async () => {
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
                    operationKind: 'publish',
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
});
