import * as vscode from 'vscode';

function isExtensionInstalled(extensionId: string): boolean {
    const ext = vscode.extensions.getExtension(extensionId);
    return !!ext;
}

export function isCSharpExtensionInstalled(): boolean {
    return isExtensionInstalled('ms-dotnettools.csharp');
}