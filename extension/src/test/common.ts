import * as vscode from 'vscode';

export async function getAndActivateExtension() {
	const extension = vscode.extensions.getExtension('aspire-vscode') || vscode.extensions.all.find(e => e.id.endsWith('aspire-vscode'));
	if (!extension) {
		throw new Error('Extension not found');
	}

	await extension.activate();
	return extension;
}

/**
 * An in-memory `vscode.Memento` for tests that exercise globalState-backed suppression flags.
 *
 * Mirrors VS Code's semantics closely enough for that purpose: `update` with `undefined` removes the
 * key, and `get` falls back to the supplied default only when the key is absent.
 */
export function createTestMemento(): vscode.Memento {
	const values = new Map<string, unknown>();

	return {
		keys: () => [...values.keys()],
		get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue as T,
		update: async (key: string, value: unknown) => {
			if (value === undefined) {
				values.delete(key);
				return;
			}

			values.set(key, value);
		},
	} as vscode.Memento;
}
