/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    DebuggerInstallHintService,
    getDebuggerInstallHintForResource,
    launchConfigurationTypePropertyName,
} from '../debugger/debuggerInstallHints';
import { getSupportedCapabilities } from '../capabilities';
import { debuggerInstallAction, dontShowAgainLabel, errorMessage } from '../loc/strings';
import { ResourceState } from '../editor/resourceConstants';

function createResource(
    launchConfigurationType?: string,
    state: string = ResourceState.Running,
): { state: string; properties: Record<string, string | null> } {
    return {
        state,
        properties: launchConfigurationType !== undefined
            ? { [launchConfigurationTypePropertyName]: launchConfigurationType }
            : {},
    };
}

function createMemento(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue,
        update: (key: string, value: unknown) => {
            value === undefined ? values.delete(key) : values.set(key, value);
            return Promise.resolve();
        },
    };
}

suite('debugger install hints', () => {
    teardown(() => sinon.restore());

    test('maps the supported missing debugger extensions', () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);

        assert.deepStrictEqual(
            ['python', 'go', 'bun', 'java'].map(type =>
                getDebuggerInstallHintForResource(createResource(type))),
            [
                {
                    debuggerName: 'Python',
                    debuggerType: 'python',
                    extensionIds: ['ms-python.debugpy'],
                },
                {
                    debuggerName: 'Go',
                    debuggerType: 'go',
                    extensionIds: ['golang.go'],
                },
                {
                    debuggerName: 'Bun',
                    debuggerType: 'bun',
                    extensionIds: ['oven.bun-vscode'],
                },
                {
                    debuggerName: 'Java',
                    debuggerType: 'java',
                    extensionIds: ['redhat.java', 'vscjava.vscode-java-debug'],
                },
            ]);
    });

    test('recommends CodeLLDB for Rust on Windows when no debugger adapter is installed', () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);

        assert.deepStrictEqual(
            getDebuggerInstallHintForResource(createResource('rust'), 'win32'),
            {
                debuggerName: 'Rust',
                debuggerType: 'rust',
                extensionIds: ['vadimcn.vscode-lldb'],
            });
    });

    test('returns no Rust hint on Windows when the C++ debugger is installed', () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            extensionId === 'ms-vscode.cpptools' ? { id: extensionId } as vscode.Extension<unknown> : undefined);

        assert.strictEqual(
            getDebuggerInstallHintForResource(createResource('rust'), 'win32'),
            undefined);
    });

    test('returns no Rust hint on Windows when CodeLLDB is installed', () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            extensionId === 'vadimcn.vscode-lldb' ? { id: extensionId } as vscode.Extension<unknown> : undefined);

        assert.strictEqual(
            getDebuggerInstallHintForResource(createResource('rust'), 'win32'),
            undefined);
    });

    test('recommends CodeLLDB for Rust on Linux and macOS', () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);

        assert.deepStrictEqual(
            getDebuggerInstallHintForResource(createResource('rust'), 'linux'),
            {
                debuggerName: 'Rust',
                debuggerType: 'rust',
                extensionIds: ['vadimcn.vscode-lldb'],
            });
        assert.deepStrictEqual(
            getDebuggerInstallHintForResource(createResource('rust'), 'darwin'),
            {
                debuggerName: 'Rust',
                debuggerType: 'rust',
                extensionIds: ['vadimcn.vscode-lldb'],
            });
    });

    test('returns no hint for missing, empty, unknown, or fully installed debugger types', () => {
        const installedExtensionIds = new Set(['redhat.java', 'vscjava.vscode-java-debug']);
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            installedExtensionIds.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined);

        assert.deepStrictEqual(
            [
                createResource(),
                createResource(''),
                createResource('project'),
                createResource('java'),
            ].map(resource => getDebuggerInstallHintForResource(resource)),
            [undefined, undefined, undefined, undefined]);
    });

    test('returns the complete Java hint when any required extension is missing', () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            extensionId === 'redhat.java' ? { id: extensionId } as vscode.Extension<unknown> : undefined);

        assert.deepStrictEqual(
            getDebuggerInstallHintForResource(createResource('java')),
            {
                debuggerName: 'Java',
                debuggerType: 'java',
                extensionIds: ['redhat.java', 'vscjava.vscode-java-debug'],
            });
    });

    test('keeps debugger product names out of localization resources', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const packageNls = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;

        assert.deepStrictEqual(
            ['pythonDebuggerName', 'goDebuggerName', 'bunDebuggerName', 'javaDebuggerName', 'rustDebuggerName'].map(name =>
                packageNls[`aspire-vscode.strings.${name}`]),
            [undefined, undefined, undefined, undefined, undefined]);
    });

    test('recognizes the standalone debugpy extension as Python debug support', () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            extensionId === 'ms-python.debugpy' ? { id: extensionId } as vscode.Extension<unknown> : undefined);

        assert.ok(getSupportedCapabilities().includes('python'));
    });

    test('shows one install notification and installs the selected debugger', async () => {
        let installed = false;
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            installed ? { id: extensionId } as vscode.Extension<unknown> : undefined);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage');
        showInformationMessage.onFirstCall().resolves(debuggerInstallAction as any);
        showInformationMessage.onSecondCall().resolves(undefined);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').callsFake(async () => {
            installed = true;
        });
        const service = new DebuggerInstallHintService(createMemento());

        await service.notifyMissingDebuggers([
            createResource('python'),
            createResource('python'),
            createResource('go', ResourceState.Stopped),
            createResource(),
        ]);

        assert.strictEqual(showInformationMessage.callCount, 2);
        assert.strictEqual(showInformationMessage.firstCall.args[0], 'Install the Python debugger extension to debug resources in this app.');
        assert.deepStrictEqual(showInformationMessage.firstCall.args.slice(1), [debuggerInstallAction, dontShowAgainLabel]);
        assert.ok(executeCommand.calledOnceWithExactly('workbench.extensions.installExtension', 'ms-python.debugpy'));
        assert.strictEqual(showInformationMessage.secondCall.args[0], 'The Python debugger extension is installed. Restart the AppHost to enable debugging.');
    });

    test('waits for a fresh install to appear in the extension registry', async () => {
        let installed = false;
        let extensionChangeListener: (() => unknown) | undefined;
        let subscriptionRegisteredResolve!: () => void;
        const subscriptionRegistered = new Promise<void>(resolve => subscriptionRegisteredResolve = resolve);
        const getExtension = sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            installed ? { id: extensionId } as vscode.Extension<unknown> : undefined);
        const onDidChange: vscode.Event<void> = listener => {
            extensionChangeListener = listener;
            subscriptionRegisteredResolve();
            return { dispose: sinon.stub() };
        };
        sinon.stub(vscode.extensions, 'onDidChange').get(() => onDidChange);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sinon.stub(vscode.commands, 'executeCommand').resolves();
        const service = new DebuggerInstallHintService(createMemento());

        const installation = service.installDebuggerExtension({
            debuggerName: 'Python',
            debuggerType: 'python',
            extensionIds: ['ms-python.debugpy'],
        });
        await subscriptionRegistered;

        assert.strictEqual(showInformationMessage.callCount, 0);

        installed = true;
        assert.ok(extensionChangeListener);
        extensionChangeListener();
        await installation;

        assert.ok(getExtension.calledWith('ms-python.debugpy'));
        assert.strictEqual(showInformationMessage.callCount, 1);
        assert.strictEqual(
            showInformationMessage.firstCall.args[0],
            'The Python debugger extension is installed. Restart the AppHost to enable debugging.');
    });

    test('reports a disabled debugger extension instead of claiming installation succeeded', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const getExtension = sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        sinon.stub(vscode.extensions, 'onDidChange').returns({ dispose: sinon.stub() });
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();
        const service = new DebuggerInstallHintService(createMemento());

        const installation = service.installDebuggerExtension({
            debuggerName: 'Python',
            debuggerType: 'python',
            extensionIds: ['ms-python.debugpy'],
        });
        await clock.tickAsync(5_000);
        await installation;

        assert.ok(executeCommand.calledOnceWithExactly('workbench.extensions.installExtension', 'ms-python.debugpy'));
        assert.ok(getExtension.calledWith('ms-python.debugpy'));
        assert.strictEqual(
            showInformationMessage.firstCall.args[0],
            'The Python debugger extension is disabled. Enable it in VS Code, then restart the AppHost to enable debugging.');
    });

    test('reports debugger installation failures as handled command failures', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        const showErrorMessage = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const error = new TypeError('Debugger installation failed.');
        sinon.stub(vscode.commands, 'executeCommand').rejects(error);
        const service = new DebuggerInstallHintService(createMemento());

        const result = await service.installDebuggerExtension({
            debuggerName: 'Python',
            debuggerType: 'python',
            extensionIds: ['ms-python.debugpy'],
        });

        assert.deepStrictEqual(result, { success: false, errorKind: 'TypeError' });
        assert.strictEqual(showErrorMessage.callCount, 1);
        assert.strictEqual(showErrorMessage.firstCall.args[0], errorMessage(error));
        assert.strictEqual(showInformationMessage.callCount, 0);
    });

    test('installs only the missing Java debugger requirement', async () => {
        const registeredExtensionIds = new Set(['redhat.java']);
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            registeredExtensionIds.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').callsFake(async (_command, extensionId) => {
            registeredExtensionIds.add(extensionId as string);
        });
        const service = new DebuggerInstallHintService(createMemento());

        await service.installDebuggerExtension({
            debuggerName: 'Java',
            debuggerType: 'java',
            extensionIds: ['redhat.java', 'vscjava.vscode-java-debug'],
        });

        assert.ok(executeCommand.calledOnceWithExactly(
            'workbench.extensions.installExtension',
            'vscjava.vscode-java-debug'));
        assert.strictEqual(showInformationMessage.callCount, 1);
        assert.strictEqual(
            showInformationMessage.firstCall.args[0],
            'The Java debugger extension is installed. Restart the AppHost to enable debugging.');
    });

    test('installs all missing Java requirements sequentially and waits for every registration', async () => {
        const registeredExtensionIds = new Set<string>();
        let extensionChangeListener: (() => unknown) | undefined;
        let subscriptionRegisteredResolve!: () => void;
        const subscriptionRegistered = new Promise<void>(resolve => subscriptionRegisteredResolve = resolve);
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            registeredExtensionIds.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined);
        const onDidChange: vscode.Event<void> = listener => {
            extensionChangeListener = listener;
            subscriptionRegisteredResolve();
            return { dispose: sinon.stub() };
        };
        sinon.stub(vscode.extensions, 'onDidChange').get(() => onDidChange);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        let firstInstallResolve!: () => void;
        const firstInstall = new Promise<void>(resolve => firstInstallResolve = resolve);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand');
        executeCommand.onFirstCall().returns(firstInstall);
        executeCommand.onSecondCall().resolves();
        const service = new DebuggerInstallHintService(createMemento());

        const installation = service.installDebuggerExtension({
            debuggerName: 'Java',
            debuggerType: 'java',
            extensionIds: ['redhat.java', 'vscjava.vscode-java-debug'],
        });
        await Promise.resolve();

        assert.ok(executeCommand.firstCall.calledWithExactly(
            'workbench.extensions.installExtension',
            'redhat.java'));
        assert.strictEqual(executeCommand.callCount, 1);

        firstInstallResolve();
        await subscriptionRegistered;

        assert.ok(executeCommand.secondCall.calledWithExactly(
            'workbench.extensions.installExtension',
            'vscjava.vscode-java-debug'));
        assert.ok(extensionChangeListener);
        assert.strictEqual(showInformationMessage.callCount, 0);

        registeredExtensionIds.add('redhat.java');
        extensionChangeListener();
        await Promise.resolve();
        assert.strictEqual(showInformationMessage.callCount, 0);

        registeredExtensionIds.add('vscjava.vscode-java-debug');
        extensionChangeListener();
        await installation;

        assert.strictEqual(showInformationMessage.callCount, 1);
        assert.strictEqual(
            showInformationMessage.firstCall.args[0],
            'The Java debugger extension is installed. Restart the AppHost to enable debugging.');
    });

    test('starts background observation only after discovering an AppHost candidate', () => {
        const dataChanges = new vscode.EventEmitter<void>();
        const candidatePaths: string[] = [];
        const keepDataActive = sinon.stub().returns({ dispose: sinon.stub() });
        const service = new DebuggerInstallHintService(createMemento());
        const observation = service.watchForMissingDebuggers({
            get workspaceAppHostCandidatePaths() {
                return candidatePaths;
            },
            workspaceResources: [],
            appHosts: [],
            onDidChangeData: dataChanges.event,
            keepDataActive,
        });

        try {
            assert.strictEqual(keepDataActive.callCount, 0);

            candidatePaths.push('/workspace/AppHost.csproj');
            dataChanges.fire();

            assert.strictEqual(keepDataActive.callCount, 1);
        } finally {
            observation.dispose();
            dataChanges.dispose();
        }
    });

    test('stops background observation after the last AppHost candidate is removed', () => {
        const dataChanges = new vscode.EventEmitter<void>();
        const candidatePaths = ['/workspace/AppHost.csproj'];
        const dataLease = { dispose: sinon.stub() };
        const service = new DebuggerInstallHintService(createMemento());
        const observation = service.watchForMissingDebuggers({
            get workspaceAppHostCandidatePaths() {
                return candidatePaths;
            },
            workspaceResources: [],
            appHosts: [],
            onDidChangeData: dataChanges.event,
            keepDataActive: sinon.stub().returns(dataLease),
        });

        try {
            assert.strictEqual(dataLease.dispose.callCount, 0);

            candidatePaths.splice(0);
            dataChanges.fire();

            assert.strictEqual(dataLease.dispose.callCount, 1);
        } finally {
            observation.dispose();
            dataChanges.dispose();
        }
    });

    test("Don't Show Again suppresses future sessions for that debugger", async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(dontShowAgainLabel as any);
        const globalState = createMemento();

        const firstService = new DebuggerInstallHintService(globalState);
        await firstService.notifyMissingDebuggers([createResource('go')]);

        const secondService = new DebuggerInstallHintService(globalState);
        await secondService.notifyMissingDebuggers([createResource('go')]);

        assert.strictEqual(showInformationMessage.callCount, 1);
    });

    test('uses stable logical debugger types for notification suppression', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(dontShowAgainLabel as any);
        const globalState = createMemento();
        const service = new DebuggerInstallHintService(globalState);

        await service.notifyMissingDebuggers([
            createResource('java'),
            createResource('java'),
            createResource('rust'),
        ]);

        assert.strictEqual(showInformationMessage.callCount, 2);
        assert.deepStrictEqual(
            [...globalState.keys()].sort(),
            [
                'aspire.debuggerInstallHint.suppressed.java',
                'aspire.debuggerInstallHint.suppressed.rust',
            ]);
    });
});
