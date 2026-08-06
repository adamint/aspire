/**
 * Suppression key for the one-time prompt offering to turn on C# Dev Kit's Hot Reload gate.
 *
 * Versioned so the prompt can be reissued later if the underlying Dev Kit setting is renamed or its
 * default changes again, without colliding with users who already dismissed the current prompt.
 */
export const hotReloadPromptSuppressedKey = 'aspire.hotReload.enablePrompt.v1';
