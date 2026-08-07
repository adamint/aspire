import * as vscode from 'vscode';
import { defaultConfigurationName } from '../loc/strings';
import type { AspireExtendedDebugConfiguration } from '../dcp/types';
import { AppHostDiscoveryService, getDebugTargetForCandidate } from '../utils/appHostDiscovery';
import type { CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';
import { checkCliAvailableOrRedirect } from '../utils/workspace';
import { extensionLogOutputChannel } from '../utils/logging';
import { appHostTelemetryTargetPathConfigKey } from './AspireDebugConfigurationMetadata';
import { getAspireDebugConfigurationCommand } from '../services/AppHostLaunchService';

/**
 * The part of `AppHostLaunchService` this provider needs to make a `launch.json`/F5
 * launch visible to the shared launching reservation.
 */
export interface ExternalLaunchReservation {
    reserveExternalLaunch(appHostPath: string): void;
}

export class AspireDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(
        private readonly _appHostDiscoveryService: AppHostDiscoveryService,
        private readonly _launchReservation: ExternalLaunchReservation) {
    }

    async provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration[]> {
        if (folder === undefined) {
            return [];
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return [this.createDefaultConfiguration(folder)];
        }

        const activeEditorFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (activeEditorFolder?.uri.toString() !== folder.uri.toString()) {
            return [this.createDefaultConfiguration(folder)];
        }

        const candidate = await this.tryFindCandidateForEditorFile(activeEditor.document.uri.fsPath, folder);
        if (!candidate) {
            return [this.createDefaultConfiguration(folder)];
        }

        return [{
            type: 'aspire',
            request: 'launch',
            name: defaultConfigurationName,
            program: getDebugTargetForCandidate(candidate)
        }];
    }

    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null | undefined> {
        const aspireConfig = config as AspireExtendedDebugConfiguration;
        if (!aspireConfig.skipCliAvailabilityCheck) {
            const result = await checkCliAvailableOrRedirect('debug_gate');
            if (!result.available) {
                return undefined; // Cancel the debug session
            }
        }

        if (!config.type) {
            config.type = 'aspire';
        }

        if (!config.request) {
            config.request = 'launch';
        }

        if (!config.name) {
            config.name = defaultConfigurationName;
        }

        if (!config.program) {
            config.program = folder?.uri.fsPath || '${workspaceFolder}';
        }

        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null | undefined> {
        const aspireConfig = config as AspireExtendedDebugConfiguration;
        delete aspireConfig.skipCliAvailabilityCheck;

        if (typeof config.program === 'string') {
            const program = config.program;
            config.program = await this.resolveDebugTarget(program, folder);

            // This is the last hook before VS Code creates the session, and it is the only
            // point a `launch.json`/F5 launch shares with the tool-driven path, which goes
            // through `AppHostLaunchService`. Reserving here is what stops an agent from
            // starting a second AppHost in the window before the session exists. Only
            // `run` reserves: publish/deploy/do sessions are not AppHost lifetimes.
            if (typeof config.program === 'string' && getAspireDebugConfigurationCommand(aspireConfig) === 'run') {
                this._launchReservation.reserveExternalLaunch(config.program);
            }

            const telemetryTarget = await this.tryFindWorkspaceDefaultCandidate(program, folder);
            if (telemetryTarget) {
                config[appHostTelemetryTargetPathConfigKey] = telemetryTarget.path;
            }
            else {
                delete config[appHostTelemetryTargetPathConfigKey];
            }
        }

        return config;
    }

    private async tryFindCandidateForEditorFile(filePath: string, folder: vscode.WorkspaceFolder): Promise<CandidateAppHostDisplayInfo | undefined> {
        try {
            return await this._appHostDiscoveryService.tryFindCandidateForEditorFile(filePath, folder);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Failed to discover AppHost for debug configuration file ${filePath}: ${error}`);
            return undefined;
        }
    }

    private async resolveDebugTarget(filePath: string, folder: vscode.WorkspaceFolder | undefined): Promise<string> {
        try {
            return await this._appHostDiscoveryService.resolveDebugTarget(filePath, folder);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Failed to resolve AppHost debug target ${filePath}: ${error}`);
            return filePath;
        }
    }

    private async tryFindWorkspaceDefaultCandidate(filePath: string, folder: vscode.WorkspaceFolder | undefined): Promise<CandidateAppHostDisplayInfo | undefined> {
        try {
            return await this._appHostDiscoveryService.tryFindWorkspaceDefaultCandidate(filePath, folder);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Failed to discover workspace AppHost telemetry target ${filePath}: ${error}`);
            return undefined;
        }
    }

    private createDefaultConfiguration(folder: vscode.WorkspaceFolder): vscode.DebugConfiguration {
        return {
            type: 'aspire',
            request: 'launch',
            name: defaultConfigurationName,
            program: folder.uri.fsPath
        };
    }
}
