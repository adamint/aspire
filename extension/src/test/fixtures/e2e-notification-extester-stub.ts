interface NotificationLike {
    getMessage(): Promise<string>;
    dismiss(): Promise<void>;
}

const state: {
    notificationPolls: Array<NotificationLike[] | Error>;
    pollResults: Array<NotificationLike | false>;
    waitMessages: string[];
    notificationPollCount: number;
} = {
    notificationPolls: [],
    pollResults: [],
    waitMessages: [],
    notificationPollCount: 0,
};

export function setNotificationPolls(notificationPolls: Array<NotificationLike[] | Error>): void {
    state.notificationPolls = [...notificationPolls];
    state.pollResults = [];
    state.waitMessages = [];
    state.notificationPollCount = 0;
}

export function resetNotificationWaitState(): void {
    setNotificationPolls([]);
}

export function getNotificationWaitState(): {
    notificationPollCount: number;
    pollResults: Array<NotificationLike | false>;
    waitMessages: string[];
} {
    return {
        notificationPollCount: state.notificationPollCount,
        pollResults: [...state.pollResults],
        waitMessages: [...state.waitMessages],
    };
}

export class Workbench {
    async getNotifications(): Promise<NotificationLike[]> {
        state.notificationPollCount++;

        if (state.notificationPolls.length === 0) {
            return [];
        }

        const nextPoll = state.notificationPolls.shift();
        if (nextPoll === undefined) {
            return [];
        }

        if (nextPoll instanceof Error) {
            throw nextPoll;
        }

        return nextPoll;
    }
}

export const VSBrowser = {
    instance: {
        driver: {
            wait: async (condition: () => Promise<NotificationLike | false>, _timeout: number | undefined, message?: string): Promise<NotificationLike | false> => {
                state.waitMessages.push(message ?? '');
                const maxAttempts = Math.max(state.notificationPolls.length, 1) + 1;

                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    const result = await condition();
                    state.pollResults.push(result);

                    if (result) {
                        return result;
                    }
                }

                throw new Error(message ?? 'Timed out waiting for notification.');
            },
            executeScript: async (): Promise<string> => '',
            actions: () => ({
                sendKeys: () => ({
                    perform: async (): Promise<void> => { },
                }),
            }),
        },
        waitForWorkbench: async (): Promise<void> => { },
        takeScreenshot: async (): Promise<void> => { },
    },
};

export class BottomBarPanel {
}

export class SideBarView {
}

export class EditorView {
}

export class InputBox {
    static async create(): Promise<never> {
        throw new Error('InputBox.create is not implemented in the notification stub.');
    }
}

export class WebView {
}

export const By = {
    css: (selector: string): string => selector,
};
