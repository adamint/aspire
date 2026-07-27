import * as path from 'path';
import * as vscode from 'vscode';
import { getRustDebugAdapterType } from "../../capabilities";
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, RustLaunchConfiguration, isRustLaunchConfiguration } from "../../dcp/types";
import { invalidLaunchConfiguration, rustDisplayName, rustLabel } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";

const defaultRustDebugAdapter = getRustDebugAdapterType() ?? 'codelldb';

function getProjectFile(launchConfig: ExecutableLaunchConfiguration): string {
    if (isRustLaunchConfiguration(launchConfig) && launchConfig.working_directory) {
        return launchConfig.working_directory;
    }

    throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
}

function createCargoConfiguration(launchConfig: RustLaunchConfiguration): { args: string[]; filter?: string } | undefined {
    if (!launchConfig.cargo) {
        return undefined;
    }

    return {
        args: launchConfig.cargo.args ?? [],
        ...(launchConfig.cargo.filter ? { filter: launchConfig.cargo.filter } : {})
    };
}

function getRustBinaryPath(launchConfig: RustLaunchConfiguration): string {
    const workingDirectory = launchConfig.working_directory ?? '.';
    const binaryName = launchConfig.cargo?.filter ?? path.basename(workingDirectory);
    const executableName = process.platform === 'win32'
        ? `${binaryName}.exe`
        : binaryName;

    return path.join(workingDirectory, 'target', 'debug', executableName);
}

export const rustDebuggerExtension: ResourceDebuggerExtension = {
    resourceType: 'rust',
    debugAdapter: defaultRustDebugAdapter,
    extensionId: null,
    getDisplayName: (launchConfiguration: ExecutableLaunchConfiguration) => {
        if (isRustLaunchConfiguration(launchConfiguration) && launchConfiguration.working_directory) {
            return rustDisplayName(vscode.workspace.asRelativePath(launchConfiguration.working_directory));
        }

        return rustLabel;
    },
    getSupportedFileTypes: () => ['.rs'],
    getProjectFile: (launchConfig) => getProjectFile(launchConfig),
    createDebugSessionConfigurationCallback: async (launchConfig, args, _env, launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<void> => {
        if (!isRustLaunchConfiguration(launchConfig)) {
            extensionLogOutputChannel.info(`The resource type was not rust for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        const debugAdapter = getRustDebugAdapterType();
        if (debugAdapter === undefined) {
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        debugConfiguration.type = debugAdapter;
        debugConfiguration.request = 'launch';
        debugConfiguration.noDebug = !launchOptions.debug;
        debugConfiguration.cwd = launchConfig.working_directory;
        debugConfiguration.args = args ?? [];

        if (debugAdapter === 'cppvsdbg' || debugAdapter === 'cppdbg') {
            debugConfiguration.program = getRustBinaryPath(launchConfig);
            delete debugConfiguration.cargo;
            return;
        }

        const cargo = createCargoConfiguration(launchConfig);
        if (cargo) {
            debugConfiguration.cargo = cargo;
        }

        delete debugConfiguration.program;
    }
};
