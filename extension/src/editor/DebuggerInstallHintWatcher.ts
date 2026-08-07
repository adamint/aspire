import * as vscode from 'vscode';
import { DebuggerInstallHintService } from '../debugger/debuggerInstallHints';
import { extensionLogOutputChannel } from '../utils/logging';
import { AppHostDataRepository, isMatchingAppHostPath, ResourceJson } from '../views/AppHostDataRepository';
import { resolveAppHostSourcePath } from '../views/AspireAppHostTreeProvider';
import { getParserForDocument, ParsedResource } from './parsers/AppHostResourceParser';
import { ResourceState } from './resourceConstants';

export interface DebuggerInstallHintWatcherDependencies {
    parseAppHostResources(appHostPath: string): Promise<readonly ParsedResource[]>;
    reportError(error: unknown): void;
}

const maxParseAttempts = 5;

export class DebuggerInstallHintWatcher implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[];
    private _refreshRequested = false;
    private _refreshPromise: Promise<void> | undefined;
    private _disposed = false;

    constructor(
        private readonly _repository: AppHostDataRepository,
        private readonly _debuggerInstallHintService: DebuggerInstallHintService,
        private readonly _dependencies: DebuggerInstallHintWatcherDependencies,
    ) {
        this._disposables = [
            _repository.onDidChangeData(() => this._requestRefresh()),
            _debuggerInstallHintService.onDidChange(() => this._requestRefresh()),
        ];
    }

    refresh(): Promise<void> {
        if (this._disposed) {
            return Promise.resolve();
        }

        this._refreshRequested = true;
        this._refreshPromise ??= this._runRefreshLoop();
        return this._refreshPromise;
    }

    private _requestRefresh(): void {
        if (!this._disposed) {
            void this.refresh().catch(error => this._dependencies.reportError(error));
        }
    }

    private async _runRefreshLoop(): Promise<void> {
        try {
            while (this._refreshRequested && !this._disposed) {
                this._refreshRequested = false;
                await this._scanRunningResources();
            }
        } finally {
            this._refreshPromise = undefined;
            if (this._refreshRequested && !this._disposed) {
                this._requestRefresh();
            }
        }
    }

    private async _scanRunningResources(): Promise<void> {
        // Opening and parsing AppHost sources is the expensive part of this watcher and it runs on
        // every resource poll. Once every debugger hint has been shown, suppressed, or satisfied by
        // an installed extension there is nothing left to notify about, so skip the work entirely.
        if (!this._debuggerInstallHintService.hasPendingNotifications()) {
            return;
        }

        for (const appHost of this._repository.appHosts) {
            if (this._disposed) {
                return;
            }

            const resources = this._getResources(appHost.appHostPath, appHost.resources);
            const runningResourceNames = new Set<string>();
            for (const resource of resources) {
                if (resource.state === ResourceState.Running) {
                    // Runtime resource names can have a generated suffix, while displayName retains
                    // the source-level name parsed from the AppHost.
                    runningResourceNames.add(resource.name);
                    if (resource.displayName) {
                        runningResourceNames.add(resource.displayName);
                    }
                }
            }

            if (runningResourceNames.size === 0) {
                continue;
            }

            let parsedResources: readonly ParsedResource[];
            try {
                parsedResources = await this._dependencies.parseAppHostResources(appHost.appHostPath);
            } catch (error) {
                this._dependencies.reportError(error);
                continue;
            }

            if (this._disposed) {
                return;
            }

            for (const parsedResource of parsedResources) {
                if (this._disposed) {
                    return;
                }

                if (!runningResourceNames.has(parsedResource.name)) {
                    continue;
                }

                const hint = this._debuggerInstallHintService.getMissingDebugger(parsedResource.methodName);
                if (hint) {
                    // The notification promise remains pending while the toast is visible. Do not block
                    // resource refreshes on user interaction; the service coalesces concurrent prompts.
                    void this._debuggerInstallHintService.showNotificationIfNeeded(hint)
                        .catch(error => this._dependencies.reportError(error));
                }
            }
        }
    }

    private _getResources(appHostPath: string, appHostResources: ResourceJson[] | null | undefined): readonly ResourceJson[] {
        if (appHostResources && appHostResources.length > 0) {
            return appHostResources;
        }

        return this._repository.workspaceAppHostPath
            && isMatchingAppHostPath(this._repository.workspaceAppHostPath, appHostPath)
            ? this._repository.workspaceResources
            : [];
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
        this._refreshRequested = false;
        this._disposables.forEach(disposable => disposable.dispose());
    }
}

export function createDebuggerInstallHintWatcher(
    repository: AppHostDataRepository,
    debuggerInstallHintService: DebuggerInstallHintService,
): DebuggerInstallHintWatcher {
    const parsedResourceCache = new WeakMap<vscode.TextDocument, {
        documentVersion: number;
        resources: readonly ParsedResource[];
    }>();

    return new DebuggerInstallHintWatcher(repository, debuggerInstallHintService, {
        async parseAppHostResources(appHostPath) {
            const sourcePath = resolveAppHostSourcePath(appHostPath);
            const sourceUri = vscode.Uri.file(sourcePath);
            let document = await vscode.workspace.openTextDocument(sourceUri);

            // A document that is edited or closed while the parser runs invalidates the parse, so we
            // retry. Bound the retries so a document being edited continuously can never spin this
            // loop forever; the next repository poll re-runs the scan anyway.
            for (let attempt = 0; attempt < maxParseAttempts; attempt++) {
                const cached = parsedResourceCache.get(document);
                if (cached?.documentVersion === document.version) {
                    return cached.resources;
                }

                const documentVersion = document.version;
                const parser = await getParserForDocument(document);
                if (document.isClosed) {
                    document = await vscode.workspace.openTextDocument(sourceUri);
                    continue;
                }

                const resources = parser ? await parser.parseResources(document) : [];
                if (document.isClosed) {
                    document = await vscode.workspace.openTextDocument(sourceUri);
                    continue;
                }

                if (document.version !== documentVersion) {
                    // Parser initialization can await language support. Retry rather than caching
                    // results whose source text no longer matches the document's current version.
                    continue;
                }

                parsedResourceCache.set(document, {
                    documentVersion,
                    resources,
                });
                return resources;
            }

            return [];
        },
        reportError(error) {
            extensionLogOutputChannel.warn(`Failed to evaluate missing debugger install hints: ${String(error)}`);
        },
    });
}
