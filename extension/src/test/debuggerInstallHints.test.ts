/// <reference types="mocha" />

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getSupportedCapabilities } from '../capabilities';
import {
    DebuggerInstallHintService,
    DebuggerInstallHintServiceDependencies,
    getDebuggerInstallHint,
    getDebuggerInstallHintForExtension,
    installDebuggerExtension,
} from '../debugger/debuggerInstallHints';
import { bunDebuggerExtension } from '../debugger/languages/bun';
import { goDebuggerExtension } from '../debugger/languages/go';
import { pythonDebuggerExtension } from '../debugger/languages/python';
import {
    debuggerInstallAction,
    debuggerInstallDontShowAgain,
    debuggerInstalledRestartAppHost,
    debuggerInstallFailed,
} from '../loc/strings';

function createTestMemento(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue,
        update: (key: string, value: unknown) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, value);
            }
            return Promise.resolve();
        },
        setKeysForSync: () => { },
    } as vscode.Memento;
}

function createDependencies(overrides: Partial<DebuggerInstallHintServiceDependencies> = {}): {
    dependencies: DebuggerInstallHintServiceDependencies;
    extensionChanges: vscode.EventEmitter<void>;
} {
    const extensionChanges = new vscode.EventEmitter<void>();
    return {
        dependencies: {
            getExtension: () => undefined,
            onDidChangeExtensions: extensionChanges.event,
            showInformationMessage: () => Promise.resolve(undefined),
            showErrorMessage: () => Promise.resolve(undefined),
            installExtension: () => Promise.resolve(),
            ...overrides,
        },
        extensionChanges,
    };
}

