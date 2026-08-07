/// <reference types="mocha" />

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { DebuggerInstallHintService } from '../debugger/debuggerInstallHints';
import { createDebuggerInstallHintWatcher, DebuggerInstallHintWatcher } from '../editor/DebuggerInstallHintWatcher';
import * as appHostResourceParser from '../editor/parsers/AppHostResourceParser';
import { ResourceState } from '../editor/resourceConstants';
import { AppHostDataRepository, AppHostDisplayInfo, ResourceJson } from '../views/AppHostDataRepository';

function createTestMemento(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue,
        update: (key: string, value: unknown) => {
            values.set(key, value);
            return Promise.resolve();
        },
        setKeysForSync: () => { },
    } as vscode.Memento;
}

function makeResource(name: string, state: string = ResourceState.Running, displayName: string = name): ResourceJson {
    return {
        name,
        displayName,
        resourceType: 'Executable',
        state,
        stateStyle: '',
        healthStatus: null,
        healthReports: null,
        exitCode: null,
        dashboardUrl: null,
        urls: null,
        commands: null,
        properties: null,
    };
}

function makeParsedResource(name: string, methodName: string): appHostResourceParser.ParsedResource {
    return {
        name,
        methodName,
        range: new vscode.Range(0, 0, 0, 0),
        kind: 'resource',
    };
}

function createRepository(
    changes: vscode.EventEmitter<void>,
    appHosts: readonly AppHostDisplayInfo[],
    workspaceResources: readonly ResourceJson[] = [],
    workspaceAppHostPath?: string,
): AppHostDataRepository {
    return {
        onDidChangeData: changes.event,
        get appHosts() {
            return appHosts;
        },
        get workspaceResources() {
            return workspaceResources;
        },
        get workspaceAppHostPath() {
            return workspaceAppHostPath;
        },
    } as AppHostDataRepository;
}

function createHintService(showInformationMessage: sinon.SinonStub, installedExtensions: Iterable<string> = []): {
    service: DebuggerInstallHintService;
    extensionChanges: vscode.EventEmitter<void>;
} {
    const installed = new Set(installedExtensions);
    const extensionChanges = new vscode.EventEmitter<void>();
    return {
        service: new DebuggerInstallHintService(createTestMemento(), {
            getExtension: extensionId => installed.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined,
            onDidChangeExtensions: extensionChanges.event,
            showInformationMessage,
            installExtension: () => Promise.resolve(),
        }),
        extensionChanges,
    };
}

