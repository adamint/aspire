import * as path from 'path';
import * as vscode from 'vscode';
import { javaDebugExtensionId, javaLanguageExtensionId } from '../../capabilities';
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isJavaLaunchConfiguration, JavaLaunchConfiguration } from "../../dcp/types";
import { invalidLaunchConfiguration, javaDisplayName, javaLabel } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";

// Commands contributed by redhat.java. They only exist once the language server has activated, so
// every call site has to tolerate them being missing.
const JAVA_EXECUTE_WORKSPACE_COMMAND = 'java.execute.workspaceCommand';
const JAVA_RESOLVE_BUILD_FILES_COMMAND = 'vscode.java.resolveBuildFiles';
const JAVA_PROJECT_CONFIGURATION_UPDATE_COMMAND = 'java.projectConfiguration.update';

// Subset of the redhat.java extension API surface we use.
// https://github.com/redhat-developer/vscode-java#extension-api
interface JavaExtensionApi {
    serverMode: string;
    serverReady: () => Promise<boolean>;
}

async function getJavaExtensionApi(): Promise<JavaExtensionApi | null> {
    const extension = vscode.extensions.getExtension<JavaExtensionApi>(javaLanguageExtensionId);

    if (!extension) {
        return null;
    }

    if (!extension.isActive) {
        // Activation can fail (no JDK, corrupt workspace metadata, ...). Treat that the same as the
        // extension being absent so the launch can still proceed without classpath refresh.
        await extension.activate();
    }

    return extension.exports ?? null;
}

async function waitForJavaLanguageServerReady(): Promise<boolean> {
    try {
        const api = await getJavaExtensionApi();

        if (!api) {
            extensionLogOutputChannel.warn(`The Java language server (${javaLanguageExtensionId}) is not installed or exposes no API.`);
            return false;
        }

        extensionLogOutputChannel.info(`Java language server is in ${api.serverMode} mode, waiting for readiness...`);

        return await api.serverReady();
    } catch (e) {
        extensionLogOutputChannel.warn(`Error waiting for Java language server readiness: ${e}`);
    }

    return false;
}

async function updateJavaProjectConfiguration(buildTool: string): Promise<void> {
    const buildFiles = await vscode.commands.executeCommand<string[]>(
        JAVA_EXECUTE_WORKSPACE_COMMAND,
        JAVA_RESOLVE_BUILD_FILES_COMMAND
    );

    if (!buildFiles?.length) {
        extensionLogOutputChannel.info(`The Java language server reported no ${buildTool} build files to refresh.`);
        return;
    }

    extensionLogOutputChannel.info(`Updating ${buildTool} project configuration for ${buildFiles.length} build file(s)...`);

    for (const buildFile of buildFiles) {
        await vscode.commands.executeCommand(JAVA_PROJECT_CONFIGURATION_UPDATE_COMMAND, vscode.Uri.parse(buildFile));
    }
}

// Refreshing the classpath is a convenience for fresh clones and for projects whose build files
// changed since the language server last imported them; nothing about launching depends on it.
// redhat.java is therefore treated as optional at runtime: when it is missing or still starting, its
// commands are not registered and executeCommand rejects with "command not found", which would
// otherwise surface as an opaque failure that aborts the whole resource launch.
async function tryRefreshJavaProjectConfiguration(launchConfig: JavaLaunchConfiguration): Promise<void> {
    // A null build_tool means the resource runs a prebuilt JAR, so there are no build files to
    // reimport and no reason to pay for language server startup.
    if (!launchConfig.build_tool) {
        extensionLogOutputChannel.info('Skipping Java project configuration refresh because the resource does not declare a build tool.');
        return;
    }

    if (!await waitForJavaLanguageServerReady()) {
        extensionLogOutputChannel.warn(`Skipping the ${launchConfig.build_tool} project configuration refresh because the Java language server is unavailable. Launching anyway.`);
        return;
    }

    try {
        await updateJavaProjectConfiguration(launchConfig.build_tool);
    } catch (e) {
        extensionLogOutputChannel.warn(`Failed to refresh the ${launchConfig.build_tool} project configuration: ${e}. Launching anyway.`);
    }
}