suite('debugger install hints', () => {
    teardown(() => sinon.restore());

    test('maps current C# and TypeScript AppHost methods to debugger extensions', () => {
        const mappings = [
            ['AddPythonApp', 'ms-python.debugpy', 'Python'],
            ['AddPythonModule', 'ms-python.debugpy', 'Python'],
            ['AddUvicornApp', 'ms-python.debugpy', 'Python'],
            ['addPythonApp', 'ms-python.debugpy', 'Python'],
            ['addPythonModule', 'ms-python.debugpy', 'Python'],
            ['addUvicornApp', 'ms-python.debugpy', 'Python'],
            ['AddGoApp', 'golang.go', 'Go'],
            ['addGoApp', 'golang.go', 'Go'],
            ['AddBunApp', 'oven.bun-vscode', 'Bun'],
            ['addBunApp', 'oven.bun-vscode', 'Bun'],
        ];

        assert.deepStrictEqual(
            mappings.map(([methodName]) => {
                const hint = getDebuggerInstallHint(methodName);
                return [methodName, hint?.extensionId, hint?.debuggerName];
            }),
            mappings);
        assert.strictEqual(getDebuggerInstallHint('AddNodeApp'), undefined);
        assert.strictEqual(getDebuggerInstallHint('AddPythonExecutable'), undefined);
        assert.strictEqual(getDebuggerInstallHint('addPythonExecutable'), undefined);
        assert.strictEqual(getDebuggerInstallHint('addPythonScript'), undefined);
    });

    test('reuses the extension ids registered by the resource debugger extensions', () => {
        assert.deepStrictEqual(
            [
                getDebuggerInstallHint('AddPythonApp')?.extensionId,
                getDebuggerInstallHint('AddGoApp')?.extensionId,
                getDebuggerInstallHint('AddBunApp')?.extensionId,
            ],
            [
                pythonDebuggerExtension.extensionId,
                goDebuggerExtension.extensionId,
                bunDebuggerExtension.extensionId,
            ]);
        assert.deepStrictEqual(
            [
                getDebuggerInstallHintForExtension('ms-python.debugpy'),
                getDebuggerInstallHintForExtension('golang.go'),
                getDebuggerInstallHintForExtension('oven.bun-vscode'),
                getDebuggerInstallHintForExtension('ms-dotnettools.csharp'),
            ],
            [
                { debuggerName: 'Python', extensionId: 'ms-python.debugpy' },
                { debuggerName: 'Go', extensionId: 'golang.go' },
                { debuggerName: 'Bun', extensionId: 'oven.bun-vscode' },
                undefined,
            ]);
    });

    test('only returns hints while the debugger extension is missing', () => {
        const installed = new Set(['ms-python.debugpy']);
        const { dependencies, extensionChanges } = createDependencies({
            getExtension: extensionId => installed.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined,
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        assert.strictEqual(service.getMissingDebugger('AddPythonApp'), undefined);
        assert.strictEqual(service.getMissingDebugger('AddGoApp')?.extensionId, 'golang.go');

        service.dispose();
        extensionChanges.dispose();
    });

    test('shows one notification per missing extension id in an extension session', async () => {
        const globalState = createTestMemento();
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({ showInformationMessage });
        const service = new DebuggerInstallHintService(globalState, dependencies);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);
        await service.showNotificationIfNeeded(getDebuggerInstallHint('addPythonModule')!, 1);
        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddGoApp')!, 1);
        await service.showNotificationIfNeeded(getDebuggerInstallHint('addGoApp')!, 1);

        assert.strictEqual(showInformationMessage.callCount, 2);
        service.dispose();
        extensionChanges.dispose();
    });

    test('reports the number of affected resources in the notification', async () => {
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({ showInformationMessage });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);
        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddGoApp')!, 4);
        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddBunApp')!, 2);

        assert.deepStrictEqual(
            showInformationMessage.args.map(args => args[0]),
            [
                'Debug 1 Aspire resource by installing the Python debugger extension.',
                'Debug 4 Aspire resources by installing the Go debugger extension.',
                'Debug 2 Aspire resources by installing the Bun debugger extension.',
            ]);

        service.dispose();
        extensionChanges.dispose();
    });

    test('keeps the count from the notification it actually showed', async () => {
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({ showInformationMessage });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);
        const hint = getDebuggerInstallHint('AddPythonApp')!;

        await service.showNotificationIfNeeded(hint, 2);
        await service.showNotificationIfNeeded(hint, 5);

        assert.deepStrictEqual(
            showInformationMessage.args.map(args => args[0]),
            ['Debug 2 Aspire resources by installing the Python debugger extension.']);

        service.dispose();
        extensionChanges.dispose();
    });

    test('coalesces concurrent notifications for the same missing extension', async () => {
        let resolveNotification!: (selection: string | undefined) => void;
        const notification = new Promise<string | undefined>(resolve => resolveNotification = resolve);
        const showInformationMessage = sinon.stub().returns(notification);
        const { dependencies, extensionChanges } = createDependencies({ showInformationMessage });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        const first = service.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);
        const second = service.showNotificationIfNeeded(getDebuggerInstallHint('addPythonModule')!, 1);

        assert.strictEqual(showInformationMessage.callCount, 1);
        resolveNotification(undefined);
        await Promise.all([first, second]);

        service.dispose();
        extensionChanges.dispose();
    });

    test('dismissal allows notification in a future extension session', async () => {
        const globalState = createTestMemento();
        const showInformationMessage = sinon.stub().resolves(undefined);
        const first = createDependencies({ showInformationMessage });
        const firstService = new DebuggerInstallHintService(globalState, first.dependencies);

        await firstService.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);
        firstService.dispose();
        first.extensionChanges.dispose();

        const second = createDependencies({ showInformationMessage });
        const secondService = new DebuggerInstallHintService(globalState, second.dependencies);
        await secondService.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);

        assert.strictEqual(showInformationMessage.callCount, 2);
        secondService.dispose();
        second.extensionChanges.dispose();
    });

    test("Don't show again suppresses notifications in future extension sessions", async () => {
        const globalState = createTestMemento();
        const showInformationMessage = sinon.stub().resolves(debuggerInstallDontShowAgain);
        const first = createDependencies({ showInformationMessage });
        const firstService = new DebuggerInstallHintService(globalState, first.dependencies);

        await firstService.showNotificationIfNeeded(getDebuggerInstallHint('AddGoApp')!, 1);
        firstService.dispose();
        first.extensionChanges.dispose();

        const second = createDependencies({ showInformationMessage });
        const secondService = new DebuggerInstallHintService(globalState, second.dependencies);
        await secondService.showNotificationIfNeeded(getDebuggerInstallHint('addGoApp')!, 1);

        assert.strictEqual(showInformationMessage.callCount, 1);
        secondService.dispose();
        second.extensionChanges.dispose();
    });

    test('notification install action installs the mapped extension', async () => {
        const installExtension = sinon.stub().resolves();
        const showInformationMessage = sinon.stub().resolves(debuggerInstallAction);
        const { dependencies, extensionChanges } = createDependencies({
            showInformationMessage,
            installExtension,
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddBunApp')!, 1);

        assert.strictEqual(showInformationMessage.firstCall.args[1], debuggerInstallAction);
        assert.strictEqual(showInformationMessage.firstCall.args[2], debuggerInstallDontShowAgain);
        assert.ok(installExtension.calledOnceWithExactly('oven.bun-vscode'));
        service.dispose();
        extensionChanges.dispose();
    });

    test('notification suppression does not install an extension', async () => {
        const installExtension = sinon.stub().resolves();
        const { dependencies, extensionChanges } = createDependencies({
            showInformationMessage: () => Promise.resolve(debuggerInstallDontShowAgain),
            installExtension,
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddGoApp')!, 1);

        assert.strictEqual(installExtension.callCount, 0);
        service.dispose();
        extensionChanges.dispose();
    });

    test("does not durably suppress after saving Don't show again fails", async () => {
        let notificationShown = false;
        let updateCount = 0;
        const globalState = {
            keys: () => notificationShown ? ['shown'] : [],
            get: <T>(_key: string, defaultValue?: T) => notificationShown ? true as T : defaultValue,
            update: () => {
                updateCount++;
                if (updateCount === 1) {
                    return Promise.reject(new Error('persistence failed'));
                }

                notificationShown = true;
                return Promise.resolve();
            },
            setKeysForSync: () => { },
        } as vscode.Memento;
        const showInformationMessage = sinon.stub().resolves(debuggerInstallDontShowAgain);
        const first = createDependencies({ showInformationMessage });
        const firstService = new DebuggerInstallHintService(globalState, first.dependencies);
        const hint = getDebuggerInstallHint('AddGoApp')!;

        await assert.rejects(firstService.showNotificationIfNeeded(hint, 1), /persistence failed/);
        firstService.dispose();
        first.extensionChanges.dispose();

        const second = createDependencies({ showInformationMessage });
        const secondService = new DebuggerInstallHintService(globalState, second.dependencies);
        await secondService.showNotificationIfNeeded(hint, 1);

        assert.strictEqual(showInformationMessage.callCount, 2);
        secondService.dispose();
        second.extensionChanges.dispose();
    });

    test('retries notification after display fails', async () => {
        const showInformationMessage = sinon.stub();
        showInformationMessage.onFirstCall().rejects(new Error('display failed'));
        showInformationMessage.onSecondCall().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({ showInformationMessage });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);
        const hint = getDebuggerInstallHint('AddBunApp')!;

        await assert.rejects(service.showNotificationIfNeeded(hint, 1), /display failed/);
        await service.showNotificationIfNeeded(hint, 1);

        assert.strictEqual(showInformationMessage.callCount, 2);
        service.dispose();
        extensionChanges.dispose();
    });

    test('install command delegates to VS Code extension installation', async () => {
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();

        await installDebuggerExtension('ms-python.debugpy');

        assert.ok(executeCommand.calledOnceWithExactly('workbench.extensions.installExtension', 'ms-python.debugpy'));
    });

    test('guides the user to restart the AppHost once the installed extension becomes available', async () => {
        const installed = new Set<string>();
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({
            getExtension: extensionId => installed.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined,
            showInformationMessage,
            // The install command resolves before the extension host publishes the extension, so
            // `getExtension` still reports it as missing when `installExtension` returns.
            installExtension: () => Promise.resolve(),
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        await service.installExtension('golang.go');
        assert.strictEqual(showInformationMessage.callCount, 0);

        installed.add('golang.go');
        extensionChanges.fire();

        assert.deepStrictEqual(
            showInformationMessage.args,
            [[debuggerInstalledRestartAppHost('Go')]]);

        extensionChanges.fire();
        assert.strictEqual(showInformationMessage.callCount, 1);

        service.dispose();
        extensionChanges.dispose();
    });

    test('reports install failures and keeps the hint available', async () => {
        const showErrorMessage = sinon.stub().resolves(undefined);
        const showInformationMessage = sinon.stub().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({
            showErrorMessage,
            showInformationMessage,
            installExtension: () => Promise.reject(new Error('offline')),
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        await service.installExtension('oven.bun-vscode');

        assert.deepStrictEqual(
            showErrorMessage.args,
            [[debuggerInstallFailed('Bun', 'offline')]]);
        assert.strictEqual(showInformationMessage.callCount, 0);
        assert.strictEqual(service.getMissingDebugger('AddBunApp')?.extensionId, 'oven.bun-vscode');

        service.dispose();
        extensionChanges.dispose();
    });

    test('install failure from the notification action does not reject', async () => {
        const showErrorMessage = sinon.stub().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({
            showErrorMessage,
            showInformationMessage: () => Promise.resolve(debuggerInstallAction),
            installExtension: () => Promise.reject(new Error('no marketplace')),
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);

        assert.deepStrictEqual(
            showErrorMessage.args,
            [[debuggerInstallFailed('Python', 'no marketplace')]]);

        service.dispose();
        extensionChanges.dispose();
    });

    test('reports pending notifications only while a hint can still be shown', async () => {
        const installed = new Set<string>(['golang.go']);
        const globalState = createTestMemento();
        const showInformationMessage = sinon.stub();
        showInformationMessage.onFirstCall().resolves(debuggerInstallDontShowAgain);
        showInformationMessage.onSecondCall().resolves(undefined);
        const { dependencies, extensionChanges } = createDependencies({
            getExtension: extensionId => installed.has(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined,
            showInformationMessage,
        });
        const service = new DebuggerInstallHintService(globalState, dependencies);

        assert.strictEqual(service.hasPendingNotifications(), true);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddPythonApp')!, 1);
        assert.strictEqual(service.hasPendingNotifications(), true);

        await service.showNotificationIfNeeded(getDebuggerInstallHint('AddBunApp')!, 1);
        assert.strictEqual(service.hasPendingNotifications(), false);

        service.dispose();
        extensionChanges.dispose();
    });

    test('reports no pending notifications once every debugger extension is installed', () => {
        const { dependencies, extensionChanges } = createDependencies({
            getExtension: extensionId => ({ id: extensionId }) as vscode.Extension<unknown>,
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);

        assert.strictEqual(service.hasPendingNotifications(), false);

        service.dispose();
        extensionChanges.dispose();
    });

    test('extension changes refresh missing hints and supported capabilities', () => {
        let pythonInstalled = false;
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) =>
            pythonInstalled && extensionId === 'ms-python.debugpy'
                ? { id: extensionId } as vscode.Extension<unknown>
                : undefined);
        const { dependencies, extensionChanges } = createDependencies({
            getExtension: extensionId => vscode.extensions.getExtension(extensionId),
        });
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);
        let refreshCount = 0;
        const subscription = service.onDidChange(() => refreshCount++);

        assert.strictEqual(service.getMissingDebugger('AddPythonApp')?.extensionId, 'ms-python.debugpy');
        assert.ok(!getSupportedCapabilities().includes('python'));

        pythonInstalled = true;
        extensionChanges.fire();

        assert.strictEqual(refreshCount, 1);
        assert.strictEqual(service.getMissingDebugger('AddPythonApp'), undefined);
        assert.ok(getSupportedCapabilities().includes('python'));

        subscription.dispose();
        service.dispose();
        extensionChanges.dispose();
    });

    test('dispose removes the extension change listener', () => {
        const { dependencies, extensionChanges } = createDependencies();
        const service = new DebuggerInstallHintService(createTestMemento(), dependencies);
        let refreshCount = 0;
        service.onDidChange(() => refreshCount++);

        service.dispose();
        extensionChanges.fire();

        assert.strictEqual(refreshCount, 0);
        extensionChanges.dispose();
    });
});
