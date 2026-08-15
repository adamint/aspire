import * as vscode from 'vscode';
import { isExtensionInstalled } from '../capabilities';
import {
    type ResourceAttachProviderId,
    type ResourceDebugExtensionRequirement,
    type ResourceDebugResourceSnapshot,
} from './resourceDebugContracts';
import { projectResourceAttachProvider } from './languages/dotnet';

/**
 * Defines attach behavior independently from resource launch behavior. Providers own both
 * eligibility and debugger configuration creation so the orchestration service never needs
 * language-specific process metadata.
 */
export interface ResourceAttachProvider {
    readonly id: ResourceAttachProviderId;
    readonly requiredDebuggerExtensions: readonly ResourceDebugExtensionRequirement[];
    canAttachToResource(resource: ResourceDebugResourceSnapshot): boolean;
    createDebugConfiguration(resource: ResourceDebugResourceSnapshot): Promise<vscode.DebugConfiguration>;
}

export class ResourceAttachProviderRegistry {
    constructor(
        private readonly _knownProviders: readonly ResourceAttachProvider[],
        private readonly _isDebuggerExtensionInstalled?: (extensionId: string) => boolean,
    ) {
    }

    getKnownProviderForResource(resource: ResourceDebugResourceSnapshot): ResourceAttachProvider | undefined {
        return this._knownProviders.find(provider => provider.canAttachToResource(resource));
    }

    getInstalledProviderForResource(resource: ResourceDebugResourceSnapshot): ResourceAttachProvider | undefined {
        return this._knownProviders.find(provider =>
            provider.canAttachToResource(resource) &&
            this.getMissingDebuggerExtensions(provider).length === 0);
    }

    getMissingDebuggerExtensions(provider: ResourceAttachProvider): readonly ResourceDebugExtensionRequirement[] {
        return provider.requiredDebuggerExtensions.filter(requirement =>
            !(this._isDebuggerExtensionInstalled?.(requirement.id) ?? isExtensionInstalled(requirement.id)));
    }
}

export function createResourceAttachProviderRegistry(): ResourceAttachProviderRegistry {
    return new ResourceAttachProviderRegistry([projectResourceAttachProvider]);
}

const defaultResourceAttachProviderRegistry = createResourceAttachProviderRegistry();

export function getKnownResourceAttachProviderForResource(resource: ResourceDebugResourceSnapshot): ResourceAttachProvider | undefined {
    return defaultResourceAttachProviderRegistry.getKnownProviderForResource(resource);
}

export function getInstalledResourceAttachProviderForResource(resource: ResourceDebugResourceSnapshot): ResourceAttachProvider | undefined {
    return defaultResourceAttachProviderRegistry.getInstalledProviderForResource(resource);
}
