import * as vscode from 'vscode';
import { nugetSourceContainsCredentials } from '../loc/strings';

export function getNugetSourceArgs(): string[] | undefined {
    const source = vscode.workspace.getConfiguration('aspire').get<string>('nugetSource', '').trim();
    if (!source) {
        return undefined;
    }

    const parsedSource = tryParseUrl(source);
    if (parsedSource && (parsedSource.username !== '' || parsedSource.password !== '')) {
        // Reject inline credentials here so they never reach terminal history or process arguments.
        void vscode.window.showErrorMessage(nugetSourceContainsCredentials);
        throw new vscode.CancellationError();
    }

    return ['--source', source];
}

function tryParseUrl(value: string): URL | undefined {
    try {
        return new URL(value);
    }
    catch {
        return undefined;
    }
}
