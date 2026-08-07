import * as vscode from 'vscode';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import { AspireDebugSession } from './debugger/AspireDebugSession';
import { AspireDebugConfigurationProvider } from './debugger/AspireDebugConfigurationProvider';
import { debugSessionAlreadyExists, extensionContextNotInitialized } from './loc/strings';
import AspireRpcServer from './server/AspireRpcServer';
import AspireDcpServer from './dcp/AspireDcpServer';
import { AspireTerminalProvider } from './utils/AspireTerminalProvider';
import { AspireEditorCommandProvider } from './editor/AspireEditorCommandProvider';
import type { AspireDebugConsoleOutputEvent } from './types/extensionApi';
import { extensionLogOutputChannel } from './utils/logging';

export class AspireExtensionContext implements vscode.Disposable {
    private static readonly _cliStopTimeoutMs = 5_000;

    private _rpcServer?: AspireRpcServer;
    private _dcpServer?: AspireDcpServer;
    private _extensionContext?: vscode.ExtensionContext;
    private _debugConfigProvider?: AspireDebugConfigurationProvider;
    private _terminalProvider?: AspireTerminalProvider;
    private _editorCommandProvider?: AspireEditorCommandProvider;

    private _aspireDebugSessions: AspireDebugSession[] = [];
    private readonly _debugSessionStateSubscriptions = new Map<string, vscode.Disposable>();
    private readonly _debugSessionOutputSubscriptions = new Map<string, vscode.Disposable>();
    private readonly _onDidChangeDebugSessions = new vscode.EventEmitter<void>();
    private readonly _onDidReceiveDebugConsoleOutput = new vscode.EventEmitter<AspireDebugConsoleOutputEvent>();
    private _shutdownPromise?: Promise<void>;
    private _isShuttingDown = false;
    private _isDisposed = false;
    readonly onDidChangeDebugSessions = this._onDidChangeDebugSessions.event;
    readonly onDidReceiveDebugConsoleOutput = this._onDidReceiveDebugConsoleOutput.event;

    initialize(rpcServer: AspireRpcServer, extensionContext: vscode.ExtensionContext, debugConfigProvider: AspireDebugConfigurationProvider, dcpServer: AspireDcpServer, terminalProvider: AspireTerminalProvider, editorCommandProvider: AspireEditorCommandProvider): void {
        this._rpcServer = rpcServer;
        this._extensionContext = extensionContext;
        this._debugConfigProvider = debugConfigProvider;
        this._dcpServer = dcpServer;
        this._terminalProvider = terminalProvider;
        this._editorCommandProvider = editorCommandProvider;
    }

    get rpcServer(): AspireRpcServer {
        if (!this._rpcServer) {
            throw new Error(extensionContextNotInitialized);
        }
        return this._rpcServer;
    }

    get dcpServer(): AspireDcpServer {
        if (!this._dcpServer) {
            throw new Error(extensionContextNotInitialized);
        }
        return this._dcpServer;
    }

    get extensionContext(): vscode.ExtensionContext {
        if (!this._extensionContext) {
            throw new Error(extensionContextNotInitialized);
        }
        return this._extensionContext;
    }

    getAspireDebugSession(debugSessionId: string | null): AspireDebugSession | null {
        if (!debugSessionId) {
            return null;
        }

        return this._aspireDebugSessions.find(session => session.debugSessionId === debugSessionId) || null;
    }

    get aspireDebugSessions(): readonly AspireDebugSession[] {
        return [...this._aspireDebugSessions];
    }

    addAspireDebugSession(debugSession: AspireDebugSession) {
        if (this._aspireDebugSessions.find(session => session.debugSessionId === debugSession.debugSessionId)) {
            throw new Error(debugSessionAlreadyExists(debugSession.debugSessionId));
        }

        this._aspireDebugSessions.push(debugSession);
        this._debugSessionStateSubscriptions.set(debugSession.debugSessionId, debugSession.onDidChangeState(() => this._onDidChangeDebugSessions.fire()));
        this._debugSessionOutputSubscriptions.set(debugSession.debugSessionId, debugSession.onDidSendDebugConsoleOutput(event => this._onDidReceiveDebugConsoleOutput.fire(event)));
        this._onDidChangeDebugSessions.fire();
    }

