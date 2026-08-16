import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { SafeAppHostTargetResolver } from '../lm/safeAppHostTargetResolver';
import { __resetLaunchFailureJournalForTests } from '../services/launchFailureJournal';
import { __resetAppHostIdentityRegistryForTests } from '../utils/appHostIdentity';
import { extensionLogOutputChannel } from '../utils/logging';
import {
    addCandidate,
    appHostProjectContents,
    assertResolved,
    createFixtureDirectory,
    createWorkspaceFolder,
    FakeDiscoveryService,
} from './helpers/editorAssistanceTestSupport';

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

suite('Editor assistance AppHost services', () => {
    let workspaceRoot: string;
    let outsideRoot: string;
    let workspaceFoldersStub: sinon.SinonStub;
    let discoveryService: FakeDiscoveryService;
    let resolver: SafeAppHostTargetResolver;
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
        resolver = new SafeAppHostTargetResolver(discoveryService);
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

        test('keeps resolver discovery diagnostics free of raw error text', async () => {
            const sandbox = sinon.createSandbox();
            try {
                const warningLog = sandbox.stub(extensionLogOutputChannel, 'warn');
                const { error, sentinels } = createUnsafeModelTriggeredError(workspaceRoot);
                discoveryService.discoverError = error;

                const resolution = await resolver.resolveTarget(
                    'AppHost/AppHost.csproj',
                    new vscode.CancellationTokenSource().token);

                assert.deepStrictEqual(resolution, { resolved: false, outcome: 'error' });
                sinon.assert.calledOnceWithExactly(
                    warningLog,
                    'Aspire editor assistance could not enumerate AppHosts.');
                const serialized = JSON.stringify({
                    resolution,
                    logs: warningLog.getCalls().map(call => call.args),
                });
                for (const sentinel of sentinels) {
                    assert.strictEqual(serialized.includes(sentinel), false, `Leaked sentinel: ${sentinel}`);
                }
            }
            finally {
                sandbox.restore();
            }
        });

        test('omits candidates that are outside every workspace folder', async () => {
            const outsideAppHost = path.join(outsideRoot, 'External', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(outsideAppHost), { recursive: true });
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, outsideAppHost);

            const knownTargets = await resolver.enumerateKnownAppHosts(new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(knownTargets.map(target => target.displayPath), ['AppHost/AppHost.csproj']);
        });

        test('enumerates and resolves workspace child paths whose names begin with two dots', async () => {
            const dottedAppHost = path.join(workspaceRoot, '..app', 'AppHost.csproj');
            fs.mkdirSync(path.dirname(dottedAppHost), { recursive: true });
            fs.writeFileSync(dottedAppHost, appHostProjectContents);
            addCandidate(discoveryService, workspaceRoot, dottedAppHost);

            const token = new vscode.CancellationTokenSource().token;
            const knownTargets = await resolver.enumerateKnownAppHosts(token);
            const resolution = await resolver.resolveTarget('..app/AppHost.csproj', token);

            assert.deepStrictEqual(
                knownTargets.map(target => target.displayPath),
                ['AppHost/AppHost.csproj', '..app/AppHost.csproj']);
            assertResolved(resolution);
            assert.strictEqual(resolution.target.absolutePath, dottedAppHost);
            assert.strictEqual(resolution.target.relativePath, '..app/AppHost.csproj');
            assert.strictEqual(resolution.target.displayPath, '..app/AppHost.csproj');
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

        test('changes target identity when a symlink retargets', async function () {
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

        test('preserves target identity when the same AppHost file is atomically replaced', async () => {
            const firstResolution = await resolver.resolveTarget('AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);
            assertResolved(firstResolution);

            const replacementPath = `${appHostProjectPath}.replacement`;
            fs.writeFileSync(replacementPath, `${appHostProjectContents}\n`);
            fs.renameSync(replacementPath, appHostProjectPath);

            const secondResolution = await resolver.resolveTarget('AppHost/AppHost.csproj', new vscode.CancellationTokenSource().token);
            assertResolved(secondResolution);
            assert.strictEqual(firstResolution.target.identity, secondResolution.target.identity);
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
});
