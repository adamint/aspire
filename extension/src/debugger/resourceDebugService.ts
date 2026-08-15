import * as vscode from 'vscode';
import type { AppHostDisplayInfo, ResourceJson } from '../data/AppHostDataRepository';
import { compareAppHostIdentity, type AppHostIdentityRelation } from '../utils/appHostIdentity';
import { isCommandCancellation } from '../utils/telemetry';
import {
    ResourceAttachConfigurationError,
    type ResourceDebugAppHostTarget,
    type ResourceDebugExtensionRequirement,
    type ResourceDebugRequest,
    type ResourceDebugResult,
} from './resourceDebugContracts';
import { ResourceAttachProviderRegistry, type ResourceAttachProvider } from './resourceAttachProviders';
import { ResourceDebugSessionRegistry } from './resourceDebugSessionRegistry';

export interface ResourceDebugAppHostRepository {
    fetchAppHostsOnce(): Promise<readonly AppHostDisplayInfo[]>;
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
export class ResourceDebugService implements vscode.Disposable {
    private readonly _compareAppHostIdentity: ResourceDebugAppHostIdentityComparer;

    constructor(private readonly _dependencies: ResourceDebugServiceDependencies) {
        this._compareAppHostIdentity = _dependencies.compareAppHostIdentity ?? compareAppHostIdentity;
    }

    dispose(): void {
        this._dependencies.sessionRegistry.dispose();
    }

    async debug(request: ResourceDebugRequest): Promise<ResourceDebugResult> {
        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        return await this._dependencies.sessionRegistry.runSerialized(request.appHost, request.resourceName, async () =>
            await this._debugSerialized(request));
    }

    private async _debugSerialized(request: ResourceDebugRequest): Promise<ResourceDebugResult> {
        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        let appHosts: readonly AppHostDisplayInfo[];
        try {
            appHosts = await this._dependencies.appHostRepository.fetchAppHostsOnce();
        }
        catch (error) {
            return isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested
                ? { outcome: 'cancelled' }
                : { outcome: 'error', errorKind: 'resourceSnapshotFailed' };
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

        const appHost = matchingAppHosts[0];
        const resources = (appHost.resources ?? []).filter(resource => resource.name === request.resourceName);
        if (resources.length !== 1) {
            return { outcome: 'resourceNotFound' };
        }

        const resource = resources[0];
        if (resource.state !== 'Running') {
            return { outcome: 'resourceNotRunning' };
        }

        let provider: ResourceAttachProvider | undefined;
        let missingDebuggerExtensions: readonly ResourceDebugExtensionRequirement[];
        try {
            provider = this._dependencies.attachProviders.getKnownProviderForResource(resource);
            missingDebuggerExtensions = provider
                ? this._dependencies.attachProviders.getMissingDebuggerExtensions(provider)
                : [];
        }
        catch (error) {
            return isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested
                ? { outcome: 'cancelled' }
                : { outcome: 'error', errorKind: 'providerResolutionFailed' };
        }

        if (!provider) {
            return { outcome: 'unsupportedResource' };
        }

        if (missingDebuggerExtensions.length > 0) {
            return {
                outcome: 'debuggerExtensionMissing',
                debuggerExtensions: missingDebuggerExtensions.map(requirement => ({
                    id: requirement.id,
                    label: requirement.label,
                })),
            };
        }

        const resolvedTarget: ResourceDebugAppHostTarget = {
            absolutePath: appHost.appHostPath,
            displayPath: request.appHost.displayPath,
        };
        return await this._attach(request, resolvedTarget, resource, provider);
    }

    private async _attach(
        request: ResourceDebugRequest,
        appHost: ResourceDebugAppHostTarget,
        resource: ResourceJson,
        knownProvider: ResourceAttachProvider,
    ): Promise<ResourceDebugResult> {
        if (request.cancellationToken?.isCancellationRequested) {
            return { outcome: 'cancelled' };
        }

        if (this._dependencies.sessionRegistry.hasActiveSession(appHost, resource.name)) {
            return { outcome: 'alreadyDebugging' };
        }

        let provider: ResourceAttachProvider | undefined;
        let missingDebuggerExtensions: readonly ResourceDebugExtensionRequirement[];
        try {
            provider = this._dependencies.attachProviders.getInstalledProviderForResource(resource);
            missingDebuggerExtensions = this._dependencies.attachProviders.getMissingDebuggerExtensions(knownProvider);
        }
        catch (error) {
            return isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested
                ? { outcome: 'cancelled' }
                : { outcome: 'error', errorKind: 'providerResolutionFailed' };
        }

        if (!provider) {
            if (missingDebuggerExtensions.length > 0) {
                return {
                    outcome: 'debuggerExtensionMissing',
                    debuggerExtensions: missingDebuggerExtensions.map(requirement => ({
                        id: requirement.id,
                        label: requirement.label,
                    })),
                };
            }

            return { outcome: 'unsupportedResource' };
        }

        let configuration: vscode.DebugConfiguration;
        try {
            configuration = await provider.createDebugConfiguration(resource);
        }
        catch (error) {
            if (error instanceof ResourceAttachConfigurationError) {
                return { outcome: 'unsupportedResource' };
            }

            return isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested
                ? { outcome: 'cancelled' }
                : { outcome: 'error', errorKind: 'configurationFailed' };
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
            return isCommandCancellation(error) || request.cancellationToken?.isCancellationRequested
                ? { outcome: 'cancelled' }
                : { outcome: 'error', errorKind: 'debuggerStartFailed' };
        }
    }
}
