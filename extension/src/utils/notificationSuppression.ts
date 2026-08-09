import * as vscode from 'vscode';
import { dontShowAgainLabel } from '../loc/strings';

export type ShowInformationMessage = (message: string, ...items: string[]) => Thenable<string | undefined>;

export interface InformationMessageWithDontShowAgainOptions {
    memento?: vscode.Memento;
    notificationName: string;
    message: string;
    items?: readonly string[];
    showInformationMessage?: ShowInformationMessage;
}

export function getNotificationSuppressionKey(notificationName: string): string {
    return `${notificationName}Suppressed`;
}

export function isNotificationSuppressed(memento: vscode.Memento | undefined, notificationName: string): boolean {
    return memento?.get<boolean>(getNotificationSuppressionKey(notificationName), false) === true;
}

export async function suppressNotification(memento: vscode.Memento | undefined, notificationName: string): Promise<void> {
    await memento?.update(getNotificationSuppressionKey(notificationName), true);
}

export function getNotificationShownKey(notificationName: string): string {
    return `${notificationName}Shown`;
}

/**
 * Whether a "show this at most once per user" notification has already been presented.
 *
 * Kept separate from the suppression flag because the two answer different questions: suppression
 * records that the user asked never to see the notification again, while this records that they
 * have already seen it once. A caller that only tracked suppression would re-present the
 * notification in every new extension host window until the user clicked "Don't show again".
 */
export function hasNotificationBeenShown(memento: vscode.Memento | undefined, notificationName: string): boolean {
    return memento?.get<boolean>(getNotificationShownKey(notificationName), false) === true;
}

export async function markNotificationShown(memento: vscode.Memento | undefined, notificationName: string): Promise<void> {
    await memento?.update(getNotificationShownKey(notificationName), true);
}

export async function showInformationMessageWithDontShowAgain(options: InformationMessageWithDontShowAgainOptions): Promise<string | undefined> {
    const {
        memento,
        notificationName,
        message,
        items = [],
        showInformationMessage = (message, ...items) => vscode.window.showInformationMessage(message, ...items)
    } = options;

    if (isNotificationSuppressed(memento, notificationName)) {
        return undefined;
    }

    const selection = await showInformationMessage(message, ...items, dontShowAgainLabel);
    if (selection === dontShowAgainLabel) {
        await suppressNotification(memento, notificationName);
    }

    return selection;
}
