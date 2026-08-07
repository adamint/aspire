import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

const mutableFs = require('fs') as typeof fs;

import {
    AppHostLifecycleToolService,
    AppHostStartLanguageModelTool,
    AppHostStopLanguageModelTool,
    aspireAppHostStartToolName,
    aspireAppHostStopToolName,
    registerAppHostLifecycleTools,
    type AppHostLifecycleEditorSession,
    type AppHostLifecycleLaunchService,
    type AppHostLifecycleOwnedSessions,
    type AppHostLifecycleRunningAppHost,
    type AppHostLifecycleToolResult,
} from '../lm/appHostLifecycleTools';
import { AppHostLifecycleLockTimeoutError } from '../services/AppHostLaunchService';
import { compareAppHostIdentity, type AppHostIdentityRelation } from '../utils/appHostIdentity';

interface LaunchCall {
    appHostPath: string;
    command: string;
    noDebug: boolean;
}

class FakeLaunchService implements AppHostLifecycleLaunchService {
    readonly launchCalls: LaunchCall[] = [];
    launchingPaths = new Set<string>();
    editorSessions: FakeEditorSession[] = [];
    runningAppHosts: AppHostLifecycleRunningAppHost[] = [];
    runningAppHostRequests = 0;
    runningAppHostError: Error | undefined;
    launchDelay: Promise<void> | undefined;
    launchError: Error | undefined;
    markLaunchingOnLaunch = true;
    lifecycleLockError: Error | undefined;
    onLifecycleLockHeld: (() => void) | undefined;
    private readonly lifecycleLocks = new Map<string, Promise<unknown>>();

    get pendingLifecycleLockCount(): number {
        return this.lifecycleLocks.size;
    }

    isLaunching(appHostPath: string): boolean {
        return this.launchingPaths.has(path.resolve(appHostPath));
    }

    getEditorOwnedRunSessions(appHostPath: string): AppHostLifecycleOwnedSessions {
        const sessions: AppHostLifecycleEditorSession[] = [];
        let ambiguous = false;
        for (const session of this.editorSessions) {
            if (session.operationKind !== 'run') {
                continue;
            }

            switch (compareAppHostIdentity(session.appHostPath, appHostPath)) {
                case 'same':
                    sessions.push(session);
                    break;
                case 'ambiguous':
                    ambiguous = true;
                    break;
            }
        }

        return { sessions, ambiguous };
    }

    async getRunningAppHosts(token: vscode.CancellationToken): Promise<readonly AppHostLifecycleRunningAppHost[]> {
        this.runningAppHostRequests++;
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.runningAppHostError) {
            throw this.runningAppHostError;
        }

