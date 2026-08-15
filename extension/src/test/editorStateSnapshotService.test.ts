import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { EditorStateSnapshotService } from '../lm/editorStateSnapshotService';
import { SafeAppHostTargetResolver } from '../lm/safeAppHostTargetResolver';
import { __resetLaunchFailureJournalForTests } from '../services/launchFailureJournal';
import {
    __resetAppHostIdentityRegistryForTests,
    compareAppHostIdentity,
} from '../utils/appHostIdentity';
import {
    addCandidate,
    appHostProjectContents,
    assertResolved,
    createFixtureDirectory,
    createWorkspaceFolder,
    FakeDiscoveryService,
    FakeEditorStateLaunchService,
} from './helpers/editorAssistanceTestSupport';

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

    teardown(() => {
        __resetLaunchFailureJournalForTests();
        __resetAppHostIdentityRegistryForTests();
        workspaceFoldersStub.restore();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    });

    suite('EditorStateSnapshotService', () => {
        test('uses the same projection for full, active, and exact summaries', async () => {
            const otherAppHostSourcePath = path.join(path.dirname(appHostProjectPath), 'apphost.cs');
            fs.writeFileSync(otherAppHostSourcePath, 'var builder = DistributedApplication.CreateBuilder(args);');
            const activeAppHostPath = path.join(workspaceRoot, 'ActiveAppHost', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(activeAppHostPath), { recursive: true });
            fs.writeFileSync(activeAppHostPath, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, activeAppHostPath);
            launchService.editorSessions.push(
                {
                    appHostPath: otherAppHostSourcePath,
                    resolvedAppHostPath: activeAppHostPath,
                    operationKind: 'run',
                    startupCompleted: true,
                    noDebug: false,
                    isStopping: false,
                },
                {
                    appHostPath: activeAppHostPath,
                    resolvedAppHostPath: activeAppHostPath,
                    operationKind: 'deploy',
                    startupCompleted: false,
                    noDebug: true,
                    isStopping: true,
                });

            const token = new vscode.CancellationTokenSource().token;
            const resolution = await resolver.resolveTarget('ActiveAppHost/AppHost.csproj', token);
            assertResolved(resolution);
            assert.strictEqual(compareAppHostIdentity(otherAppHostSourcePath, appHostProjectPath), 'same');
            assert.strictEqual(compareAppHostIdentity(otherAppHostSourcePath, activeAppHostPath), 'different');

            const snapshot = await snapshotService.createSnapshot(token);
            const activeSnapshot = await snapshotService.createActiveSessionSnapshot(token);
            const exactSummary = await snapshotService.getAppHostSummary(resolution.target, token);
            const snapshotSummary = snapshot.appHosts.find(summary => summary.appHost === resolution.target.displayPath);
            const activeSummary = activeSnapshot.appHosts.find(summary => summary.appHost === resolution.target.displayPath);
            const expectedSummary = {
                appHost: 'ActiveAppHost/AppHost.csproj',
                state: 'running',
                mode: 'debug',
                controller: 'editor',
            };

            assert.strictEqual(snapshot.appHosts.length, 2);
            assert.strictEqual(activeSnapshot.appHosts.length, 1);
            assert.deepStrictEqual(snapshotSummary, expectedSummary);
            assert.deepStrictEqual(activeSummary, expectedSummary);
            assert.deepStrictEqual(exactSummary, expectedSummary);
        });

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
});
