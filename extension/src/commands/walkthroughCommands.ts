import * as vscode from 'vscode';
import { aspireTerminalName } from '../loc/strings';

export type CliInstallQuality = 'stable' | 'daily';

export function getCliInstallCommand(quality: CliInstallQuality, platform: NodeJS.Platform = process.platform): string {
    if (platform === 'win32') {
        // The command is sent to the user's configured terminal profile. Invoke
        // Windows PowerShell explicitly so the installer also works when the
        // default profile is Command Prompt instead of PowerShell.
        return quality === 'daily'
            ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm \'https://aspire.dev/install.ps1\'))) -Quality dev"'
            : 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://aspire.dev/install.ps1\' | iex"';
    }

    return quality === 'daily'
        ? 'curl -sSL https://aspire.dev/install.sh | bash -s -- -q dev'
        : 'curl -sSL https://aspire.dev/install.sh | bash';
}

function getOrCreateTerminal(): vscode.Terminal {
    const existing = vscode.window.terminals.find(t => t.name === aspireTerminalName);
    if (existing) {
        return existing;
    }
    return vscode.window.createTerminal({ name: aspireTerminalName });
}

function runInTerminal(command: string): void {
    const terminal = getOrCreateTerminal();
    terminal.show();
    terminal.sendText(command);
}

export function runCliInstallCommand(quality: CliInstallQuality): void {
    runInTerminal(getCliInstallCommand(quality));
}

export async function installCliStableCommand(): Promise<void> {
    runCliInstallCommand('stable');
}

export async function installCliDailyCommand(): Promise<void> {
    runCliInstallCommand('daily');
}

export async function verifyCliInstalledCommand(): Promise<void> {
    runInTerminal('aspire --version');
}