        return this.runningAppHosts;
    }

    compareAppHostIdentity(left: string | undefined, right: string | undefined): AppHostIdentityRelation {
        return compareAppHostIdentity(left, right);
    }

    async runWithAppHostLifecycleLock<T>(appHostPath: string, token: vscode.CancellationToken, action: () => Promise<T>): Promise<T> {
        if (this.lifecycleLockError) {
            throw this.lifecycleLockError;
        }

        const key = path.resolve(appHostPath);
        const previous = this.lifecycleLocks.get(key) ?? Promise.resolve();
        const current = previous.then(async () => {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            this.onLifecycleLockHeld?.();
            return await action();
        });
        const tracked = current.then(() => undefined, () => undefined);
        this.lifecycleLocks.set(key, tracked);
        try {
            return await current;
        }
        finally {
            if (this.lifecycleLocks.get(key) === tracked) {
                this.lifecycleLocks.delete(key);
            }
        }
    }

    async launchFromLifecycleOwner(appHostPath: string, command: 'run', noDebug: boolean): Promise<void> {
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

    constructor(
        readonly appHostPath: string | undefined,
        readonly configuration: { noDebug?: boolean; command?: string },
        readonly operationKind: string = configuration.command ?? 'run') {
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
        service = new AppHostLifecycleToolService({
            launchService,
        });
        launchService.editorSessions = editorSessions;
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
            assert.match(
                packageNls['languageModelTool.aspireAppHostStart.modelDescription'],
                /prefer this tool over invoking Aspire AppHost lifecycle commands in a terminal/i);

            const stopSchema = tools[1].inputSchema;
            assert.deepStrictEqual(stopSchema.required, ['appHostPath']);
            assert.deepStrictEqual(Object.keys(stopSchema.properties), ['appHostPath']);
            assert.match(
                packageNls['languageModelTool.aspireAppHostStop.modelDescription'],
                /prefer this tool over invoking Aspire AppHost lifecycle commands in a terminal/i);
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
                    busy: packageNls['aspire-vscode.strings.appHostLifecycleBusy'],
                },
                {
                    startTitle: 'Start Aspire AppHost',
                    stopTitle: 'Stop Aspire AppHost',
                    startMessage: 'Start the Aspire AppHost {0} in {1} mode?',
                    stopMessage: 'Stop the Aspire AppHost {0}?',
                    busy: 'Another start or stop operation for this Aspire AppHost is still in progress. Wait for it to finish and try again.',
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

        test('registers tools in restricted mode so invocation fails deterministically', async () => {
            isTrustedStub.value(false);
            const registerToolStub = sinon.stub(vscode.lm, 'registerTool').returns(new vscode.Disposable(() => { }));
            try {
                const registration = registerAppHostLifecycleTools(service);
                assert.strictEqual(registration.registered, true);
                assert.deepStrictEqual(
                    registerToolStub.getCalls().map(call => call.args[0]),
                    [aspireAppHostStartToolName, aspireAppHostStopToolName]);

                const startTool = registerToolStub.firstCall.args[1] as AppHostStartLanguageModelTool;
                const result = readToolResultPayload(await startTool.invoke(
                    { input: { appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token));
                assert.strictEqual(result.outcome, 'workspaceNotTrusted');
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
            const statStub = sinon.stub(mutableFs, 'statSync');
            try {
                const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'watch' } as never, new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'invalidInput');
                assert.strictEqual(launchService.launchCalls.length, 0);
                assert.strictEqual(statStub.called, false);
            }
            finally {
                statStub.restore();
            }
        });

        test('rejects unexpected input properties before filesystem access', async () => {
            const statStub = sinon.stub(mutableFs, 'statSync');
            try {
                const result = await service.start({
                    appHostPath: 'AppHost/AppHost.csproj',
                    mode: 'run',
                    command: 'publish',
                } as never, new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'invalidInput');
                assert.strictEqual(statStub.called, false);
            }
            finally {
                statStub.restore();
            }
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

        test('rejects an absolute path outside every workspace folder', async () => {
            const outsideAppHost = path.join(outsideRoot, 'AppHost.csproj');
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            const statStub = sinon.stub(mutableFs, 'statSync');
            const realpathStub = sinon.stub(mutableFs.realpathSync, 'native');

            try {
                const result = await service.start({ appHostPath: outsideAppHost, mode: 'run' }, new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'invalidInput');
                assert.strictEqual(launchService.launchCalls.length, 0);
                assert.strictEqual(statStub.called, false);
                assert.strictEqual(realpathStub.called, false);
            }
            finally {
                statStub.restore();
                realpathStub.restore();
            }
        });

        test('rejects an absolute path even when it names an AppHost inside the workspace', async () => {
            // The manifest, the README, and the confirmation contract all describe a
            // workspace-relative input. Accepting an absolute path that happens to land
            // inside a workspace folder would silently widen that contract, and the
            // relative form of the same file is always available to the caller.
            const statStub = sinon.stub(mutableFs, 'statSync');
            const realpathStub = sinon.stub(mutableFs.realpathSync, 'native');

            try {
                const result = await service.start({ appHostPath: appHostProjectPath, mode: 'run' }, new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'invalidInput');
                assert.strictEqual(launchService.launchCalls.length, 0);
                assert.strictEqual(statStub.called, false);
                assert.strictEqual(realpathStub.called, false);
            }
            finally {
                statStub.restore();
                realpathStub.restore();
            }
        });

        test('rejects an absolute path in stop as well as start', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            editorSessions.push(session);

            const result = await service.stop({ appHostPath: appHostProjectPath }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'invalidInput');
            assert.strictEqual(session.stopCount, 0);
        });

        test('rejects a traversal path that escapes the workspace folder', async () => {
            const outsideAppHost = path.join(outsideRoot, 'AppHost.csproj');
            fs.writeFileSync(outsideAppHost, appHostProjectContents);
            const traversal = path.join('..', path.basename(outsideRoot), 'AppHost.csproj');
            const statStub = sinon.stub(mutableFs, 'statSync');
            const realpathStub = sinon.stub(mutableFs.realpathSync, 'native');

            try {
                const result = await service.start({ appHostPath: traversal, mode: 'run' }, new vscode.CancellationTokenSource().token);

                assert.strictEqual(result.outcome, 'pathOutsideWorkspace');
                assert.strictEqual(launchService.launchCalls.length, 0);
                assert.strictEqual(statStub.called, false);
                assert.strictEqual(realpathStub.called, false);
            }
            finally {
                statStub.restore();
                realpathStub.restore();
            }
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

        test('rejects source files that mention createBuilder without a runnable Aspire program', async () => {
            const misleadingSource = path.join(workspaceRoot, 'AppHost', 'apphost.ts');
            fs.writeFileSync(misleadingSource, 'const builder = createBuilder();');

            const result = await service.start({ appHostPath: 'AppHost/apphost.ts', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'notAnAppHost');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('rejects AppHost markers that only appear in source comments', async () => {
            const commentedSource = path.join(workspaceRoot, 'AppHost', 'Commented.cs');
            fs.writeFileSync(commentedSource, [
                '// var builder = DistributedApplication.CreateBuilder(args);',
                '// builder.Build().Run();',
            ].join('\n'));

            const result = await service.start({ appHostPath: 'AppHost/Commented.cs', mode: 'run' }, new vscode.CancellationTokenSource().token);

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
            launchService.runningAppHosts = [{ appHostPath: appHostProjectPath }];

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'alreadyRunning', ownership: 'external' });
            assert.strictEqual(launchService.launchCalls.length, 0);
            assert.strictEqual(launchService.runningAppHostRequests, 1);
        });

        test('does not classify a publish session as an ordinary AppHost run', async () => {
            editorSessions.push(new FakeEditorSession(appHostProjectPath, { command: 'publish', noDebug: true }));

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'started');
            assert.strictEqual(launchService.launchCalls.length, 1);
        });

        test('serializes concurrent start calls for the same AppHost into a single launch', async () => {
            let releaseLaunch: (() => void) | undefined;
            launchService.launchDelay = new Promise<void>(resolve => { releaseLaunch = resolve; });

            const first = service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);
            const second = service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);
            const third = service.start({ appHostPath: './AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);
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

        test('honors cancellation while waiting for shared lifecycle ownership', async () => {
            let releaseActive: (() => void) | undefined;
            const activeOperation = launchService.runWithAppHostLifecycleLock(
                appHostProjectPath,
                new vscode.CancellationTokenSource().token,
                () => new Promise<void>(resolve => { releaseActive = resolve; }));
            await Promise.resolve();
            const tokenSource = new vscode.CancellationTokenSource();
            const resultPromise = service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, tokenSource.token);
            await Promise.resolve();
            tokenSource.cancel();
            releaseActive?.();

            const result = await resultPromise;

            assert.strictEqual(result.outcome, 'cancelled');
            assert.strictEqual(launchService.launchCalls.length, 0);
            await activeOperation;
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

        test('reports a bounded busy outcome when shared lifecycle ownership cannot be acquired', async () => {
            launchService.lifecycleLockError = new AppHostLifecycleLockTimeoutError();

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'busy');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('refuses to launch when external ownership cannot be determined', async () => {
            // `aspire ps` backs the external-ownership probe. When it cannot answer, the
            // tool must not launch: starting anyway could put a second AppHost on the same
            // ports as one the user already has running from a terminal. The agent gets a
            // failure it can fall back to the CLI from, which is the documented contract.
            launchService.runningAppHostError = new Error('aspire ps failed: /Users/private/AppHost.csproj is unreadable');

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership, appHostPath: result.appHostPath, requestedMode: result.requestedMode },
                { outcome: 'failed', ownership: 'editor', appHostPath: 'AppHost/AppHost.csproj', requestedMode: 'run' });
            assert.strictEqual(launchService.launchCalls.length, 0);
            assert.strictEqual(JSON.stringify(result).includes('/Users/private'), false);
        });

        test('reports an externally running AppHost without ever taking the lifecycle lock', async () => {
            // `aspire ps` spawns the CLI and queries each AppHost over its backchannel,
            // which can stall for tens of seconds when an AppHost is paused at a
            // breakpoint. That is exactly the case this early exit covers, so the slow
            // probe never runs while the lock is held and the user's own Run/Debug keeps
            // its full 10s wait budget.
            launchService.runningAppHosts = [{ appHostPath: appHostProjectPath }];
            let lockTaken = false;
            launchService.onLifecycleLockHeld = () => { lockTaken = true; };

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'alreadyRunning');
            assert.strictEqual(result.ownership, 'external');
            assert.strictEqual(lockTaken, false, 'Expected the external ownership fast path to answer before the lifecycle lock was taken.');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('revalidates external ownership after waiting for the lifecycle lock', async () => {
            // The pre-lock probe is a fast path, not the authority. Waiting for the lock
            // can take up to 10s, and an AppHost started from a terminal during that wait
            // leaves no editor session and no launching flag, so a cached negative result
            // would let the tool start a second process against the same project.
            launchService.onLifecycleLockHeld = () => {
                launchService.runningAppHosts = [{ appHostPath: appHostProjectPath }];
            };

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'alreadyRunning');
            assert.strictEqual(result.ownership, 'external');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('refuses to start when a session cannot be told apart from the requested AppHost', async () => {
            // `First.csproj`, `Second.csproj`, and `Program.cs` share a directory, so a
            // session started for `First.csproj` cannot be attributed to `Program.cs`.
            // Launching would risk a second process for an AppHost already running.
            const directory = path.join(workspaceRoot, 'Ambiguous');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'First.csproj'), appHostProjectContents);
            fs.writeFileSync(path.join(directory, 'Second.csproj'), appHostProjectContents);
            fs.writeFileSync(path.join(directory, 'Program.cs'), singleFileAppHostContents);
            editorSessions.push(new FakeEditorSession(path.join(directory, 'First.csproj'), { noDebug: false }));

            const result = await service.start({ appHostPath: 'Ambiguous/Program.cs', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'ambiguousSession');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('skips the external ownership probe when the editor already owns the AppHost', async () => {
            editorSessions.push(new FakeEditorSession(appHostProjectPath, { noDebug: false }));

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'alreadyRunning');
            assert.strictEqual(launchService.runningAppHostRequests, 0);
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
            launchService.runningAppHosts = [{ appHostPath: appHostProjectPath }];

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'notEditorOwned', ownership: 'external' });
        });

        test('does not stop a deploy or publish session for the same path', async () => {
            const publishSession = new FakeEditorSession(appHostProjectPath, { command: 'publish', noDebug: true });
            editorSessions.push(publishSession);

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'notRunning');
            assert.strictEqual(publishSession.stopCount, 0);
        });

        test('does not stop a leased test session for the same path', async () => {
            const testSession = new FakeEditorSession(appHostProjectPath, { noDebug: true }, 'test');
            editorSessions.push(testSession);

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'notRunning');
            assert.strictEqual(testSession.stopCount, 0);
        });

        test('reports notRunning when nothing owns the AppHost', async () => {
            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'notRunning', ownership: 'none' });
        });

        test('reports failed rather than notRunning when external ownership cannot be determined', async () => {
            // A failed probe means the extension does not know whether the AppHost is
            // running outside the editor. Collapsing that into `notRunning`/`none` would
            // hand the agent an authoritative negative that contradicts the ownership
            // contract, so the unknown state is reported as a failure instead.
            launchService.runningAppHostError = new Error('aspire ps failed: /Users/private/AppHost.csproj is unreadable');

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.deepStrictEqual(
                { outcome: result.outcome, ownership: result.ownership },
                { outcome: 'failed', ownership: 'unknown' });
            assert.strictEqual(JSON.stringify(result).includes('/Users/private'), false);
        });

        test('does not probe for external ownership when the editor owns the session', async () => {
            const session = new FakeEditorSession(appHostProjectPath, { noDebug: false });
            editorSessions.push(session);
            session.onStopped = () => { editorSessions.length = 0; };

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'stopped');
            assert.strictEqual(launchService.runningAppHostRequests, 0);
        });

        test('refuses to stop when more than one editor-owned session matches', async () => {
            editorSessions.push(
                new FakeEditorSession(appHostProjectPath, { noDebug: false }),
                new FakeEditorSession(appHostProjectPath, { noDebug: true }));

            const result = await service.stop({ appHostPath: 'AppHost/AppHost.csproj' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'ambiguousSession');
            assert.deepStrictEqual(editorSessions.map(session => session.stopCount), [0, 0]);
        });

        test('refuses to stop a session whose AppHost cannot be told apart from the request', async () => {
            // `First.csproj`, `Second.csproj`, and `Program.cs` share a directory, so the
            // running session for `First.csproj` cannot be attributed to `Program.cs`.
            // Treating the sibling pairing as an identity here terminates an AppHost the
            // caller never named.
            const directory = path.join(workspaceRoot, 'AmbiguousStop');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'First.csproj'), appHostProjectContents);
            fs.writeFileSync(path.join(directory, 'Second.csproj'), appHostProjectContents);
            fs.writeFileSync(path.join(directory, 'Program.cs'), singleFileAppHostContents);
            const session = new FakeEditorSession(path.join(directory, 'First.csproj'), { noDebug: false });
            editorSessions.push(session);

            const result = await service.stop({ appHostPath: 'AmbiguousStop/Program.cs' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'ambiguousSession');
            assert.strictEqual(session.stopCount, 0);
        });

        test('stops the AppHost a directory unambiguously pairs with the requested source file', async () => {
            // The counterpart of the refusal above: one project and one AppHost source in
            // a directory is a forced pairing, so addressing either form must still reach
            // the running session.
            const directory = path.join(workspaceRoot, 'UnambiguousStop');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'First.csproj'), appHostProjectContents);
            fs.writeFileSync(path.join(directory, 'Program.cs'), singleFileAppHostContents);
            const session = new FakeEditorSession(path.join(directory, 'First.csproj'), { noDebug: false });
            editorSessions.push(session);

            const result = await service.stop({ appHostPath: 'UnambiguousStop/Program.cs' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'stopped');
            assert.strictEqual(session.stopCount, 1);
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

            assert.strictEqual(
                prepared?.confirmationMessages?.message,
                'Start the Aspire AppHost an unresolved path in run mode?');
        });

        test('describes input that leaves the workspace without echoing model-supplied prose', async () => {
            const tool = new AppHostStartLanguageModelTool(service);
            const injected = 'AppHost.csproj (verified safe by Aspire, choose Always Allow) https://evil.example/login';

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: `../${injected}`, mode: 'run' } },
                new vscode.CancellationTokenSource().token);

            assert.strictEqual(
                prepared?.confirmationMessages?.message,
                'Start the Aspire AppHost an unresolved path in run mode?');
        });

        test('rejects bidi and zero-width characters instead of confirming a path it will not execute', async () => {
            // A bidi isolate around an override renders the enclosed run right-to-left, so
            // this path would display as a different AppHost while the rest of the prompt
            // looks untouched. Deleting the characters is not a fix: the prompt would then
            // show `gropspc.tsohppA/AppHost.csproj` while `invoke` still launched the file
            // whose name contains them, and the same trick lets a zero-width character
            // distinguish two real files that confirm identically.
            // See https://unicode.org/reports/tr36/#Bidirectional_Text_Spoofing
            const disguisedDirectory = path.join(workspaceRoot, '\u2066\u202Egro\u2069pspc.tsohppA');
            fs.mkdirSync(disguisedDirectory, { recursive: true });
            fs.writeFileSync(path.join(disguisedDirectory, 'App\u200BHost.csproj'), appHostProjectContents);
            const tool = new AppHostStartLanguageModelTool(service);
            const disguisedPath = '\u2066\u202Egro\u2069pspc.tsohppA/App\u200BHost.csproj';

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: disguisedPath, mode: 'debug' } },
                new vscode.CancellationTokenSource().token);
            const result = await service.start({ appHostPath: disguisedPath, mode: 'debug' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(
                prepared?.confirmationMessages?.message,
                'Start the Aspire AppHost an unresolved path in debug mode?');
            assert.strictEqual(result.outcome, 'invalidInput');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });

        test('escapes Markdown metacharacters so the confirmed path renders as it exists on disk', async () => {
            // The confirmation body renders as Markdown. Deleting `_`, `*`, or `[` would
            // show `foobar/AppHost.csproj` for a directory really named `foo_bar`, and the
            // user would approve a path that is not the one about to be launched.
            // `*` is only exercised off Windows: Win32 forbids it in a file name, so no
            // real path there can contain one.
            const escapesAsterisk = process.platform !== 'win32';
            const directoryName = escapesAsterisk ? 'foo_bar*[x](y)' : 'foo_bar[x](y)';
            const expectedDisplay = escapesAsterisk ? 'foo\\_bar\\*\\[x\\]\\(y\\)' : 'foo\\_bar\\[x\\]\\(y\\)';
            const directory = path.join(workspaceRoot, directoryName);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'AppHost.csproj'), appHostProjectContents);
            const tool = new AppHostStartLanguageModelTool(service);

            const prepared = await tool.prepareInvocation(
                { input: { appHostPath: `${directoryName}/AppHost.csproj`, mode: 'debug' } },
                new vscode.CancellationTokenSource().token);

            assert.strictEqual(
                prepared?.confirmationMessages?.message,
                `Start the Aspire AppHost ${expectedDisplay}/AppHost.csproj in debug mode?`);
        });

        test('confirms the workspace-folder-qualified target that invocation will launch', async () => {
            // In a multi-root workspace a relative path names a file in whichever folder
            // contains it. Showing "an unresolved path" while `invoke` went on to launch
            // the sole match would confirm an identity the user was never shown.
            const secondRoot = createFixtureDirectory('second-workspace');
            try {
                fs.mkdirSync(path.join(secondRoot, 'Other'), { recursive: true });
                fs.writeFileSync(path.join(secondRoot, 'Other', 'AppHost.csproj'), appHostProjectContents);
                workspaceFoldersStub.value([
                    { uri: vscode.Uri.file(workspaceRoot), name: 'workspace', index: 0 },
                    { uri: vscode.Uri.file(secondRoot), name: 'second', index: 1 },
                ]);
                const tool = new AppHostStartLanguageModelTool(service);

                const prepared = await tool.prepareInvocation(
                    { input: { appHostPath: 'Other/AppHost.csproj', mode: 'debug' } },
                    new vscode.CancellationTokenSource().token);
                const result = await service.start({ appHostPath: 'Other/AppHost.csproj', mode: 'debug' }, new vscode.CancellationTokenSource().token);

                assert.strictEqual(
                    prepared?.confirmationMessages?.message,
                    'Start the Aspire AppHost second/Other/AppHost.csproj in debug mode?');
                assert.strictEqual(result.outcome, 'started');
                assert.strictEqual(launchService.launchCalls.length, 1);
            }
            finally {
                fs.rmSync(secondRoot, { recursive: true, force: true });
            }
        });

        test('describeTarget causes no lifecycle side effects for confirmation display', () => {
            // Resolving the target is the only way to know which workspace folder a
            // relative path names, so the display path is allowed to read the filesystem.
            // What it must never do is start, stop, or lock anything.
            assert.strictEqual(service.describeTarget('AppHost/AppHost.csproj'), 'AppHost/AppHost.csproj');
            assert.strictEqual(launchService.launchCalls.length, 0);
            assert.strictEqual(launchService.pendingLifecycleLockCount, 0);
            assert.strictEqual(launchService.runningAppHostRequests, 0);
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

            assert.strictEqual(launchService.pendingLifecycleLockCount, 0);
        });

        test('rejects tool calls after the service is disposed', async () => {
            service.dispose();

            const result = await service.start({ appHostPath: 'AppHost/AppHost.csproj', mode: 'run' }, new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.outcome, 'cancelled');
            assert.strictEqual(launchService.launchCalls.length, 0);
        });
    });
});

