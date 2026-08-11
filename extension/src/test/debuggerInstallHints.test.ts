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
import { debuggerInstallAction, dontShowAgainLabel } from '../loc/strings';
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
        const getExtension = sinon.stub(vscode.extensions, 'getExtension');
        getExtension.onFirstCall().returns(undefined);
        getExtension.returns({ id: 'ms-python.debugpy' } as vscode.Extension<unknown>);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sinon.stub(vscode.commands, 'executeCommand').resolves();
        const service = new DebuggerInstallHintService(createMemento());

        await service.installDebuggerExtension({
            debuggerName: 'Python',
            extensionId: 'ms-python.debugpy',
        });

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
