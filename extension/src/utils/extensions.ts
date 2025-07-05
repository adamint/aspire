import * as vscode from 'vscode';

function isExtensionInstalled(extensionId: string): boolean {
    const ext = vscode.extensions.getExtension(extensionId);
    return !!ext;
}

export function isPythonExtensionInstalled(): boolean {
    return isExtensionInstalled('ms-python.python');
}

export function getSupportedDebugLanguages(): string[] {
    const languages = ['node'];

    if (isPythonExtensionInstalled()) {
        languages.push('python');
    }

    return languages;
}