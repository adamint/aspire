import * as assert from 'assert';
import * as path from 'path';

interface NotificationLike {
    getMessage(): Promise<string>;
    dismiss(): Promise<void>;
}

interface NotificationExtesterStubModule {
    getNotificationWaitState(): {
        notificationPollCount: number;
        pollResults: Array<NotificationLike | false>;
        waitMessages: string[];
    };
    resetNotificationWaitState(): void;
    setNotificationPolls(notificationPolls: Array<NotificationLike[] | Error>): void;
}

interface VscodeHelpersModule {
    waitForNotificationMessage(expectedText: string, timeoutMs?: number): Promise<NotificationLike>;
}

const extensionRoot = path.resolve(__dirname, '..', '..');
const extesterStubModulePath = path.join(extensionRoot, 'scripts', 'e2e-notification-extester-stub.js');
const compiledExtesterModulePath = path.join(extensionRoot, 'out', 'test-e2e', 'helpers', 'extester.js');
const compiledVscodeHelpersModulePath = path.join(extensionRoot, 'out', 'test-e2e', 'helpers', 'vscode.js');

suite('waitForNotificationMessage', () => {
    const originalExtesterModule = process.env.ASPIRE_EXTENSION_E2E_EXTESTER_MODULE;

    teardown(() => {
        resetLoadedNotificationModules();
        if (originalExtesterModule === undefined) {
            delete process.env.ASPIRE_EXTENSION_E2E_EXTESTER_MODULE;
        }
        else {
            process.env.ASPIRE_EXTENSION_E2E_EXTESTER_MODULE = originalExtesterModule;
        }
    });

    test('retries when a notification message read hits a replaced VS Code element', async () => {
        const staleNotification = createNotification(() => {
            throw new Error('StaleElementReferenceError: stale element reference');
        });
        const freshNotification = createNotification('Aspire Dashboard ready');
        const { stub, vscode } = loadNotificationWaitModules();

        stub.setNotificationPolls([[staleNotification], [freshNotification]]);

        const notification = await vscode.waitForNotificationMessage('Dashboard ready', 5000);
        const waitState = stub.getNotificationWaitState();

        assert.strictEqual(notification, freshNotification);
        assert.strictEqual(waitState.notificationPollCount, 2);
        assert.deepStrictEqual(waitState.pollResults, [false, freshNotification]);
        assert.deepStrictEqual(waitState.waitMessages, [
            "Timed out waiting for notification containing 'Dashboard ready'.",
        ]);
    });

    test('retries when VS Code replaces the notification list before Selenium can read it', async () => {
        const freshNotification = createNotification('Aspire Dashboard ready');
        const { stub, vscode } = loadNotificationWaitModules();

        stub.setNotificationPolls([
            new Error('StaleElementReferenceError: notifications list replaced'),
            [freshNotification],
        ]);

        const notification = await vscode.waitForNotificationMessage('Dashboard ready', 5000);
        const waitState = stub.getNotificationWaitState();

        assert.strictEqual(notification, freshNotification);
        assert.strictEqual(waitState.notificationPollCount, 2);
        assert.deepStrictEqual(waitState.pollResults, [false, freshNotification]);
    });
});

function loadNotificationWaitModules(): {
    stub: NotificationExtesterStubModule;
    vscode: VscodeHelpersModule;
} {
    process.env.ASPIRE_EXTENSION_E2E_EXTESTER_MODULE = extesterStubModulePath;
    resetLoadedNotificationModules();

    const stub = require(extesterStubModulePath) as NotificationExtesterStubModule;
    stub.resetNotificationWaitState();

    const vscode = require(compiledVscodeHelpersModulePath) as VscodeHelpersModule;
    return { stub, vscode };
}

function resetLoadedNotificationModules(): void {
    for (const modulePath of [compiledVscodeHelpersModulePath, compiledExtesterModulePath, extesterStubModulePath]) {
        try {
            delete require.cache[require.resolve(modulePath)];
        }
        catch {
        }
    }
}

function createNotification(messageOrFactory: string | (() => Promise<string> | string)): NotificationLike {
    return {
        dismiss: async () => { },
        getMessage: async () => typeof messageOrFactory === 'function'
            ? await messageOrFactory()
            : messageOrFactory,
    };
}
