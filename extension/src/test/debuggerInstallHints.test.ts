/// <reference types="mocha" />

import * as assert from 'assert';
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

    test('recognizes the standalone debugpy extension as Python debug support', () => {
        sinon.stub(vscode.extensions, 'getExtension').callsFake(extensionId =>
            extensionId === 'ms-python.debugpy' ? { id: extensionId } as vscode.Extension<unknown> : undefined);

        assert.ok(getSupportedCapabilities().includes('python'));
    });

    test('shows one install notification and installs the selected debugger', async () => {
        sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
        const showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage');
        showInformationMessage.onFirstCall().resolves(debuggerInstallAction as any);
        showInformationMessage.onSecondCall().resolves(undefined);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();
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
