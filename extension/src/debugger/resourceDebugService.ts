import * as vscode from 'vscode';
import type { AppHostDisplayInfo, ResourceJson } from '../data/AppHostDataRepository';
import { compareAppHostIdentity, type AppHostIdentityRelation } from '../utils/appHostIdentity';
import { extensionLogOutputChannel } from '../utils/logging';
import { isCommandCancellation } from '../utils/telemetry';
import {
    ResourceAttachConfigurationError,
    type ResourceAttachProvider,
    type ResourceDebugAppHostTarget,
    type ResourceDebugExtensionRequirement,
    type ResourceDebugger,
    type ResourceDebugRequest,
    type ResourceDebugResult,
} from './resourceDebugContracts';
import { ResourceAttachProviderRegistry } from './resourceAttachProviders';
import { ResourceDebugSessionRegistry } from './resourceDebugSessionRegistry';

export interface ResourceDebugAppHostRepository {
    fetchRunningAppHostsOnce(cancellationToken?: vscode.CancellationToken): Promise<readonly AppHostDisplayInfo[]>;
    fetchAppHostResourcesOnce(appHostPath: string, cancellationToken?: vscode.CancellationToken): Promise<readonly ResourceJson[]>;
}

export type ResourceDebugAppHostIdentityComparer =
    (left: string | undefined, right: string | undefined) => AppHostIdentityRelation;

export type ResourceDebugStartDebugging =
    (workspaceFolder: vscode.WorkspaceFolder | undefined, configuration: vscode.DebugConfiguration) => Thenable<boolean>;

export interface ResourceDebugServiceDependencies {
    readonly appHostRepository: ResourceDebugAppHostRepository;
    readonly attachProviders: ResourceAttachProviderRegistry;
    readonly sessionRegistry: ResourceDebugSessionRegistry;
    readonly startDebugging: ResourceDebugStartDebugging;
    readonly compareAppHostIdentity?: ResourceDebugAppHostIdentityComparer;
}

/**
 * Resolves and attaches to a resource using a fresh CLI snapshot. It deliberately returns only
 * bounded, presentation-safe outcomes; tree and language-model callers own their own UX.
 */
export class ResourceDebugService implements vscode.Disposable, ResourceDebugger {
    private readonly _compareAppHostIdentity: ResourceDebugAppHostIdentityComparer;

    constructor(private readonly _dependencies: ResourceDebugServiceDependencies) {
        this._compareAppHostIdentity = _dependencies.compareAppHostIdentity ?? compareAppHostIdentity;
    }

    dispose(): void {
        this._dependencies.sessionRegistry.dispose();
    }

    canAttachToResource(resource: ResourceJson): boolean {
        try {
            const provider = this._dependencies.attachProviders.getRecognizedProviderForResource(resource);
            return provider !== undefined
                && provider.canAttachToResource(resource);
        }
        catch (error) {
            this._logFailure('checking whether a resource can be attached', error);
            return false;
        }
    }

    async debug(request: ResourceDebugRequest): Promise<ResourceDebugResult> {
        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        const resolvedAppHost = await this._resolveAppHost(request);
        if ('outcome' in resolvedAppHost) {
            return resolvedAppHost;
        }

        const resolvedTarget: ResourceDebugAppHostTarget = {
            absolutePath: resolvedAppHost.appHostPath,
            displayPath: request.appHost.displayPath,
        };
        return await this._dependencies.sessionRegistry.runSerialized(
            resolvedTarget,
            request.resourceName,
            request.cancellationToken,
            async () => await this._debugSerialized(request, resolvedTarget),
            () => ({ outcome: 'cancelled' }));
    }

    private async _resolveAppHost(request: ResourceDebugRequest): Promise<AppHostDisplayInfo | ResourceDebugResult> {
        let appHosts: readonly AppHostDisplayInfo[];
        try {
            appHosts = await this._dependencies.appHostRepository.fetchRunningAppHostsOnce(request.cancellationToken);
        }
        catch (error) {
            if (isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested) {
                return { outcome: 'cancelled' };
            }

            this._logFailure('resolving the running AppHost', error);
            return { outcome: 'error', errorKind: 'resourceSnapshotFailed' };
        }

        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        const appHostMatches = appHosts.map(appHost => ({
            appHost,
            relation: this._compareAppHostIdentity(request.appHost.absolutePath, appHost.appHostPath),
        }));
        if (appHostMatches.some(match => match.relation === 'ambiguous')) {
            return { outcome: 'appHostNotFound' };
        }

        const matchingAppHosts = appHostMatches
            .filter(match => match.relation === 'same')
            .map(match => match.appHost);
        if (matchingAppHosts.length !== 1) {
            return { outcome: 'appHostNotFound' };
        }

        return matchingAppHosts[0];
    }

