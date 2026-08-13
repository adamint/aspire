import * as vscode from 'vscode';
import { nugetSourceContainsCredentials } from '../loc/strings';

export function getNugetSourceArgs(): string[] | undefined {
    const source = vscode.workspace.getConfiguration('aspire').get<string>('nugetSource', '').trim();
    if (!source) {
        return undefined;
    }

    const parsedSource = tryParseHttpUrl(source);
    if (parsedSource &&
        (parsedSource.username !== '' ||
            parsedSource.password !== '' ||
            source.includes('?') ||
            source.includes('#'))) {
        // Match the CLI persistence policy so credential material never reaches terminal history,
        // extension logs, shell history, or process arguments.
        void vscode.window.showErrorMessage(nugetSourceContainsCredentials);
        throw new vscode.CancellationError();
    }

    return ['--source', source];
}

function tryParseHttpUrl(value: string): URL | undefined {
    // WHATWG URL normalizes malformed values such as `https:feed?sig=token` and
    // `http:\\feed?sig=token`, while the CLI's Uri.TryCreate check rejects their shape.
    // Require the absolute HTTP(S) authority form before using URL for userinfo parsing.
    if (!/^https?:\/\/([^/?#\\]+)(?:[/?#]|$)/i.test(value)) {
        return undefined;
    }

    try {
        return new URL(value);
    }
    catch {
        return undefined;
    }
}