// path.isAbsolute resolves against the *host* platform, but the app host can hand us a Windows path
// while the extension runs on POSIX (remote/WSL/container scenarios), so check both flavours.
// path.win32.isAbsolute also accepts POSIX-rooted paths, but being explicit keeps the intent clear.
function isAbsolutePath(value: string): boolean {
    return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

// main_class is either a fully qualified class name (com.example.Api) or the absolute path of an
// executable JAR whose manifest declares Main-Class (/workspace/api/target/api.jar). Only the class
// name is worth showing in the Call Stack view; the JAR path is less specific than the project
// directory the user recognises.
function isFullyQualifiedClassName(mainClass: string): boolean {
    return mainClass.includes('.')
        && !mainClass.toLowerCase().endsWith('.jar')
        && !isAbsolutePath(mainClass);
}

function getProjectFile(launchConfig: ExecutableLaunchConfiguration): string {
    if (isJavaLaunchConfiguration(launchConfig)) {
        // The Java project directory is the only path the app host sends. It also feeds the central
        // cwd derivation in prepareDebugSession, which the callback below then overrides explicitly.
        return launchConfig.working_directory || '';
    }

    throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
}

export const javaDebuggerExtension: ResourceDebuggerExtension = {
    resourceType: 'java',
    debugAdapter: 'java',
    extensionId: javaDebugExtensionId,

    getDisplayName: (launchConfig: ExecutableLaunchConfiguration) => {
        if (!isJavaLaunchConfiguration(launchConfig)) {
            return javaLabel;
        }

        const mainClass = launchConfig.main_class;
        if (mainClass && isFullyQualifiedClassName(mainClass)) {
            return javaDisplayName(mainClass);
        }

        // asRelativePath keeps the Call Stack view readable. Rendering the directory through
        // vscode.Uri.file(...).toString() instead produces a percent-encoded URI such as
        // "Java: file:///c%3A/repo/api".
        const workingDirectory = launchConfig.working_directory;

        return workingDirectory ? javaDisplayName(vscode.workspace.asRelativePath(workingDirectory)) : javaLabel;
    },

    getSupportedFileTypes: () => ['.java'],

    getProjectFile: (launchConfig) => getProjectFile(launchConfig),

    createDebugSessionConfigurationCallback: async (
        launchConfig: ExecutableLaunchConfiguration,
        args: string[] | undefined,
        _env: { name: string; value: string }[],
        launchOptions: { debug: boolean;[key: string]: any },
        debugConfiguration: AspireResourceExtendedDebugConfiguration
    ): Promise<void> => {
        if (!isJavaLaunchConfiguration(launchConfig)) {
            extensionLogOutputChannel.info(`The resource type was not java for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        await tryRefreshJavaProjectConfiguration(launchConfig);

        debugConfiguration.type = 'java';
        // The app host always sends "launch" today, but the wire schema allows "attach", so honour
        // whatever it sends rather than hard-coding the current behaviour.
        debugConfiguration.request = launchConfig.request ?? 'launch';
        debugConfiguration.noDebug = !launchOptions.debug;

        if (launchConfig.working_directory) {
            debugConfiguration.cwd = launchConfig.working_directory;
        }

        // vscjava.vscode-java-debug requires mainClass to start a launch session, and accepts either
        // a fully qualified class name or the absolute path of an executable JAR. When the app host
        // omits it, leaving the attribute unset lets the adapter resolve the entry point from the
        // project instead of failing on an empty value.
        // https://github.com/microsoft/vscode-java-debug/blob/main/Configuration.md#main
        //
        // projectName is intentionally not set: the adapter defines it as the Maven artifactId or
        // the Gradle baseName, neither of which can be derived from working_directory, and guessing
        // it would scope class resolution to a project that may not exist.
        if (launchConfig.main_class) {
            debugConfiguration.mainClass = launchConfig.main_class;
        }

        // These are the application's own arguments. The app host strips the mvnw/gradlew wrapper
        // arguments for java launch configurations (the wrappers fork a second JVM that a debugger
        // attached to the wrapper would never see), so everything left here belongs to main(String[]).
        // https://github.com/microsoft/vscode-java-debug/blob/main/Configuration.md#arguments
        debugConfiguration.args = args ?? [];

        // `env` is deliberately left alone. prepareDebugSession already set it to
        // mergeEnvs(getEnvironmentWithoutE2EBridgeVariables(), env), i.e. the full inherited
        // environment with the resource's variables layered on top. Reassigning it from `env` alone
        // would launch the JVM without PATH or JAVA_HOME, so the adapter could not find `java`.
    }
};
