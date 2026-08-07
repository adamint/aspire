import * as assert from 'assert';
import * as crypto from 'crypto';
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
    type AppHostLifecycleEditorSession,
    type AppHostLifecycleLaunchService,
    type AppHostLifecycleToolResult,
} from '../lm/appHostLifecycleTools';

interface LaunchCall {
    appHostPath: string;
    command: string;
    noDebug: boolean;
}

class FakeLaunchService implements AppHostLifecycleLaunchService {
    readonly launchCalls: LaunchCall[] = [];
    launchingPaths = new Set<string>();
    launchDelay: Promise<void> | undefined;
    launchError: Error | undefined;
    markLaunchingOnLaunch = true;

    isLaunching(appHostPath: string): boolean {
        return this.launchingPaths.has(path.resolve(appHostPath));
    }

    async launch(appHostPath: string, command: 'run', noDebug: boolean): Promise<void> {
        this.launchCalls.push({ appHostPath, command, noDebug });
        if (this.launchDelay) {
            await this.launchDelay;
        }

        if (this.launchError) {
            throw this.launchError;
        }

        if (this.markLaunchingOnLaunch) {
            this.launchingPaths.add(path.resolve(appHostPath));
        }
    }
}

class FakeEditorSession implements AppHostLifecycleEditorSession {
    stopCount = 0;
    stopError: Error | undefined;
    startupCompleted = true;
    // Mirrors production: AspireDebugSession.stopDebugging() ends with the session
    // being removed from the editor-owned session list.
    onStopped: (() => void) | undefined;

    constructor(readonly appHostPath: string | undefined, readonly configuration: { noDebug?: boolean }) {
    }

    async stopDebugging(): Promise<void> {
        this.stopCount++;
        if (this.stopError) {
            throw this.stopError;
        }

        this.onStopped?.();
    }
}

const appHostProjectContents = `<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.0.0" />
</Project>`;

const singleFileAppHostContents = `#:sdk Aspire.AppHost.Sdk@13.0.0
var builder = DistributedApplication.CreateBuilder(args);
builder.Build().Run();
`;

