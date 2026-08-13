import * as vscode from 'vscode';
import { nugetSourceContainsCredentials } from '../loc/strings';

export function getNugetSourceArgs(): string[] | undefined {
    const source = vscode.workspace.getConfiguration('aspire').get<string>('nugetSource', '').trim();
    if (!source) {
        return undefined;
    }

    if (hasHttpCredentialMaterial(source)) {
        // Match the CLI persistence policy so credential material never reaches terminal history,
        // extension logs, shell history, or process arguments.
        void vscode.window.showErrorMessage(nugetSourceContainsCredentials);
        throw new vscode.CancellationError();
    }

    return ['--source', source];
}

function hasHttpCredentialMaterial(value: string): boolean {
    const httpScheme = /^https?:/i.exec(value)?.[0];
    if (!httpScheme) {
        return false;
    }

    // Check the original delimiters before parsing so malformed HTTP-shaped sources fail closed.
    // URL parsers reject values such as an invalid port, but the extension must not forward a
    // query token or userinfo from those values into terminal history and logs.
    const authorityAndPath = value.slice(httpScheme.length).replace(/^[\\/]+/, '');
    const authorityEnd = authorityAndPath.search(/[/?#\\]/);
    const authority = authorityEnd === -1
        ? authorityAndPath
        : authorityAndPath.slice(0, authorityEnd);
    return authority.includes('@') || value.includes('?') || value.includes('#');
}
