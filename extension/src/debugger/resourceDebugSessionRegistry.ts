import * as vscode from 'vscode';
import { getAppHostIdentityKey } from '../utils/appHostIdentity';
import type { ResourceDebugAppHostTarget } from './resourceDebugContracts';

const resourceDebugSessionMarkerConfigKey = '__aspireResourceDebugSessionMarker';

export interface ResourceDebugSessionEvents {
    readonly onDidStartDebugSession: vscode.Event<vscode.DebugSession>;
    readonly onDidTerminateDebugSession: vscode.Event<vscode.DebugSession>;
}

export interface ResourceDebugSessionAttempt {
    readonly configuration: vscode.DebugConfiguration;
    markStarted(): void;
    abandon(): void;
}

interface TrackedAttachAttempt {
    readonly marker: number;
    readonly resourceKey: string;
    readonly sessionIds: Set<string>;
    startAccepted: boolean;
    terminated: boolean;
}

/**
 * Tracks only attach sessions created by ResourceDebugService. The marker is intentionally
 * private to generated configurations so unrelated VS Code debug sessions cannot affect
 * resource attach serialization or lifecycle state.
 */
export class ResourceDebugSessionRegistry implements vscode.Disposable {
    private readonly _attempts = new Map<number, TrackedAttachAttempt>();
    private readonly _attemptsByResource = new Map<string, Set<number>>();
    private readonly _resourceLocks = new Map<string, Promise<void>>();
    private readonly _subscriptions: vscode.Disposable;
    private _nextMarker = 0;

    constructor(events: ResourceDebugSessionEvents = vscode.debug) {
        this._subscriptions = vscode.Disposable.from(
            events.onDidStartDebugSession(session => this._onDidStartDebugSession(session)),
            events.onDidTerminateDebugSession(session => this._onDidTerminateDebugSession(session)));
    }

    dispose(): void {
        this._subscriptions.dispose();
        this._attempts.clear();
        this._attemptsByResource.clear();
        this._resourceLocks.clear();
    }

    hasActiveSession(appHost: ResourceDebugAppHostTarget, resourceName: string): boolean {
        const attemptMarkers = this._attemptsByResource.get(this._getResourceKey(appHost.absolutePath, resourceName));
        if (!attemptMarkers) {
            return false;
        }

        return Array.from(attemptMarkers).some(marker => {
            const attempt = this._attempts.get(marker);
            return attempt !== undefined && !attempt.terminated && (attempt.startAccepted || attempt.sessionIds.size > 0);
        });
    }

    async runSerialized<T>(appHost: ResourceDebugAppHostTarget, resourceName: string, operation: () => Promise<T>): Promise<T> {
        const resourceKey = this._getResourceKey(appHost.absolutePath, resourceName);
        const precedingOperation = this._resourceLocks.get(resourceKey);
        let releaseCurrentOperation: (() => void) | undefined;
        const currentOperation = new Promise<void>(resolve => {
            releaseCurrentOperation = resolve;
        });
        this._resourceLocks.set(resourceKey, currentOperation);

        await precedingOperation?.catch(() => undefined);
        try {
            return await operation();
        }
        finally {
            releaseCurrentOperation!();
            if (this._resourceLocks.get(resourceKey) === currentOperation) {
                this._resourceLocks.delete(resourceKey);
            }
        }
    }

    createAttempt(appHost: ResourceDebugAppHostTarget, resourceName: string, configuration: vscode.DebugConfiguration): ResourceDebugSessionAttempt {
        const resourceKey = this._getResourceKey(appHost.absolutePath, resourceName);
        const marker = ++this._nextMarker;
        const attempt: TrackedAttachAttempt = {
            marker,
            resourceKey,
            sessionIds: new Set<string>(),
            startAccepted: false,
            terminated: false,
        };
        this._attempts.set(marker, attempt);
        const attemptMarkers = this._attemptsByResource.get(resourceKey) ?? new Set<number>();
        attemptMarkers.add(marker);
        this._attemptsByResource.set(resourceKey, attemptMarkers);

        return {
            configuration: {
                ...configuration,
                [resourceDebugSessionMarkerConfigKey]: marker,
            },
            markStarted: () => {
                if (attempt.terminated) {
                    this._removeAttempt(attempt);
                    return;
                }

                attempt.startAccepted = true;
            },
            abandon: () => this._removeAttempt(attempt),
        };
    }

    private _onDidStartDebugSession(session: vscode.DebugSession): void {
        const attempt = this._getAttempt(session);
        if (!attempt || attempt.terminated) {
            return;
        }

        attempt.sessionIds.add(session.id);
    }

    private _onDidTerminateDebugSession(session: vscode.DebugSession): void {
        const attempt = this._getAttempt(session);
        if (!attempt) {
            return;
        }

        attempt.sessionIds.delete(session.id);
        if (attempt.sessionIds.size > 0) {
            return;
        }

        attempt.terminated = true;
        if (attempt.startAccepted) {
            this._removeAttempt(attempt);
        }
        else {
            const attemptMarkers = this._attemptsByResource.get(attempt.resourceKey);
            attemptMarkers?.delete(attempt.marker);
            if (attemptMarkers?.size === 0) {
                this._attemptsByResource.delete(attempt.resourceKey);
            }
        }
    }

    private _getAttempt(session: vscode.DebugSession): TrackedAttachAttempt | undefined {
        const marker = session.configuration?.[resourceDebugSessionMarkerConfigKey];
        return typeof marker === 'number' ? this._attempts.get(marker) : undefined;
    }

    private _removeAttempt(attempt: TrackedAttachAttempt): void {
        this._attempts.delete(attempt.marker);
        const attemptMarkers = this._attemptsByResource.get(attempt.resourceKey);
        attemptMarkers?.delete(attempt.marker);
        if (attemptMarkers?.size === 0) {
            this._attemptsByResource.delete(attempt.resourceKey);
        }
    }

    private _getResourceKey(appHostPath: string, resourceName: string): string {
        return `${getAppHostIdentityKey(appHostPath)}\u0000${resourceName}`;
    }
}
