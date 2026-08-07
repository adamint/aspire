import path from "path";
import { ExecutableLaunchConfiguration, EnvVar, LaunchOptions, AspireResourceExtendedDebugConfiguration, AspireExtendedDebugConfiguration, AspireResourceDebugSession, DebugLaunchSettings, ResourceTerminationSignal } from "../dcp/types";
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
    /**
     * Which observable event ends a run of this resource type. Required so that adding a debugger
     * integration is a deliberate decision about run lifetime rather than an inherited default,
     * and so the choice lives in code the workspace cannot influence.
     */
    terminationSignal: ResourceTerminationSignal;
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
        console: 'internalConsole',
        // Placeholder values only. The authoritative assignment happens in
        // applyAspireOwnedFields() below, after the workspace `debuggers` merge.
        runId: launchOptions.runId,
        debugSessionId: launchOptions.debugSessionId,
        terminationSignal: debuggerExtension.terminationSignal,
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

    // Re-apply the fields Aspire owns *after* the workspace merge, so a workspace setting can
    // never win no matter what it contains. applyUserDebuggerSettings() also refuses to write
    // them, but that check is a denylist someone can forget to extend when adding a field;
    // this write-last ordering is what actually makes the guarantee structural.
    applyAspireOwnedFields(configuration, launchOptions, debuggerExtension);

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
 * Fields on the resource debug configuration that Aspire owns, and that the workspace
 * `debuggers` setting must never influence.
 *
 * These are not user-facing knobs. They correlate the VS Code session with the DCP run
 * (`runId`, `debugSessionId`), decide which event ends the run and therefore who reports it
 * (`terminationSignal`), and select AppHost-specific behavior (`isApphost`).
 *
 * Letting workspace-controlled JSON reach any of them is a safety problem rather than just a
 * confusing override:
 *
 * - `runId` is used to derive an on-disk scratch directory that is later deleted recursively
 *   (`getBrowserUserDataDir` in `languages/browser.ts`), so a workspace-supplied `runId` could
 *   aim that delete outside the directory Aspire owns.
 * - `debugSessionId` is written as `dcp_id` onto DCP wire notifications, so a workspace-supplied
 *   value would let settings address another run's lifecycle messages.
 * - `terminationSignal` decides whether the adapter tracker or the debug session emits
 *   `sessionTerminated`, so a workspace-supplied value could suppress or duplicate the terminal
 *   notification for resource types whose callbacks never set it (`node`, `dotnet`, ...).
 */
const aspireOwnedDebugConfigurationFieldNames: readonly string[] = [
    'runId',
    'debugSessionId',
    'terminationSignal',
    'isApphost'
];

const aspireOwnedDebugConfigurationFields: ReadonlySet<string> = new Set<string>(aspireOwnedDebugConfigurationFieldNames);

function applyAspireOwnedFields(configuration: AspireResourceExtendedDebugConfiguration, launchOptions: LaunchOptions, debuggerExtension: ResourceDebuggerExtension): void {
    configuration.runId = launchOptions.runId;
    configuration.debugSessionId = launchOptions.debugSessionId;
    configuration.isApphost = launchOptions.isApphost;
    // Declared by the debugger integration at authoring time, never taken from the configuration
    // object, so workspace settings have no path to it.
    configuration.terminationSignal = debuggerExtension.terminationSignal;
}

/**
 * Merges a workspace `debuggers.<key>` block into the generated debug configuration, refusing the
 * fields Aspire owns.
 *
 * `DebugLaunchSettings` declares only user-facing properties, but the value comes from unvalidated
 * `launch.json` JSON and the contributed schema for `debuggers` is an open object, so arbitrary
 * keys reach this code at runtime. Unknown keys are still forwarded on purpose: passing extra
 * options through to the underlying debug adapter is the feature. Only the Aspire-owned fields are
 * refused, and refusing them is logged rather than silent so a workspace author can see why their
 * setting had no effect.
 */
function applyUserDebuggerSettings(configuration: AspireResourceExtendedDebugConfiguration, settings: DebugLaunchSettings): void {
    for (const [key, value] of Object.entries(settings)) {
        if (aspireOwnedDebugConfigurationFields.has(key)) {
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
