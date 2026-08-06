/**
 * Suppression key for the one-time prompt offering to turn on C# Dev Kit's Hot Reload gate.
 *
 * Versioned so the prompt can be reissued later if the underlying Dev Kit setting is renamed or its
 * default changes again, without colliding with users who already dismissed the current prompt.
 */
export const hotReloadPromptSuppressedKey = 'aspire.hotReload.enablePrompt.v1';

/**
 * Suppression key for the one-time notice explaining how Hot Reload behaves in an Aspire session.
 *
 * Separate from {@link hotReloadPromptSuppressedKey} because the two answer different questions and
 * a user can need the second without ever seeing the first: anyone whose Dev Kit already defaults
 * the gate on never gets the enable prompt, and is exactly the user who has no idea the feature is
 * running or what it covers.
 */
export const hotReloadSessionNoticeShownKey = 'aspire.hotReload.sessionNotice.v1';