// Fixtures live under the extension's gitignored test workspace rather than the OS temp
// directory so a crashed run leaves the artifacts next to the repo instead of a shared
// location, and so symlink fixtures resolve on the same volume as the workspace folder.
function createFixtureDirectory(prefix: string): string {
    const fixtureRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'lm-tools');
    const directory = path.join(fixtureRoot, `${prefix}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function readToolResultPayload(result: vscode.LanguageModelToolResult): AppHostLifecycleToolResult {
    const parts = result.content as Array<{ value?: unknown }>;
    assert.strictEqual(parts.length, 1, 'Tool results must be a single bounded content part.');
    const value = parts[0]?.value;
    assert.strictEqual(typeof value, 'string');
    return JSON.parse(value as string) as AppHostLifecycleToolResult;
}

suite('AppHost lifecycle language model tools', () => {
    let workspaceRoot: string;
    let realWorkspaceRoot: string;
    let outsideRoot: string;
    let appHostProjectPath: string;
    let workspaceFoldersStub: sinon.SinonStub;
    let isTrustedStub: sinon.SinonStub;
    let launchService: FakeLaunchService;
    let editorSessions: FakeEditorSession[];
    let runningAppHostPaths: string[];
    let service: AppHostLifecycleToolService;

    setup(() => {
        workspaceRoot = createFixtureDirectory('workspace');
        // macOS reports /var as a symlink to /private/var, so the workspace folder that
        // VS Code reports and the realpath of files inside it differ. Containment checks
        // must survive that, which is why the fixture keeps both forms.
        realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
        outsideRoot = createFixtureDirectory('outside');
        fs.mkdirSync(path.join(workspaceRoot, 'AppHost'), { recursive: true });
        appHostProjectPath = path.join(workspaceRoot, 'AppHost', 'AppHost.csproj');
        fs.writeFileSync(appHostProjectPath, appHostProjectContents);

        workspaceFoldersStub = sinon.stub(vscode.workspace, 'workspaceFolders').value([
            { uri: vscode.Uri.file(workspaceRoot), name: 'workspace', index: 0 },
        ]);
        isTrustedStub = sinon.stub(vscode.workspace, 'isTrusted').value(true);

        launchService = new FakeLaunchService();
        editorSessions = [];
        runningAppHostPaths = [];
        service = new AppHostLifecycleToolService({
            launchService,
            getEditorOwnedSessions: () => editorSessions,
            getRunningAppHostPaths: () => runningAppHostPaths,
        });
    });

    teardown(() => {
        service.dispose();
        workspaceFoldersStub.restore();
        isTrustedStub.restore();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    });

    suite('manifest and localization', () => {
        test('contributes both AppHost lifecycle tools with localized, schema-bound definitions', () => {
            const extensionRoot = path.resolve(__dirname, '..', '..');
            const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
                activationEvents?: string[];
                contributes: { languageModelTools?: Array<Record<string, any>> };
            };
            const packageNls = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;
            const tools = manifest.contributes.languageModelTools ?? [];

            assert.deepStrictEqual(tools.map(tool => tool.name), [aspireAppHostStartToolName, aspireAppHostStopToolName]);

            for (const tool of tools) {
                for (const localizedField of ['displayName', 'modelDescription', 'userDescription']) {
                    const reference = tool[localizedField] as string;
                    assert.match(reference, /^%[\w.-]+%$/, `${tool.name}.${localizedField} must be a package.nls reference.`);
                    const key = reference.slice(1, -1);
                    assert.ok(packageNls[key], `package.nls.json is missing ${key}.`);
                }

                assert.strictEqual(tool.canBeReferencedInPrompt, true);
                assert.strictEqual(tool.when, 'isWorkspaceTrusted');
                assert.ok(manifest.activationEvents?.includes(`onLanguageModelTool:${tool.name}`));

                const schema = tool.inputSchema as {
                    type: string;
                    additionalProperties: boolean;
                    required: string[];
                    properties: Record<string, { type: string; enum?: string[]; description: string }>;
                };
                assert.strictEqual(schema.type, 'object');
                assert.strictEqual(schema.additionalProperties, false);
                assert.match(schema.properties.appHostPath.description, /^%[\w.-]+%$/);
                const appHostPathDescriptionKey = schema.properties.appHostPath.description.slice(1, -1);
                assert.ok(packageNls[appHostPathDescriptionKey]);
            }

            const startSchema = tools[0].inputSchema;
            assert.deepStrictEqual(startSchema.required, ['appHostPath', 'mode']);
            assert.deepStrictEqual(startSchema.properties.mode.enum, ['run', 'debug']);

            const stopSchema = tools[1].inputSchema;
            assert.deepStrictEqual(stopSchema.required, ['appHostPath']);
            assert.deepStrictEqual(Object.keys(stopSchema.properties), ['appHostPath']);
        });

        test('registers runtime tool strings for localization', () => {
            const extensionRoot = path.resolve(__dirname, '..', '..');
            const packageNls = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;

            assert.deepStrictEqual(
                {
                    startTitle: packageNls['aspire-vscode.strings.appHostLifecycleStartConfirmationTitle'],
                    stopTitle: packageNls['aspire-vscode.strings.appHostLifecycleStopConfirmationTitle'],
                    startMessage: packageNls['aspire-vscode.strings.appHostLifecycleStartConfirmationMessage'],
                    stopMessage: packageNls['aspire-vscode.strings.appHostLifecycleStopConfirmationMessage'],
                },
                {
                    startTitle: 'Start Aspire AppHost',
                    stopTitle: 'Stop Aspire AppHost',
                    startMessage: 'Start the Aspire AppHost {0} in {1} mode?',
                    stopMessage: 'Stop the Aspire AppHost {0}?',
                });
        });
    });

    suite('registration compatibility', () => {
        test('does not register tools when the stable language model tool API is unavailable', () => {
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').value(undefined);
            try {
                const registration = registerAppHostLifecycleTools(service);
                registration.dispose();
                assert.strictEqual(registration.registered, false);
            }
            finally {
                registerToolStub.restore();
            }
        });

        test('does not register tools until the workspace is trusted', () => {
            isTrustedStub.value(false);
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').returns(new vscode.Disposable(() => { }));
            try {
                const registration = registerAppHostLifecycleTools(service);
                assert.strictEqual(registration.registered, false);
                assert.strictEqual(registerToolStub.called, false);
                registration.dispose();
            }
            finally {
                registerToolStub.restore();
            }
        });

        test('registers both tools once when the API exists and the workspace is trusted', () => {
            const disposed: string[] = [];
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').callsFake((name: string) => new vscode.Disposable(() => disposed.push(name)));
            try {
                const registration = registerAppHostLifecycleTools(service);
                assert.strictEqual(registration.registered, true);
                assert.deepStrictEqual(registerToolStub.getCalls().map(call => call.args[0]), [aspireAppHostStartToolName, aspireAppHostStopToolName]);

                registration.dispose();
                assert.deepStrictEqual(disposed, [aspireAppHostStartToolName, aspireAppHostStopToolName]);
            }
            finally {
                registerToolStub.restore();
            }
        });
    });

    suite('path canonicalization', () => {
        test('rejects a missing appHostPath without launching', async () => {
            const result = await service.start({ mode: 'run' } as never, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'invalidInput');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects an unknown mode without launching', async () => {
            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'watch' } as never, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'invalidInput');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a path that does not exist on disk', async () => {
            const result = await service.start({ appHostPath: 'AppHost/Missing.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'pathNotFound');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a relative path that matches more than one workspace folder', async () => {
            const secondRoot = createFixtureDirectory('second-workspace');
            try {
                fs.mkdirSync(path.join(secondRoot, 'AppHost'), { recursive: true });
                fs.writeFileSync(path.join(secondRoot, 'AppHost', 'AppHost.csproj'), appHostProjectContents);
                workspaceFoldersStub.value([
                    { uri: vscode.Uri.file(workspaceRoot), name: 'workspace', index: 0 },
                    { uri: vscode.Uri.file(secondRoot), name: 'second', index: 1 },
                ]);

                const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'pathAmbiguous');
                assert.strictEqual(launchService.launchCalls.length, 0);
            }
            finally {
                fs.rmSync(secondRoot, { recursive: true, force: true });
            }
        });

        test('rejects a path outside every workspace folder', async () => {
            const outsideAppHost = path.join(outsideRoot, 'AppHost.csproj');
            fs.writeFileSync(outsideAppHost, appHostProjectContents);

            const result = await service.start({ appHostPath: outsideAppHost, mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'pathOutsideWorkspace');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a traversal path that escapes the workspace folder', async () => {
            const outsideAppHost = path.join(outsideRoot, 'AppHost.csproj');
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            const traversal = path.join('..', path.basename(outsideRoot), 'AppHost.csproj');

            const result = await service.start({ appHostPath: traversal, mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'pathOutsideWorkspace');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a symlink inside the workspace whose target escapes the workspace', async function () {
            const outsideAppHost = path.join(outsideRoot, 'AppHost.csproj');
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            const linkPath = path.join(workspaceRoot, 'AppHost', 'Linked.csproj');
            try {
                fs.symlinkSync(outsideAppHost, linkPath);
            }
            catch {
                // Creating symlinks requires elevation or developer mode on Windows.
                this.skip();
            }

            const result = await service.start({ appHostPath: 'AppHost/Linked.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'pathEscapesWorkspace');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a workspace file that is not an AppHost', async () => {
            const notAnAppHost = path.join(workspaceRoot, 'AppHost', 'Library.csproj');
            fs.writeFileSync(notAnAppHost, '<Project Sdk="Microsoft.NET.Sdk"></Project>');

            const result = await service.start({ appHostPath: 'AppHost/Library.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'notAnAppHost');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a directory so the tool never infers which AppHost to launch', async () => {
            const result = await service.start({ appHostPath: 'AppHost', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'notAnAppHost');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('accepts a single-file AppHost and reports the workspace-relative path with forward slashes', async () => {
            const singleFilePath = path.join(workspaceRoot, 'AppHost', 'apphost.cs');
            fs.writeFileSync(singleFilePath, singleFileAppHostContents);

            const result = await service.start({ appHostPath: 'AppHost/apphost.cs', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'started');
            assert.strictEqual(result.appHostPath, 'AppHost/apphost.cs');
        });

        test('rejects every tool call while the workspace is untrusted', async () => {
            isTrustedStub.value(false);

            const startResult = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);
            const stopResult = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual([startResult.outcome, stopResult.outcome], ['workspaceNotTrusted', 'workspaceNotTrusted']);
            assert.strictEqual(launchService.launchCalls.length, 0);
        });
    });

    suite('start behavior', () => {
        test('maps run mode to a non-debug aspire run launch', async () => {
            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(launchService.launchCalls, [{ appHostPath: appHostProjectPath, command: 'run', noDebug: true }]);
            assert.deepStrictEqual(
                { outcome: result.outcome, requestedMode: result.requestedMode, effectiveMode: result.effectiveMode, ownership: result.ownership },
                { outcome: 'started', requestedMode: 'run', effectiveMode: 'run', ownership: 'editor' });
        });

        test('maps debug mode to a debugger-attached aspire run launch', async () => {
            await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(launchService.launchCalls, [{ appHostPath: appHostProjectPath, command: 'run', noDebug: false }]);
        });

        test('returns alreadyStarting without launching a second process', async () => {
            launchService.launchingPaths.add(path.resolve(appHostProjectPath));

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'alreadyStarting');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('returns alreadyStarting while the editor-owned session is still starting up', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            session.startupCompleted = false;
            editorSessions.push(session);

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'alreadyStarting');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        // The launching flag is cleared by `aspire ps` reconciliation, which can lag well
        // behind the session reporting that startup finished. A completed session is the
        // stronger signal, so the agent must be told the AppHost is running rather than
        // being left to poll a stale "starting" answer.
        test('prefers alreadyRunning over a stale launching flag once startup completed', async () => {
            launchService.launchingPaths.add(path.resolve(appHostProjectPath));
            editorSessions.push(new FakeEditorSession(appHostProjectPath, { noDebug: false }));

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, requestedMode: result.requestedMode, effectiveMode: result.effectiveMode, ownership: result.ownership },
                { outcome: 'alreadyRunning', requestedMode: 'run', effectiveMode: 'debug', ownership: 'editor' });
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('returns alreadyRunning with the effective mode of the editor-owned session', async () => {
            editorSessions.push(new FakeEditorSession(appHostProjectPath, { noDebug: true }));

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, requestedMode: result.requestedMode, effectiveMode: result.effectiveMode, ownership: result.ownership },
                { outcome: 'alreadyRunning', requestedMode: 'debug', effectiveMode: 'run', ownership: 'editor' });
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('refuses to start over an externally owned AppHost that is already running', async () => {
            runningAppHostPaths.push(appHostProjectPath);

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'alreadyRunning', ownership: 'external' });
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('serializes concurrent start calls for the same AppHost into a single launch', async () => {
            let releaseLaunch: (() => void) | undefined;
            launchService.launchDelay = new Promise<void>(resolve => { releaseLaunch = resolve; });

            const first = service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);
            const second = service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);
            const third = service.start({ appHostPath: appHostProjectPath, mode: 'run' }, new vscode.CancellationTokenSource().token);
            releaseLaunch?.();
            const results = await Promise.all([first, second, third]);

            assert.strictEqual(launchService.launchCalls.length, 1);
            assert.deepStrictEqual(results.map(result => result.outcome), ['started', 'alreadyStarting', 'alreadyStarting']);
        });

        test('honors cancellation before any launch side effect', async () => {
            const tokenSource = new vscode.CancellationTokenSource();
            tokenSource.cancel();

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, tokenSource.token);

            assert.strictEqual(result.outcome, 'cancelled');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects a stale path that disappears after the confirmation was prepared', async () => {
            const tool = new AppHostStartLanguageModelTool(service);
            const input = { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' } as const;
            const prepared = await tool.prepareInvocation({ input }, new vscode.CancellationTokenSource().token);
            assert.ok(prepared?.confirmationMessages);

            fs.rmSync(appHostProjectPath);
            const result = readToolResultPayload(await tool.invoke({ input, toolInvocationToken: undefined }, new vscode.CancellationTokenSource().token));

            assert.strictEqual(result.outcome, 'pathNotFound');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('reports a bounded failure without leaking launch error details', async () => {
            launchService.launchError = new Error('aspire run failed: token=super-secret-value at /Users/private/AppHost.csproj');

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);
            const serialized = JSON.stringify(result);

            assert.strictEqual(result.outcome, 'failed');
            assert.strictEqual(serialized.includes('super-secret-value'), false);
            assert.strictEqual(serialized.includes('/Users/private'), false);
        });

        test('reports cancellation when the launch pipeline cancels', async () => {
            launchService.launchError = new vscode.CancellationError();

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'cancelled');
        });
    });

    suite('stop behavior', () => {
        test('stops only the matching editor-owned session', async () => {
            const otherAppHost = path.join(workspaceRoot, 'AppHost', 'Other.csproj');
            fs.writeFileSync(otherAppHost, appHostProjectContents);
            const matching = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            const other = new FakeEditorSession(otherAppHost, { noDebug: false });
            editorSessions.push(other, matching);

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, effectiveMode: result.effectiveMode, ownership: result.ownership, appHostPath: result.appHostPath },
                { outcome: 'stopped', effectiveMode: 'debug', ownership: 'editor', appHostPath: 'AppHost/AppHost.csproj' });
            assert.deepStrictEqual([matching.stopCount, other.stopCount], [1, 0]);
        });

        test('refuses to stop an AppHost that the editor does not own', async () => {
            runningAppHostPaths.push(appHostProjectPath);

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'notEditorOwned', ownership: 'external' });
        });

        test('reports notRunning when nothing owns the AppHost', async () => {
            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'notRunning', ownership: 'none' });
        });

        test('refuses to stop when more than one editor-owned session matches', async () => {
            editorSessions.push(
                new FakeEditorSession(appHostProjectPath, { noDebug: false }),
                new FakeEditorSession(appHostProjectPath, { noDebug: true }));

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'ambiguousSession');
            assert.deepStrictEqual(editorSessions.map(session => session.stopCount), [0, 0]);
        });

        test('honors cancellation before stopping a session', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            editorSessions.push(session);
            const tokenSource = new vscode.CancellationTokenSource();
            tokenSource.cancel();

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, tokenSource.token);

            assert.strictEqual(result.outcome, 'cancelled');
            assert.strictEqual(session.stopCount, 0);
        });

        test('serializes concurrent stop calls so a session is stopped once', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            session.onStopped = () => { editorSessions.length = 0; };
            editorSessions.push(session);

            const results = await Promise.all([
                service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token),
                service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token),
            ]);

            assert.deepStrictEqual(results.map(result => result.outcome), ['stopped', 'notRunning']);
            assert.strictEqual(session.stopCount, 1);
        });

        test('reports a bounded failure without leaking stop error details', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            session.stopError = new Error('DCP token 8f2a-secret failed at /Users/private/.aspire');
            editorSessions.push(session);

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);
            const serialized = JSON.stringify(result);

            assert.strictEqual(result.outcome, 'failed');
            assert.strictEqual(serialized.includes('8f2a-secret'), false);
            assert.strictEqual(serialized.includes('/Users/private'), false);
        });
    });

    suite('confirmation', () => {
        test('always confirms a start with the action, relative path, and requested mode', async () => {
            const tool = new AppHostStartLanguageModelTool(service);

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' } },
                new vscode.CancellationTokenSource().token);

            assert.strictEqual(prepared?.confirmationMessages?.title, 'Start Aspire AppHost');
            assert.strictEqual(prepared?.confirmationMessages?.message, 'Start the Aspire AppHost AppHost/AppHost.csproj in debug mode?');
            assert.strictEqual(prepared?.invocationMessage, 'Starting Aspire AppHost AppHost/AppHost.csproj...');
        });

        test('always confirms a stop with the action and relative path', async () => {
            const tool = new AppHostStopLanguageModelTool(service);

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: 'AppHost/AppHost.csproj' } },
                new vscode.CancellationTokenSource().token);

            assert.strictEqual(prepared?.confirmationMessages?.title, 'Stop Aspire AppHost');
            assert.strictEqual(prepared?.confirmationMessages?.message, 'Stop the Aspire AppHost AppHost/AppHost.csproj?');
        });

        test('confirms unresolvable input without echoing an unbounded raw path', async () => {
            const tool = new AppHostStartLanguageModelTool(service);
            const longPath = `${'a'.repeat(400)}\n**injected**`;

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: longPath, mode: 'run' } },
                new vscode.CancellationTokenSource().token);

            const message = prepared?.confirmationMessages?.message as string;
            assert.ok(message.length < 300, `Confirmation message must stay bounded, was ${message.length} characters.`);
            assert.strictEqual(message.includes('\n'), false);
        });

        test('prepareInvocation does not launch or stop anything', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            editorSessions.push(session);
            const startTool = new AppHostStartLanguageModelTool(service);
            const stopTool = new AppHostStopLanguageModelTool(service);

            await startTool.prepareInvocation({ input: { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' } }, new vscode.CancellationTokenSource().token);
            await stopTool.prepareInvocation({ input: { appHostPath: 'AppHost/AppHost.csproj' } }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual([launchService.launchCalls.length, session.stopCount], [0, 0]);
        });
    });

    suite('tool result shape', () => {
        test('start returns only bounded, non-sensitive fields', async () => {
            const tool = new AppHostStartLanguageModelTool(service);

            const result = await tool.invoke(
                { input: { appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, toolInvocationToken: undefined },
                new vscode.CancellationTokenSource().token);
            const payload = readToolResultPayload(result);

            assert.deepStrictEqual(Object.keys(payload).sort(), ['appHostPath', 'effectiveMode', 'outcome', 'ownership', 'requestedMode', 'tool']);
            assert.strictEqual(payload.tool, aspireAppHostStartToolName);
            assert.strictEqual(payload.appHostPath, 'AppHost/AppHost.csproj');
            assert.strictEqual(JSON.stringify(payload).includes(workspaceRoot), false);
            assert.strictEqual(JSON.stringify(payload).includes(realWorkspaceRoot), false);
        });

        test('stop returns only bounded, non-sensitive fields', async () => {
            editorSessions.push(new FakeEditorSession(appHostProjectPath, { noDebug: true }));
            const tool = new AppHostStopLanguageModelTool(service);

            const result = await tool.invoke(
                { input: { appHostPath: 'AppHost/AppHost.csproj' }, toolInvocationToken: undefined },
                new vscode.CancellationTokenSource().token);
            const payload = readToolResultPayload(result);

            assert.deepStrictEqual(Object.keys(payload).sort(), ['appHostPath', 'effectiveMode', 'outcome', 'ownership', 'tool']);
            assert.strictEqual(payload.tool, aspireAppHostStopToolName);
            assert.strictEqual(payload.outcome, 'stopped');
        });
    });

    suite('disposal', () => {
        test('drops per-path locks once a call settles', async () => {
            await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(service.pendingLockCount, 0);
        });

        test('rejects tool calls after the service is disposed', async () => {
            service.dispose();

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'cancelled');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });
    });
});
