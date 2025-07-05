import * as vscode from 'vscode';

function isExtensionInstalled(extensionId: string): boolean {
    const ext = vscode.extensions.getExtension(extensionId);
    return !!ext;
}

function isCSharpExtensionInstalled(): boolean {
    return isExtensionInstalled('ms-dotnettools.csharp');
}

export function getSupportedCapabilities(): string[] {
    const capabilities = ['node', 'prompting'];

    if (isCSharpExtensionInstalled()) {
        capabilities.push('csharp');
    }

    return capabilities;
}
