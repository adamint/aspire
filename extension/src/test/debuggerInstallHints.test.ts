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
        properties: launchConfigurationType
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

    test('maps only the supported missing debugger extensions', () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);

        assert.deepStrictEqual(
            ['python', 'go', 'bun', 'project', undefined].map(type => {
                const hint = getDebuggerInstallHintForResource(createResource(type));
                return hint && [hint.debuggerName, hint.extensionId];
            }),
            [
                ['Python', 'ms-python.debugpy'],
                ['Go', 'golang.go'],
                ['Bun', 'oven.bun-vscode'],
                undefined,
                undefined,
            ]);
    });

    test('keeps debugger product names out of localization resources', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const packageNls = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;

        assert.deepStrictEqual(
            ['pythonDebuggerName', 'goDebuggerName', 'bunDebuggerName'].map(name =>
                packageNls[`aspire-vscode.strings.${name}`]),
            [undefined, undefined, undefined]);
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
            extensionId: 'ms-python.debugpy',
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
            extensionId: 'ms-python.debugpy',
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
            extensionId: 'ms-python.debugpy',
        });

        assert.deepStrictEqual(result, { success: false, errorKind: 'TypeError' });
        assert.strictEqual(showErrorMessage.callCount, 1);
        assert.strictEqual(showErrorMessage.firstCall.args[0], errorMessage(error));
        assert.strictEqual(showInformationMessage.callCount, 0);
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
});