    removeAspireDebugSession(debugSession: AspireDebugSession) {
        this._aspireDebugSessions = this._aspireDebugSessions.filter(session => session.debugSessionId !== debugSession.debugSessionId);
        this._debugSessionStateSubscriptions.get(debugSession.debugSessionId)?.dispose();
        this._debugSessionStateSubscriptions.delete(debugSession.debugSessionId);
        this._debugSessionOutputSubscriptions.get(debugSession.debugSessionId)?.dispose();
        this._debugSessionOutputSubscriptions.delete(debugSession.debugSessionId);
        this._onDidChangeDebugSessions.fire();
    }

    get debugConfigProvider(): AspireDebugConfigurationProvider | undefined {
        if (!this._debugConfigProvider) {
            throw new Error(extensionContextNotInitialized);
        }

        return this._debugConfigProvider;
    }

    deactivate(): Promise<void> {
        if (this._isDisposed) {
            return Promise.resolve();
        }

        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }

        this._isShuttingDown = true;
        // Schedule the async work after storing the shared promise so a reentrant dispose/deactivate
        // call cannot begin synchronous teardown between the stop request and the first await.
        this._shutdownPromise = Promise.resolve().then(() => this._deactivateCore());
        return this._shutdownPromise;
    }

    dispose(): void {
        if (this._isDisposed || this._isShuttingDown) {
            return;
        }

        this._disposeCore();
    }

    private async _deactivateCore(): Promise<void> {
        try {
            await this._waitForCliStopRequests();
        }
        finally {
            // A timeout or failed RPC stop still has to run the established debug-session and
            // terminal teardown path so extension deactivation cannot leave the CLI process alive.
            this._disposeCore();
        }
    }

    private async _waitForCliStopRequests(): Promise<void> {
        const stopRequests = this._aspireDebugSessions.map(session => {
            try {
                return session.requestCliStopForExtensionShutdown();
            }
            catch (error) {
                return Promise.reject(error);
            }
        });

        const allStops = Promise.allSettled(stopRequests);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            allStops.then(results => ({ timedOut: false as const, results })),
            new Promise<{ timedOut: true }>(resolve => {
                timeout = setTimeout(() => {
                    timeout = undefined;
                    resolve({ timedOut: true });
                }, AspireExtensionContext._cliStopTimeoutMs);
            }),
        ]);

        if (timeout) {
            clearTimeout(timeout);
        }

        if (outcome.timedOut) {
            extensionLogOutputChannel.warn(`Timed out after ${AspireExtensionContext._cliStopTimeoutMs}ms waiting for Aspire CLI stop requests; continuing extension teardown.`);
            return;
        }

        const failures = outcome.results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason);
        for (const failure of failures) {
            // Closing the RPC transport rejects its outstanding stop request even though the
            // synchronous debug-session and terminal teardown below has completed successfully.
            if (failure instanceof ResponseError && failure.code === ErrorCodes.PendingResponseRejected) {
                extensionLogOutputChannel.info(`Aspire CLI stop request ended after the RPC transport closed: ${failure}`);
            }
            else {
                extensionLogOutputChannel.warn(`Failed to stop Aspire CLI during extension deactivation: ${failure}`);
            }
        }
    }

    private _disposeCore(): void {
        if (this._isDisposed) {
            return;
        }

        this._isDisposed = true;
        this._debugSessionStateSubscriptions.forEach(disposable => disposable.dispose());
        this._debugSessionStateSubscriptions.clear();
        this._debugSessionOutputSubscriptions.forEach(disposable => disposable.dispose());
        this._debugSessionOutputSubscriptions.clear();
        const sessions = this._aspireDebugSessions.splice(0);
        sessions.forEach(session => session.dispose());
        this._rpcServer?.dispose();
        this._dcpServer?.dispose();
        this._terminalProvider?.dispose();
        this._editorCommandProvider?.dispose();
        this._onDidChangeDebugSessions.dispose();
        this._onDidReceiveDebugConsoleOutput.dispose();
    }
}
