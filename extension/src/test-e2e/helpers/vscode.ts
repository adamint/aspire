import { ActivityBar, BottomBarPanel, EditorView, InputBox, Notification, TreeItem, TreeSection, VSBrowser, Workbench } from './extester';

export async function openAspireView(): Promise<TreeSection> {
    const activityBar = new ActivityBar();
    const aspireControl = await activityBar.getViewControl('Aspire');
    if (!aspireControl) {
        throw new Error('Aspire activity bar view control was not found.');
    }

    const sideBar = await aspireControl.openView();
    return await sideBar.getContent().getSection('AppHosts');
}

export async function waitForTreeItem(section: TreeSection, label: string, timeoutMs = 30000): Promise<TreeItem> {
    return await VSBrowser.instance.driver.wait(async () => {
        try {
            return await section.findItem(label, 4) ?? false;
        }
        catch {
            return false;
        }
    }, timeoutMs, `Timed out waiting for tree item '${label}'.`);
}

export async function selectContextMenuItem(item: TreeItem, label: string): Promise<void> {
    const menu = await item.openContextMenu();
    try {
        await menu.select(label);
    }
    finally {
        try {
            await menu.close();
        }
        catch {
        }
    }
}

export async function clickTreeItemAction(item: TreeItem, label: string): Promise<void> {
    const action = await item.getActionButton(label);
    if (!action) {
        throw new Error(`Tree item action '${label}' was not found on '${await item.getLabel()}'.`);
    }

    await action.click();
}

export async function clickTreeItem(section: TreeSection, label: string, timeoutMs = 30000): Promise<TreeItem> {
    const item = await waitForTreeItem(section, label, timeoutMs);
    await item.click();
    return item;
}

export async function executeCommandFromPalette(command: string): Promise<void> {
    await new Workbench().executeCommand(command);
}

export async function cancelActiveInput(): Promise<void> {
    const input = await VSBrowser.instance.driver.wait(async () => {
        try {
            return await InputBox.create();
        }
        catch {
            return false;
        }
    }, 30000, 'Timed out waiting for active input to appear.');
    await input.cancel();
}

export async function waitForNotificationMessage(expectedText: string, timeoutMs = 30000): Promise<Notification> {
    return await VSBrowser.instance.driver.wait(async () => {
        const notifications = await new Workbench().getNotifications();
        for (const notification of notifications) {
            const message = await notification.getMessage();
            if (message.includes(expectedText)) {
                return notification;
            }
        }

        return false;
    }, timeoutMs, `Timed out waiting for notification containing '${expectedText}'.`);
}

export async function getCurrentTerminalChannel(): Promise<string> {
    return await (await new BottomBarPanel().openTerminalView()).getCurrentChannel();
}

export async function waitForTerminalChannel(expectedText: string, timeoutMs = 30000): Promise<string> {
    return await VSBrowser.instance.driver.wait(async () => {
        const channel = await getCurrentTerminalChannel();
        return channel.includes(expectedText) ? channel : false;
    }, timeoutMs, `Timed out waiting for terminal channel containing '${expectedText}'.`);
}

export async function waitForEditorTitle(expectedText: string, timeoutMs = 60000): Promise<string> {
    return await VSBrowser.instance.driver.wait(async () => {
        const titles = await new EditorView().getOpenEditorTitles();
        return titles.find(title => title.includes(expectedText)) ?? false;
    }, timeoutMs, `Timed out waiting for editor title containing '${expectedText}'.`);
}

export async function closeAllEditors(): Promise<void> {
    await new EditorView().closeAllEditors();
}
