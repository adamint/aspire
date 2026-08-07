import path from "path";
import { ExecutableLaunchConfiguration, EnvVar, LaunchOptions, AspireResourceExtendedDebugConfiguration, AspireExtendedDebugConfiguration, AspireResourceDebugSession, DebugLaunchSettings } from "../dcp/types";
import { debugProject, runProject } from "../loc/strings";
import { getEnvironmentWithoutE2EBridgeVariables, mergeEnvs } from "../utils/environment";
import { extensionLogOutputChannel } from "../utils/logging";
import { projectDebuggerExtension } from "./languages/dotnet";
import { isAzureFunctionsExtensionInstalled, isBunInstalled, isCsharpInstalled, isGoInstalled, isMauiInstalled, isPythonInstalled } from '../capabilities';
import { pythonDebuggerExtension } from "./languages/python";
import { nodeDebuggerExtension } from "./languages/node";
import { browserDebuggerExtension } from "./languages/browser";
import { azureFunctionsDebuggerExtension } from "./languages/azureFunctions";
import { goDebuggerExtension } from "./languages/go";
import { bunDebuggerExtension } from "./languages/bun";
import { mauiDebuggerExtension } from "./languages/maui";
import { isDirectory } from "../utils/io";
import { waitForRunStartIdle } from "./runStartRegistry";

// Represents a resource-specific debugger extension for when the default session configuration is not sufficient to launch the resource.
export interface ResourceDebuggerExtension {
    resourceType: string;
    debugAdapter: string;
    extensionId: string | null;
    getDisplayName: (launchConfig: ExecutableLaunchConfiguration) => string;
    getProjectFile: (launchConfig: ExecutableLaunchConfiguration) => string;
    getSupportedFileTypes: () => string[];
    createDebugSessionConfigurationCallback?: (launchConfig: ExecutableLaunchConfiguration, args: string[] | undefined, env: EnvVar[], launchOptions: LaunchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration) => Promise<AlreadyStartedResourceDebugSession | void>;
}

export interface AlreadyStartedResourceDebugSession extends AspireResourceDebugSession {
    processId: number;
    termination: Promise<number>;
}

export interface PreparedDebugSession {
    debugConfiguration: AspireResourceExtendedDebugConfiguration;
    alreadyStartedSession?: AlreadyStartedResourceDebugSession;
}

export async function createDebugSessionConfiguration(debugSessionConfig: AspireExtendedDebugConfiguration, launchConfig: ExecutableLaunchConfiguration, args: string[] | undefined, env: EnvVar[], launchOptions: LaunchOptions, debuggerExtension: ResourceDebuggerExtension): Promise<AspireResourceExtendedDebugConfiguration> {
    return (await prepareDebugSession(debugSessionConfig, launchConfig, args, env, launchOptions, debuggerExtension)).debugConfiguration;
}

