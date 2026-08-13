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
    const parsedSource = tryParseHttpUrl(value);
    if (parsedSource) {
        return parsedSource.username !== '' ||
            parsedSource.password !== '' ||
            value.includes('?') ||
            value.includes('#');
    }

    return hasUnparseableScopedIpv6CredentialMaterial(value);
}

function hasUnparseableScopedIpv6CredentialMaterial(value: string): boolean {
    const authority = /^https?:\/\/([^/?#\\]+)(?:[/?#]|$)/i.exec(value)?.[1];
    if (!authority) {
        return false;
    }

    // .NET accepts RFC 6874 scoped IPv6 sources such as:
    //   https://user:pass@[fe80::1%25eth0]/v3/index.json?sig=token
    // WHATWG URL rejects the zone identifier. Remove only the scope to verify that the remaining
    // URL is valid, then inspect the original delimiters. This keeps malformed authorities such as
    // an invalid port aligned with Uri.TryCreate. See https://www.rfc-editor.org/rfc/rfc6874.html.
    const scopedHost = /(\[[0-9a-f:.]+)%25[^\]]*(\](?::\d+)?)$/i.exec(authority);
    if (!scopedHost) {
        return false;
    }

    const unscopedAuthority = authority.slice(0, scopedHost.index) + scopedHost[1] + scopedHost[2];
    const unscopedValue = value.replace(authority, () => unscopedAuthority);
    if (!tryParseHttpUrl(unscopedValue)) {
        return false;
    }

    const userInfo = authority.slice(0, scopedHost.index);
    return userInfo.includes('@') || value.includes('?') || value.includes('#');
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
