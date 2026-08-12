import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { AspireExtendedDebugConfiguration } from '../dcp/types';

const extensionOwnedConfigurationMarker = `__aspireAppHostLaunchServiceConfiguration_${randomUUID()}`;
const extensionOwnedConfigurationValue = randomUUID();
const externalLaunchReservationMarker = `__aspireExternalLaunchReservation_${randomUUID()}`;

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

export function markAspireDebugConfigurationWithExternalLaunchReservation(configuration: vscode.DebugConfiguration, reservationId: string): void {
    (configuration as Record<string, unknown>)[externalLaunchReservationMarker] = reservationId;
}

export function getAspireDebugConfigurationExternalLaunchReservation(configuration: vscode.DebugConfiguration): string | undefined {
    const reservationId = (configuration as Record<string, unknown>)[externalLaunchReservationMarker];
    return typeof reservationId === 'string' ? reservationId : undefined;
}

export function stripAspireDebugConfigurationProviderInternalProperties(configuration: vscode.DebugConfiguration): void {
    const configRecord = configuration as Record<string, unknown>;
    delete configRecord[extensionOwnedConfigurationMarker];
    delete configRecord[externalLaunchReservationMarker];
    delete configRecord.launchedByExtension;
}