export async function prepareDebugSession(debugSessionConfig: AspireExtendedDebugConfiguration, launchConfig: ExecutableLaunchConfiguration, args: string[] | undefined, env: EnvVar[], launchOptions: LaunchOptions, debuggerExtension: ResourceDebuggerExtension): Promise<PreparedDebugSession> {
    if (debuggerExtension === null) {
        extensionLogOutputChannel.warn(`Unknown type: ${launchConfig.type}.`);
    }

    const projectPath = debuggerExtension.getProjectFile(launchConfig);
    await waitForRunStartIdle();

    const configuration: AspireResourceExtendedDebugConfiguration = {
        type: debuggerExtension.debugAdapter || launchConfig.type,
        request: 'launch',
        name: launchOptions.debug ? debugProject(debuggerExtension.getDisplayName(launchConfig)) : runProject(debuggerExtension.getDisplayName(launchConfig)),
        program: projectPath,
        args: args,
        cwd: await isDirectory(projectPath) ? projectPath : path.dirname(projectPath),
        env: mergeEnvs(getEnvironmentWithoutE2EBridgeVariables(), env),
        justMyCode: false,
        stopAtEntry: false,
        noDebug: !launchOptions.debug,
        runId: launchOptions.runId,
        debugSessionId: launchOptions.debugSessionId,
        console: 'internalConsole',
        isApphost: launchOptions.isApphost
    };

    if (debugSessionConfig.debuggers) {
        // 1. Check if this is the apphost
        if (launchOptions.isApphost && debugSessionConfig.debuggers['apphost']) {
            applyUserDebuggerSettings(configuration, debugSessionConfig.debuggers['apphost']);
        }

        // 2. Check for resource type specific debugger settings
        if (debugSessionConfig.debuggers[launchConfig.type]) {
            applyUserDebuggerSettings(configuration, debugSessionConfig.debuggers[launchConfig.type]);
        }
    }


    let alreadyStartedSession: AlreadyStartedResourceDebugSession | undefined;
    if (debuggerExtension.createDebugSessionConfigurationCallback) {
        alreadyStartedSession = await debuggerExtension.createDebugSessionConfigurationCallback(launchConfig, args, env, launchOptions, configuration) ?? undefined;
    }

    return {
        debugConfiguration: configuration,
        alreadyStartedSession
    };
}

/**
 * Fields on the resource debug configuration that Aspire owns and that the workspace
 * `debuggers` setting must never override.
 *
 * These are not user-facing knobs. They correlate the VS Code session with the DCP run
 * (`runId`, `debugSessionId`), decide who reports the run's termination (`sessionTermination`),
 * and select AppHost-specific behavior (`isApphost`). Letting a workspace-controlled setting
 * rewrite them is a safety problem and not just a confusing override: `runId` is used to derive
 * an on-disk scratch directory that is later deleted recursively (`getBrowserUserDataDir` in
 * `languages/browser.ts`), so a workspace-supplied `runId` could aim that delete outside the
 * directory Aspire owns. `browser.ts` re-validates containment independently, but the override
 * is blocked here too so a future consumer of `runId` does not inherit the same hazard.
 */
const internalDebugConfigurationFieldNames: readonly string[] = [
    'runId',
    'debugSessionId',
    'sessionTermination',
    'isApphost'
];

const internalDebugConfigurationFields: ReadonlySet<string> = new Set<string>(internalDebugConfigurationFieldNames);

/**
 * Merges a workspace `debuggers.<key>` block into the generated debug configuration, skipping the
 * fields Aspire owns. `DebugLaunchSettings` declares only user-facing properties, but the value
 * comes from unvalidated `launch.json`/settings JSON, so unknown keys reach this code at runtime.
 */
function applyUserDebuggerSettings(configuration: AspireResourceExtendedDebugConfiguration, settings: DebugLaunchSettings): void {
    for (const [key, value] of Object.entries(settings)) {
        if (internalDebugConfigurationFields.has(key)) {
            extensionLogOutputChannel.warn(`Ignoring '${key}' from the 'debuggers' debug configuration because it is managed by Aspire.`);
            continue;
        }

        (configuration as Record<string, unknown>)[key] = value;
    }
}

export function getResourceDebuggerExtensions(): ResourceDebuggerExtension[] {
    const extensions = [];
    if (isCsharpInstalled()) {
        extensions.push(projectDebuggerExtension);

        if (isAzureFunctionsExtensionInstalled()) {
            extensions.push(azureFunctionsDebuggerExtension);
        }
    }

    if (isPythonInstalled()) {
        extensions.push(pythonDebuggerExtension);
    }

    if (isGoInstalled()) {
        extensions.push(goDebuggerExtension);
    }

    extensions.push(nodeDebuggerExtension);
    extensions.push(browserDebuggerExtension);

    if (isBunInstalled()) {
        extensions.push(bunDebuggerExtension);
    }

    if (isMauiInstalled()) {
        extensions.push(mauiDebuggerExtension);
    }

    return extensions;
}
