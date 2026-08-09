import * as vscode from 'vscode';

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

/**
 * Releases the "already shown" record so the notification can be presented again.
 *
 * Callers that mark a notification as shown before presenting it need this for the case where the
 * attempt does not reach the user, or reaches them and then fails to do what it offered: the record
 * would otherwise spend the single chance the notification gets on an interaction that produced
 * nothing. This deliberately does not touch the suppression flag, which records a user decision.
 */
export async function clearNotificationShown(memento: vscode.Memento | undefined, notificationName: string): Promise<void> {
    await memento?.update(getNotificationShownKey(notificationName), undefined);
}
