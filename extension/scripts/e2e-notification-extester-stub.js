const state = {
    notificationPolls: [],
    pollResults: [],
    waitMessages: [],
    notificationPollCount: 0,
};

function setNotificationPolls(notificationPolls) {
    state.notificationPolls = [...notificationPolls];
    state.pollResults = [];
    state.waitMessages = [];
    state.notificationPollCount = 0;
}

function resetNotificationWaitState() {
    setNotificationPolls([]);
}

function getNotificationWaitState() {
    return {
        notificationPollCount: state.notificationPollCount,
        pollResults: [...state.pollResults],
        waitMessages: [...state.waitMessages],
    };
}

class Workbench {
    async getNotifications() {
        state.notificationPollCount++;

        if (state.notificationPolls.length === 0) {
            return [];
        }

        const nextPoll = state.notificationPolls.shift();
        if (nextPoll instanceof Error) {
            throw nextPoll;
        }

        return nextPoll;
    }
}

const VSBrowser = {
    instance: {
        driver: {
            wait: async (condition, _timeout, message) => {
                state.waitMessages.push(message);
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
            executeScript: async () => '',
            actions: () => ({
                sendKeys: () => ({
                    perform: async () => { },
                }),
            }),
        },
        waitForWorkbench: async () => { },
        takeScreenshot: async () => { },
    },
};

class BottomBarPanel {
}

class SideBarView {
}

class EditorView {
}

class InputBox {
    static async create() {
        throw new Error('InputBox.create is not implemented in the notification stub.');
    }
}

class WebView {
}

const By = {
    css: selector => selector,
};

module.exports = {
    BottomBarPanel,
    By,
    EditorView,
    InputBox,
    SideBarView,
    VSBrowser,
    WebView,
    Workbench,
    getNotificationWaitState,
    resetNotificationWaitState,
    setNotificationPolls,
};
