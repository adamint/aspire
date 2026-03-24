import * as vscode from 'vscode';
import path from 'path';
import { aspireConfigFileName } from './cliTypes';
import { findAspireSettingsFiles } from './workspace';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { spawnCliProcess } from '../debugger/languages/cli';
import { AspireTerminalProvider } from './AspireTerminalProvider';
import { extensionLogOutputChannel } from './logging';
import { getEnableAutoRestore } from './settings';
import { runningAspireRestore, runningAspireRestoreProgress, aspireRestoreCompleted, aspireRestoreAllCompleted, aspireRestoreFailed } from '../loc/strings';

/**
 * Runs `aspire restore` on workspace open and whenever aspire.config.json content changes
 * (e.g. after a git branch switch).
 */
export class AspirePackageRestoreProvider implements vscode.Disposable {
    private static readonly _maxConcurrency = 4;

    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _terminalProvider: AspireTerminalProvider;
    private readonly _statusBarItem: vscode.StatusBarItem;
    private readonly _lastContent = new Map<string, string>(); // fsPath → content
    private readonly _active = new Map<string, string>(); // configDir → relativePath
    private readonly _childProcesses = new Set<ChildProcessWithoutNullStreams>();
    private readonly _timeouts = new Set<ReturnType<typeof setTimeout>>();
    private _total = 0;
    private _completed = 0;

    constructor(terminalProvider: AspireTerminalProvider) {
        this._terminalProvider = terminalProvider;
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        this._disposables.push(this._statusBarItem);
    }

    async activate(): Promise<void> {
        if (!getEnableAutoRestore()) {
            extensionLogOutputChannel.info('Auto-restore is disabled');
            return;
        }

        await this._restoreAll();
        this._watchConfigFiles();

        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('aspire.enableAutoRestore') && getEnableAutoRestore()) {
                    this._restoreAll();
                }
            })
        );
    }

    private async _restoreAll(): Promise<void> {
        const allConfigs = await findAspireSettingsFiles();
        const configs = allConfigs.filter(uri => uri.fsPath.endsWith(aspireConfigFileName));
        if (configs.length === 0) {
            return;
        }

        this._total = configs.length;
        this._completed = 0;

        const pending = new Set<Promise<void>>();
        for (const uri of configs) {
            const p = this._restoreIfChanged(uri, true).finally(() => pending.delete(p));
            pending.add(p);
            if (pending.size >= AspirePackageRestoreProvider._maxConcurrency) {
                await Promise.race(pending);
            }
        }
        await Promise.all(pending);
    }

    private _watchConfigFiles(): void {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, `**/${aspireConfigFileName}`)
            );
            watcher.onDidChange(uri => this._onChanged(uri));
            watcher.onDidCreate(uri => this._onChanged(uri));
            this._disposables.push(watcher);
        }
    }

    private async _onChanged(uri: vscode.Uri): Promise<void> {
        if (!getEnableAutoRestore()) {
            return;
        }
        if (this._active.size === 0) {
            this._total = 1;
            this._completed = 0;
        }
        await this._restoreIfChanged(uri, false);
    }

    private async _restoreIfChanged(uri: vscode.Uri, isInitial: boolean): Promise<void> {
        try {
            const content = (await vscode.workspace.fs.readFile(uri)).toString();
            const prev = this._lastContent.get(uri.fsPath);
            this._lastContent.set(uri.fsPath, content);

            if (!isInitial && prev === content) {
                return;
            }

            const configDir = path.dirname(uri.fsPath);
            const relativePath = vscode.workspace.asRelativePath(uri);
            extensionLogOutputChannel.info(`${isInitial ? 'Initial' : 'Changed'} restore for ${relativePath}`);
            await this._runRestore(configDir, relativePath);
        } catch (error) {
            extensionLogOutputChannel.warn(`Failed to read ${uri.fsPath}: ${error}`);
        }
    }

    private async _runRestore(configDir: string, relativePath: string): Promise<void> {
        if (this._active.has(configDir)) {
            return;
        }

        this._active.set(configDir, relativePath);
        this._showProgress();

        const cliPath = await this._terminalProvider.getAspireCliExecutablePath();
        await new Promise<void>((resolve, reject) => {
            const proc = spawnCliProcess(this._terminalProvider, cliPath, ['restore'], {
                workingDirectory: configDir,
                noExtensionVariables: true,
                exitCallback: code => {
                    if (code === 0) {
                        extensionLogOutputChannel.info(aspireRestoreCompleted(relativePath));
                        resolve();
                    } else {
                        extensionLogOutputChannel.warn(aspireRestoreFailed(relativePath, `exit code ${code}`));
                        reject();
                    }
                },
                errorCallback: error => {
                    extensionLogOutputChannel.warn(aspireRestoreFailed(relativePath, error.message));
                    reject(error);
                },
            });
            this._childProcesses.add(proc);
            const timeout = setTimeout(() => { proc.kill(); reject(); }, 120_000);
            this._timeouts.add(timeout);
            proc.on('close', () => {
                clearTimeout(timeout);
                this._timeouts.delete(timeout);
                this._childProcesses.delete(proc);
            });
        }).finally(() => {
            this._active.delete(configDir);
            this._completed++;
            this._showProgress();
            if (this._active.size === 0) {
                const hideTimeout = setTimeout(() => { if (this._active.size === 0) { this._statusBarItem.hide(); } }, 5000);
                this._timeouts.add(hideTimeout);
            }
        });
    }

    private _showProgress(): void {
        if (this._active.size === 0) {
            this._statusBarItem.text = `$(check) ${aspireRestoreAllCompleted}`;
        } else if (this._total <= 1) {
            this._statusBarItem.text = `$(sync~spin) ${runningAspireRestore([...this._active.values()][0])}`;
        } else {
            this._statusBarItem.text = `$(sync~spin) ${runningAspireRestoreProgress(this._completed, this._total)}`;
        }
        this._statusBarItem.show();
    }

    dispose(): void {
        for (const proc of this._childProcesses) {
            proc.kill();
        }
        this._childProcesses.clear();
        for (const timeout of this._timeouts) {
            clearTimeout(timeout);
        }
        this._timeouts.clear();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
    }
}