    private async _debugSerialized(
        request: ResourceDebugRequest,
        resolvedTarget: ResourceDebugAppHostTarget,
    ): Promise<ResourceDebugResult> {
        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        let resources: readonly ResourceJson[];
        try {
            resources = await this._dependencies.appHostRepository.fetchAppHostResourcesOnce(
                resolvedTarget.absolutePath,
                request.cancellationToken);
        }
        catch (error) {
            if (isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested) {
                return { outcome: 'cancelled' };
            }

            this._logFailure('fetching the selected AppHost resource snapshot', error);
            return { outcome: 'error', errorKind: 'resourceSnapshotFailed' };
        }

        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        const matchingResources = resources.filter(resource => resource.name === request.resourceName);
        if (matchingResources.length !== 1) {
            return { outcome: 'resourceNotFound' };
        }

        const resource = matchingResources[0];
        let provider: ResourceAttachProvider | undefined;
        try {
            provider = this._dependencies.attachProviders.getRecognizedProviderForResource(resource);
        }
        catch (error) {
            if (isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested) {
                return { outcome: 'cancelled' };
            }

            this._logFailure('resolving the resource attach provider', error);
            return { outcome: 'error', errorKind: 'providerResolutionFailed' };
        }

        if (!provider) {
            return { outcome: 'unsupportedResource' };
        }

        if (resource.state !== 'Running') {
            return { outcome: 'resourceNotRunning' };
        }

        return await this._attach(request, resolvedTarget, resource, provider);
    }

    private async _attach(
        request: ResourceDebugRequest,
        appHost: ResourceDebugAppHostTarget,
        resource: ResourceJson,
        provider: ResourceAttachProvider,
    ): Promise<ResourceDebugResult> {
        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        if (this._dependencies.sessionRegistry.hasActiveSession(appHost, resource.name)) {
            return { outcome: 'alreadyDebugging' };
        }

        let missingDebuggerExtensions: readonly ResourceDebugExtensionRequirement[];
        try {
            if (!provider.canAttachToResource(resource)) {
                return { outcome: 'unsupportedResource' };
            }

            missingDebuggerExtensions = this._dependencies.attachProviders.getMissingDebuggerExtensions(provider);
        }
        catch (error) {
            if (isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested) {
                return { outcome: 'cancelled' };
            }

            this._logFailure('resolving the installed resource attach provider', error);
            return { outcome: 'error', errorKind: 'providerResolutionFailed' };
        }

        if (missingDebuggerExtensions.length > 0) {
            return {
                outcome: 'debuggerExtensionMissing',
                debuggerExtensions: missingDebuggerExtensions.map(requirement => requirement.installMessage
                    ? { id: requirement.id, label: requirement.label, installMessage: requirement.installMessage }
                    : { id: requirement.id, label: requirement.label }),
            };
        }

        let configuration: vscode.DebugConfiguration;
        try {
            configuration = await provider.createDebugConfiguration(resource, request.cancellationToken);
        }
        catch (error) {
            if (isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested) {
                return { outcome: 'cancelled' };
            }

            this._logFailure(
                error instanceof ResourceAttachConfigurationError
                    ? 'creating an attach configuration for an ineligible resource'
                    : 'creating the resource attach configuration',
                error);
            return { outcome: 'error', errorKind: 'configurationFailed' };
        }

        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        const attempt = this._dependencies.sessionRegistry.createAttempt(appHost, resource.name, configuration);
        try {
            const started = await this._dependencies.startDebugging(undefined, attempt.configuration);
            if (!started) {
                attempt.abandon();
                return { outcome: 'error', errorKind: 'debuggerStartDeclined' };
            }

            attempt.markStarted();
            return { outcome: 'started', providerId: provider.id };
        }
        catch (error) {
            attempt.abandon();
            if (isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested) {
                return { outcome: 'cancelled' };
            }

            this._logFailure('starting the resource debugger', error);
            return { outcome: 'error', errorKind: 'debuggerStartFailed' };
        }
    }

    private _logFailure(operation: string, error: unknown): void {
        extensionLogOutputChannel.error(`Resource debugger failed while ${operation}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
}