suite('DebuggerInstallHintWatcher', () => {
    teardown(() => sinon.restore());

    test('parses a running AppHost source and shows a missing debugger notification', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const appHostPath = '/repo/AppHost/AppHost.csproj';
        const repository = createRepository(repositoryChanges, [{
            appHostPath,
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('python-hkarnukm', ResourceState.Running, 'python')],
        }]);
        let resolveNotificationShown!: () => void;
        const notificationShown = new Promise<void>(resolve => resolveNotificationShown = resolve);
        const showInformationMessage = sinon.stub().callsFake(() => {
            resolveNotificationShown();
            return Promise.resolve(undefined);
        });
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const parseAppHostResources = sinon.stub().resolves([makeParsedResource('python', 'AddPythonApp')]);
        const watcher = new DebuggerInstallHintWatcher(repository, service, {
            parseAppHostResources,
            reportError: error => assert.fail(String(error)),
        });

        repositoryChanges.fire();
        await notificationShown;

        assert.ok(parseAppHostResources.calledOnceWithExactly(appHostPath));
        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('uses workspace describe resources when the AppHost snapshot has no resources', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const appHostPath = '/repo/AppHost/AppHost.csproj';
        const repository = createRepository(repositoryChanges, [{
            appHostPath,
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [],
        }], [makeResource('go')], appHostPath);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const watcher = new DebuggerInstallHintWatcher(repository, service, {
            parseAppHostResources: () => Promise.resolve([makeParsedResource('go', 'AddGoApp')]),
            reportError: error => assert.fail(String(error)),
        });

        await watcher.refresh();

        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('ignores stopped, unsupported, and installed debugger resources', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const repository = createRepository(repositoryChanges, [{
            appHostPath: '/repo/AppHost/AppHost.csproj',
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [
                makeResource('stopped-python', ResourceState.Stopped),
                makeResource('container'),
                makeResource('installed-bun'),
            ],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage, ['oven.bun-vscode']);
        const watcher = new DebuggerInstallHintWatcher(repository, service, {
            parseAppHostResources: () => Promise.resolve([
                makeParsedResource('stopped-python', 'AddPythonApp'),
                makeParsedResource('container', 'AddContainer'),
                makeParsedResource('installed-bun', 'AddBunApp'),
            ]),
            reportError: error => assert.fail(String(error)),
        });

        await watcher.refresh();

        assert.strictEqual(showInformationMessage.callCount, 0);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('shows one notification for the same missing debugger across AppHosts and resources', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const repository = createRepository(repositoryChanges, [
            {
                appHostPath: '/repo/First/AppHost.csproj',
                appHostPid: 123,
                cliPid: null,
                dashboardUrl: null,
                resources: [makeResource('python-one'), makeResource('python-two')],
            },
            {
                appHostPath: '/repo/Second/AppHost.csproj',
                appHostPid: 456,
                cliPid: null,
                dashboardUrl: null,
                resources: [makeResource('python-three')],
            },
        ]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const parseAppHostResources = sinon.stub();
        parseAppHostResources.onFirstCall().resolves([
            makeParsedResource('python-one', 'AddPythonApp'),
            makeParsedResource('python-two', 'AddPythonModule'),
        ]);
        parseAppHostResources.onSecondCall().resolves([
            makeParsedResource('python-three', 'AddUvicornApp'),
        ]);
        const watcher = new DebuggerInstallHintWatcher(repository, service, {
            parseAppHostResources,
            reportError: error => assert.fail(String(error)),
        });

        await watcher.refresh();

        assert.strictEqual(parseAppHostResources.callCount, 2);
        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('does not show a notification when disposed during parsing', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const repository = createRepository(repositoryChanges, [{
            appHostPath: '/repo/AppHost/AppHost.csproj',
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('python')],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        let resolveParsingStarted!: () => void;
        let resolveParsedResources!: (resources: readonly appHostResourceParser.ParsedResource[]) => void;
        const parsingStarted = new Promise<void>(resolve => resolveParsingStarted = resolve);
        const parsedResources = new Promise<readonly appHostResourceParser.ParsedResource[]>(resolve => resolveParsedResources = resolve);
        const watcher = new DebuggerInstallHintWatcher(repository, service, {
            parseAppHostResources: () => {
                resolveParsingStarted();
                return parsedResources;
            },
            reportError: error => assert.fail(String(error)),
        });

        const refresh = watcher.refresh();
        await parsingStarted;
        watcher.dispose();
        resolveParsedResources([makeParsedResource('python', 'AddPythonApp')]);
        await refresh;

        assert.strictEqual(showInformationMessage.callCount, 0);
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('dispose removes repository and extension listeners', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const repository = createRepository(repositoryChanges, [{
            appHostPath: '/repo/AppHost/AppHost.csproj',
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('python')],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const parseAppHostResources = sinon.stub().resolves([makeParsedResource('python', 'AddPythonApp')]);
        const watcher = new DebuggerInstallHintWatcher(repository, service, {
            parseAppHostResources,
            reportError: error => assert.fail(String(error)),
        });

        watcher.dispose();
        repositoryChanges.fire();
        extensionChanges.fire();
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(parseAppHostResources.callCount, 0);
        assert.strictEqual(showInformationMessage.callCount, 0);
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('reparses an AppHost source reopened at the same document version', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const sourcePath = '/repo/AppHost/AppHost.cs';
        const repository = createRepository(repositoryChanges, [{
            appHostPath: sourcePath,
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('second')],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const uri = vscode.Uri.file(sourcePath);
        const firstDocument = { uri, version: 1, resourceName: 'first' } as unknown as vscode.TextDocument;
        const secondDocument = { uri, version: 1, resourceName: 'second' } as unknown as vscode.TextDocument;
        const openTextDocument = sinon.stub(vscode.workspace, 'openTextDocument');
        openTextDocument.onFirstCall().resolves(firstDocument);
        openTextDocument.onSecondCall().resolves(secondDocument);
        const parser: appHostResourceParser.AppHostResourceParser = {
            getSupportedExtensions: () => ['.cs'],
            isAppHostFile: () => Promise.resolve(true),
            parseResources: document => Promise.resolve([
                makeParsedResource((document as unknown as { resourceName: string }).resourceName, 'AddPythonApp'),
            ]),
        };
        const getParserForDocument = sinon.stub(appHostResourceParser, 'getParserForDocument').resolves(parser);
        const watcher = createDebuggerInstallHintWatcher(repository, service);

        await watcher.refresh();
        assert.strictEqual(showInformationMessage.callCount, 0);

        await watcher.refresh();

        assert.strictEqual(getParserForDocument.callCount, 2);
        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('reevaluates parser eligibility after the AppHost source changes', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const sourcePath = '/repo/AppHost/AppHost.cs';
        const repository = createRepository(repositoryChanges, [{
            appHostPath: sourcePath,
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('python')],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const document = {
            uri: vscode.Uri.file(sourcePath),
            version: 1,
        } as unknown as vscode.TextDocument;
        sinon.stub(vscode.workspace, 'openTextDocument').resolves(document);
        const parser: appHostResourceParser.AppHostResourceParser = {
            getSupportedExtensions: () => ['.cs'],
            isAppHostFile: () => Promise.resolve(true),
            parseResources: () => Promise.resolve([makeParsedResource('python', 'AddPythonApp')]),
        };
        const getParserForDocument = sinon.stub(appHostResourceParser, 'getParserForDocument');
        getParserForDocument.onFirstCall().resolves(undefined);
        getParserForDocument.onSecondCall().resolves(parser);
        const watcher = createDebuggerInstallHintWatcher(repository, service);

        await watcher.refresh();
        assert.strictEqual(showInformationMessage.callCount, 0);

        (document as unknown as { version: number }).version = 2;
        await watcher.refresh();

        assert.strictEqual(getParserForDocument.callCount, 2);
        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('retries parsing when the AppHost source changes during parsing', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const sourcePath = '/repo/AppHost/AppHost.cs';
        const repository = createRepository(repositoryChanges, [{
            appHostPath: sourcePath,
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('python')],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const document = {
            uri: vscode.Uri.file(sourcePath),
            version: 1,
        } as unknown as vscode.TextDocument;
        sinon.stub(vscode.workspace, 'openTextDocument').resolves(document);
        const parseResources = sinon.stub();
        parseResources.onFirstCall().callsFake(() => {
            (document as unknown as { version: number }).version = 2;
            return Promise.resolve([makeParsedResource('old-python', 'AddPythonApp')]);
        });
        parseResources.onSecondCall().resolves([makeParsedResource('python', 'AddPythonApp')]);
        const parser: appHostResourceParser.AppHostResourceParser = {
            getSupportedExtensions: () => ['.cs'],
            isAppHostFile: () => Promise.resolve(true),
            parseResources,
        };
        sinon.stub(appHostResourceParser, 'getParserForDocument').resolves(parser);
        const watcher = createDebuggerInstallHintWatcher(repository, service);

        await watcher.refresh();

        assert.strictEqual(parseResources.callCount, 2);
        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });

    test('reopens the AppHost source when the document closes during parsing', async () => {
        const repositoryChanges = new vscode.EventEmitter<void>();
        const sourcePath = '/repo/AppHost/AppHost.cs';
        const repository = createRepository(repositoryChanges, [{
            appHostPath: sourcePath,
            appHostPid: 123,
            cliPid: null,
            dashboardUrl: null,
            resources: [makeResource('python')],
        }]);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { service, extensionChanges } = createHintService(showInformationMessage);
        const uri = vscode.Uri.file(sourcePath);
        const firstDocument = {
            uri,
            version: 1,
            isClosed: false,
        } as unknown as vscode.TextDocument;
        const secondDocument = {
            uri,
            version: 1,
            isClosed: false,
        } as unknown as vscode.TextDocument;
        const openTextDocument = sinon.stub(vscode.workspace, 'openTextDocument');
        openTextDocument.onFirstCall().resolves(firstDocument);
        openTextDocument.onSecondCall().resolves(secondDocument);
        const parseResources = sinon.stub();
        parseResources.onFirstCall().callsFake(() => {
            (firstDocument as unknown as { isClosed: boolean }).isClosed = true;
            return Promise.resolve([makeParsedResource('old-python', 'AddPythonApp')]);
        });
        parseResources.onSecondCall().resolves([makeParsedResource('python', 'AddPythonApp')]);
        const parser: appHostResourceParser.AppHostResourceParser = {
            getSupportedExtensions: () => ['.cs'],
            isAppHostFile: () => Promise.resolve(true),
            parseResources,
        };
        sinon.stub(appHostResourceParser, 'getParserForDocument').resolves(parser);
        const watcher = createDebuggerInstallHintWatcher(repository, service);

        await watcher.refresh();

        assert.strictEqual(openTextDocument.callCount, 2);
        assert.strictEqual(parseResources.callCount, 2);
        assert.strictEqual(showInformationMessage.callCount, 1);
        watcher.dispose();
        service.dispose();
        extensionChanges.dispose();
        repositoryChanges.dispose();
    });
});
