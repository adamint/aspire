import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { AspireExtendedDebugConfiguration } from '../dcp/types';

const extensionOwnedConfigurationMarker = `__aspireAppHostLaunchServiceConfiguration_${randomUUID()}`;
const extensionOwnedConfigurationValue = randomUUID();

export function markAspireDebugConfigurationAsExtensionOwned(configuration: vscode.DebugConfiguration): void {
    const configRecord = configuration as Record<string, unknown>;
    configRecord[extensionOwnedConfigurationMarker] = extensionOwnedConfigurationValue;
    (configuration as AspireExtendedDebugConfiguration).launchedByExtension = extensionOwnedConfigurationValue;
}

export function isAspireDebugConfigurationExtensionOwned(configuration: vscode.DebugConfiguration): boolean {
    const configRecord = configuration as Record<string, unknown>;
    return configRecord[extensionOwnedConfigurationMarker] === extensionOwnedConfigurationValue ||
        configRecord.launchedByExtension === extensionOwnedConfigurationValue;
}

export function stripAspireDebugConfigurationProviderInternalProperties(configuration: vscode.DebugConfiguration): void {
    const configRecord = configuration as Record<string, unknown>;
    delete configRecord[extensionOwnedConfigurationMarker];
    delete configRecord.launchedByExtension;
}
