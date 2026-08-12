import * as fs from 'fs';
import http = require('http');
import https = require('https');
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isAzureFunctionsLaunchConfiguration } from '../../dcp/types';
import {
    azureFunctionsCmdDelayedExpansion,
    azureFunctionsCmdPercentArgument,
    azureFunctionsHostStartupTimedOut,
    azureFunctionsTaskExitedBeforeStartup,
    azureFunctionsUnsupportedTaskShell,
    azureFunctionsWorkerStartupTimedOut,
    invalidLaunchConfiguration
} from '../../loc/strings';
import { assertNoTerminalControlCharacters, quoteShellArg } from '../../utils/AspireTerminalProvider';
import { quoteCmdArgument } from '../../utils/cmdShim';
import { extensionLogOutputChannel } from '../../utils/logging';
import { AlreadyStartedResourceDebugSession, ResourceDebuggerExtension } from '../debuggerExtensions';
import { DotNetService } from './dotnet';
import { cleanupRun, registerRunCleanup } from '../runCleanupRegistry';

const AF_EXTENSION_ID = 'ms-azuretools.vscode-azurefunctions';
const DEFAULT_PICK_PROCESS_TIMEOUT_SECONDS = 30;
const FUNC_HOST_DEFAULT_PORT = 7071;
const POLL_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 1_000;

type FuncHostTaskShell = 'cmd' | 'fish' | 'powershell' | 'posix';

type TerminalProfileConfiguration = {
    path?: string | string[];
    source?: string;
};

/** Tracks worker PIDs by runId for cleanup. */
const workerPidsByRunId = new Map<string, number>();

/** Tracks the VS Code Task executions (func host start) by runId for cleanup. */
const taskExecutionsByRunId = new Map<string, vscode.TaskExecution>();

/** Tracks debug metadata directories by runId for cleanup. */
const tempDirectoriesByRunId = new Map<string, string>();

/** Kill the func host task and worker process for the given runId, if any. */
function killFuncProcess(runId: string): void {
    // Terminate the VS Code Task running "func host start"
    const taskExecution = taskExecutionsByRunId.get(runId);
    if (taskExecution) {
        extensionLogOutputChannel.info(`Terminating func host task for runId ${runId}`);
        taskExecution.terminate();
        taskExecutionsByRunId.delete(runId);
    }

    // Also kill the worker PID directly in case task termination doesn't propagate
    const pid = workerPidsByRunId.get(runId);
    if (pid !== undefined) {
        extensionLogOutputChannel.info(`Killing func worker process for runId ${runId} (pid: ${pid})`);
        try {
            process.kill(pid);
        } catch {
            // Process may already be dead
        }
        workerPidsByRunId.delete(runId);
    }

    const tempDirectory = tempDirectoriesByRunId.get(runId);
    if (tempDirectory) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
        tempDirectoriesByRunId.delete(runId);
    }
}

async function activateAzureFunctionsExtension(): Promise<void> {
    const extension = vscode.extensions.getExtension(AF_EXTENSION_ID);
    if (!extension) {
        throw new Error(`Azure Functions extension (${AF_EXTENSION_ID}) is not installed`);
    }

    // Activating the extension registers its `func` task definition and listeners.
    // Do not use startFuncProcess: vscode-azurefunctions 1.22.0 creates an unregistered
    // dynamic task type that VS Code 1.130 and later reject before Core Tools starts.
    await extension.activate();
}

function getPickProcessTimeoutSeconds(): number {
    const configuredTimeout = vscode.workspace.getConfiguration('azureFunctions').get<number>('pickProcessTimeout');
    return typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_PICK_PROCESS_TIMEOUT_SECONDS;
}

function getFuncHostPort(args: string[]): number {
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if ((argument === '--port' || argument === '-p') && index + 1 < args.length) {
            const port = Number(args[index + 1]);
            if (Number.isInteger(port) && port > 0 && port <= 65_535) {
                return port;
            }
        }

        const match = /^(?:--port|-p)=(\d+)$/.exec(argument);
        if (match) {
            const port = Number(match[1]);
            if (port > 0 && port <= 65_535) {
                return port;
            }
        }
    }

    return FUNC_HOST_DEFAULT_PORT;
}

function createFuncTask(rawArgs: string[], quotedArgs: string[], buildOutputPath: string, env: Record<string, string>): vscode.Task {
    const commandLine = ['func', 'host', 'start', ...quotedArgs].join(' ');
    return new vscode.Task(
        { type: 'func', command: 'host start', args: rawArgs },
        vscode.TaskScope.Workspace,
        'func: host start',
        'func',
        new vscode.ShellExecution(commandLine, {
            cwd: buildOutputPath,
            env
        }));
}

function createTaskExitError(exitCode: number): Error {
    return new Error(azureFunctionsTaskExitedBeforeStartup(exitCode));
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function probeFuncHostStatus(protocol: typeof http | typeof https, port: number): Promise<boolean> {
    return await new Promise(resolve => {
        const request = protocol.request({
            hostname: '127.0.0.1',
            port,
            path: '/admin/host/status',
            method: 'GET',
            rejectUnauthorized: false
        }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                resolve(false);
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => body += chunk);
            response.on('end', () => {
                try {
                    const state = (JSON.parse(body) as { state?: unknown }).state;
                    resolve(typeof state === 'string' && state.toLowerCase() === 'running');
                } catch {
                    resolve(false);
                }
            });
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            resolve(false);
            request.destroy();
        });
        request.on('error', () => resolve(false));
        request.end();
    });
}

async function waitForFuncHostRunning(port: number, deadline: number, timeoutSeconds: number): Promise<void> {
    while (Date.now() < deadline) {
        if (await probeFuncHostStatus(http, port) || await probeFuncHostStatus(https, port)) {
            return;
        }

        await delay(POLL_INTERVAL_MS);
    }

    throw new Error(azureFunctionsHostStartupTimedOut(timeoutSeconds, port));
}

function getJsonOutputFileArgument(args: string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--json-output-file') {
            return args[index + 1];
        }

        const match = /^--json-output-file=(.+)$/.exec(argument);
        if (match) {
            return match[1];
        }
    }

    return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
    return args.some(argument => argument === flag || argument.startsWith(`${flag}=`));
}

function readWorkerProcessId(jsonOutputFile: string): number | undefined {
    try {
        // Core Tools emits newline-delimited JSON. For example:
        //   {"name":"dotnet-worker-startup","workerProcessId":4242}
        // The file may contain unrelated or partially-written lines while the host starts.
        for (const line of fs.readFileSync(jsonOutputFile, 'utf8').split(/\r?\n/)) {
            if (!line) {
                continue;
            }

            try {
                const event = JSON.parse(line) as { name?: unknown; workerProcessId?: unknown };
                if (event.name === 'dotnet-worker-startup' &&
                    typeof event.workerProcessId === 'number' &&
                    Number.isInteger(event.workerProcessId) &&
                    event.workerProcessId > 0) {
                    return event.workerProcessId;
                }
            } catch {
                // The final NDJSON line may still be in flight.
            }
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
            extensionLogOutputChannel.warn(`Failed to read Azure Functions worker startup JSON: ${error}`);
        }
    }

    return undefined;
}

async function waitForWorkerProcessId(jsonOutputFile: string, deadline: number, timeoutSeconds: number): Promise<number> {
    while (Date.now() < deadline) {
        const workerProcessId = readWorkerProcessId(jsonOutputFile);
        if (workerProcessId !== undefined) {
            return workerProcessId;
        }

        await delay(POLL_INTERVAL_MS);
    }

    throw new Error(azureFunctionsWorkerStartupTimedOut(timeoutSeconds));
}

function quoteFuncHostArguments(args: string[] | undefined): string[] {
    const funcHostArgs = args ?? [];
    for (const argument of funcHostArgs) {
        assertNoTerminalControlCharacters(argument);
    }

    // These characters have the same literal meaning in the supported task shells.
    // Avoid resolving the configured shell when no argument needs shell-specific quoting.
    if (funcHostArgs.every(argument => /^[A-Za-z0-9_./:-]+$/.test(argument))) {
        return funcHostArgs;
    }

    const shell = getFuncHostTaskShell();
    return funcHostArgs.map(argument => quoteFuncHostArgument(argument, shell));
}

function quoteFuncHostArgument(argument: string, shell: FuncHostTaskShell): string {
    // Keep ordinary flags and paths unchanged so the Azure Functions extension can
    // still inspect exact flag values before it flattens the array for ShellExecution.
    const isShellSafe = shell === 'posix' || shell === 'fish'
        ? /^[A-Za-z0-9_./:-]+$/.test(argument)
        : /^[A-Za-z0-9_./:\\-]+$/.test(argument);
    if (isShellSafe) {
        return argument;
    }

    if (shell === 'cmd') {
        // cmd.exe expands %NAME% even inside double quotes. There is no command-line
        // escape that preserves an arbitrary percent sequence before a .cmd shim runs.
        if (argument.includes('%')) {
            throw new Error(azureFunctionsCmdPercentArgument);
        }

        // Delayed expansion can be enabled by the terminal profile or the Command
        // Processor registry settings. No quoting form preserves arbitrary !
        // sequences through a .cmd shim under both expansion modes.
        if (argument.includes('!')) {
            throw new Error(azureFunctionsCmdDelayedExpansion);
        }

        return quoteCmdArgument(argument);
    }

    if (shell === 'fish') {
        // Fish only recognizes \' and \\ inside single quotes, so escape both before
        // wrapping the argument. See https://fishshell.com/docs/current/language.html#quotes.
        return `'${argument.replace(/[\\']/g, value => `\\${value}`)}'`;
    }

    return quoteShellArg(argument, shell === 'powershell' ? 'win32' : 'linux');
}

function getFuncHostTaskShell(): FuncHostTaskShell {
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const terminalConfiguration = vscode.workspace.getConfiguration('terminal.integrated');
    const automationProfile = terminalConfiguration.get<TerminalProfileConfiguration | null>(`automationProfile.${platform}`);
    if (automationProfile) {
        return classifyFuncHostTaskShell(automationProfile) ?? throwUnsupportedTaskShell();
    }

    const defaultProfileName = terminalConfiguration.get<string>(`defaultProfile.${platform}`);
    if (defaultProfileName) {
        const profiles = terminalConfiguration.get<Record<string, TerminalProfileConfiguration | null>>(`profiles.${platform}`);
        const defaultProfile = profiles?.[defaultProfileName] ?? undefined;
        return classifyFuncHostTaskShell(defaultProfile, defaultProfileName) ?? throwUnsupportedTaskShell();
    }

    if (process.platform === 'win32') {
        // PowerShell is VS Code's Windows task-shell default when no automation or
        // default profile is configured.
        return 'powershell';
    }

    const loginShell = process.env.SHELL;
    if (!loginShell) {
        return 'posix';
    }

    return classifyFuncHostTaskShell({ path: loginShell }) ?? throwUnsupportedTaskShell();
}

function classifyFuncHostTaskShell(profile: TerminalProfileConfiguration | undefined, profileName?: string): FuncHostTaskShell | undefined {
    const paths = typeof profile?.path === 'string' ? [profile.path] : profile?.path ?? [];
    const identity = [profileName, profile?.source, ...paths].filter((value): value is string => !!value).join(' ').toLowerCase();

    if (identity.includes('powershell') || identity.includes('pwsh')) {
        return 'powershell';
    }

    if (identity.includes('command prompt') || /(?:^|[\\/\s])cmd(?:\.exe)?(?:$|\s)/.test(identity)) {
        return 'cmd';
    }

    if (/(?:^|[\\/\s])fish(?:\.exe)?(?:$|\s)/.test(identity)) {
        return 'fish';
    }

    if (identity.includes('git bash') || identity.includes('wsl') || identity.includes('cygwin') || identity.includes('msys') ||
        /(?:^|[\\/\s])(ba|z|fi|k)?sh(?:\.exe)?(?:$|\s)/.test(identity)) {
        return 'posix';
    }

    return undefined;
}

function throwUnsupportedTaskShell(): never {
    throw new Error(azureFunctionsUnsupportedTaskShell);
}

export const azureFunctionsDebuggerExtension: ResourceDebuggerExtension = {
    resourceType: 'azure-functions',
    debugAdapter: 'coreclr',
    extensionId: 'ms-dotnettools.csharp',
    getDisplayName: (launchConfig: ExecutableLaunchConfiguration) => {
        if (isAzureFunctionsLaunchConfiguration(launchConfig) && launchConfig.project_path) {
            return `Azure Functions: ${path.basename(launchConfig.project_path)}`;
        }
        return 'Azure Functions';
    },
    getSupportedFileTypes: () => ['.cs', '.csproj'],
    getProjectFile: (launchConfig) => {
        if (isAzureFunctionsLaunchConfiguration(launchConfig)) {
            return launchConfig.project_path;
        }
        throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
    },
    createDebugSessionConfigurationCallback: async (launchConfig, args, env, launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<AlreadyStartedResourceDebugSession | void> => {
        if (!isAzureFunctionsLaunchConfiguration(launchConfig)) {
            extensionLogOutputChannel.info(`The resource type was not azure-functions for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        const runId = debugConfiguration.runId;
        const projectPath = launchConfig.project_path;
        const dotNetService = new DotNetService(launchOptions.debugSession);
        // project_path from the hosting integration is currently a .csproj file path
        // (resolved by AzureFunctionsProjectMetadata.ResolveProjectPath). If Aspire
        // later supports non-.NET Functions resources, that launch config should carry
        // an explicit language/build contract instead of reusing this .NET project path.
        // Always build because path-based Functions resources do not have to be ProjectReferences
        // of the AppHost, so an existing target can be stale even after the AppHost was rebuilt.
        extensionLogOutputChannel.info(`Building Azure Functions project before starting func host: ${projectPath}`);
        await dotNetService.buildDotNetProject(projectPath);
        const targetPath = await dotNetService.getDotNetTargetPath(projectPath);
        const buildOutputPath = path.dirname(targetPath);
        extensionLogOutputChannel.info(`Starting Azure Functions project with a registered func task: ${projectPath} (buildPath: ${buildOutputPath})`);

        // ShellExecution inherits the VS Code process environment. Only add the
        // DCP-specific values so the task environment stays equivalent to the old path.
        const dcpEnv = Object.fromEntries(
            (env ?? []).filter(e => e.value !== undefined).map(e => [e.name, e.value])
        );

        await activateAzureFunctionsExtension();
        registerRunCleanup(runId, () => killFuncProcess(runId));
        const rawArgs = [...(args ?? [])];
        let jsonOutputFile: string | undefined;
        if (launchOptions.debug) {
            const secureTempRoot = fs.realpathSync(os.tmpdir());
            const tempDirectory = fs.mkdtempSync(path.join(secureTempRoot, 'aspire-functions-debug-'));
            tempDirectoriesByRunId.set(runId, tempDirectory);
            jsonOutputFile = getJsonOutputFileArgument(rawArgs) ?? path.join(tempDirectory, 'worker-startup.json');
            if (!hasFlag(rawArgs, '--dotnet-isolated-debug')) {
                rawArgs.push('--dotnet-isolated-debug');
            }
            if (!hasFlag(rawArgs, '--enable-json-output')) {
                rawArgs.push('--enable-json-output');
            }
            if (!getJsonOutputFileArgument(rawArgs)) {
                rawArgs.push('--json-output-file', jsonOutputFile);
            }
        }

        let quotedArgs: string[];
        try {
            quotedArgs = quoteFuncHostArguments(rawArgs);
        } catch (error) {
            cleanupRun(runId);
            throw error;
        }

        let funcTask: vscode.Task;
        let funcExecution: vscode.TaskExecution | undefined;
        let taskProcessId: number | undefined;
        let resolveTaskStarted: (() => void) | undefined;
        const taskStarted = new Promise<void>(resolve => resolveTaskStarted = resolve);
        let taskExitCode: number | undefined;
        let resolveTaskExited: ((exitCode: number) => void) | undefined;
        const taskExited = new Promise<number>(resolve => resolveTaskExited = resolve);
        let completeSession: ((exitCode: number) => void) | undefined;
        let completed = false;
        const complete = (exitCode: number): void => {
            if (completed) {
                return;
            }

            completed = true;
            cleanupRun(runId);
            completeSession?.(exitCode);
        };

        // Register both process listeners before executeTask so a fast task start or
        // exit cannot race listener registration. Before executeTask resolves, task
        // object identity identifies this launch; afterward only its exact execution
        // is accepted.
        const taskStartSubscription = vscode.tasks.onDidStartTaskProcess(event => {
            if (funcExecution && event.execution !== funcExecution) {
                return;
            }
            if (!funcExecution && event.execution.task !== funcTask) {
                return;
            }

            funcExecution = event.execution;
            taskProcessId = event.processId;
            taskExecutionsByRunId.set(runId, event.execution);
            resolveTaskStarted?.();
        });
        const taskEndSubscription = vscode.tasks.onDidEndTaskProcess(event => {
            if (funcExecution && event.execution !== funcExecution) {
                return;
            }
            if (!funcExecution && event.execution.task !== funcTask) {
                return;
            }

            funcExecution ??= event.execution;
            taskExitCode = event.exitCode ?? 0;
            resolveTaskExited?.(taskExitCode);
            if (!launchOptions.debug && completeSession) {
                let normalizedExitCode = taskExitCode;
                // Exit code 143 is SIGTERM on macOS and Linux, matching the normal
                // debug-adapter termination path in adapterTracker.
                if ((process.platform === 'darwin' || process.platform === 'linux') && normalizedExitCode === 143) {
                    normalizedExitCode = 0;
                }
                complete(normalizedExitCode);
            }
        });

        funcTask = createFuncTask(rawArgs, quotedArgs, buildOutputPath, dcpEnv);
        let startupTimeout: NodeJS.Timeout | undefined;
        try {
            const timeoutSeconds = getPickProcessTimeoutSeconds();
            const startupDeadline = Date.now() + timeoutSeconds * 1_000;
            const startupTimedOut = new Promise<never>((_, reject) => {
                startupTimeout = setTimeout(() => reject(new Error(launchOptions.debug
                    ? azureFunctionsWorkerStartupTimedOut(timeoutSeconds)
                    : azureFunctionsHostStartupTimedOut(timeoutSeconds, getFuncHostPort(rawArgs)))), timeoutSeconds * 1_000);
            });
            funcExecution = await vscode.tasks.executeTask(funcTask);
            taskExecutionsByRunId.set(runId, funcExecution);
            if (!taskProcessId) {
                await Promise.race([
                    taskStarted,
                    taskExited.then(exitCode => Promise.reject(createTaskExitError(exitCode))),
                    startupTimedOut
                ]);
            }

            const readiness = launchOptions.debug
                ? waitForWorkerProcessId(jsonOutputFile!, startupDeadline, timeoutSeconds)
                : waitForFuncHostRunning(getFuncHostPort(rawArgs), startupDeadline, timeoutSeconds).then(() => taskProcessId!);
            const processId = await Promise.race([
                readiness,
                taskExited.then(exitCode => Promise.reject(createTaskExitError(exitCode))),
                startupTimedOut
            ]);
            if (launchOptions.debug && taskExitCode !== undefined) {
                throw createTaskExitError(taskExitCode);
            }
            if (launchOptions.debug) {
                workerPidsByRunId.set(runId, processId);
            }
            extensionLogOutputChannel.info(`Azure Functions process started for runId ${runId} (PID: ${processId})`);

            if (!launchOptions.debug) {
                const termination = new Promise<number>(resolve => completeSession = resolve);
                if (taskExitCode !== undefined) {
                    let normalizedExitCode = taskExitCode;
                    if ((process.platform === 'darwin' || process.platform === 'linux') && normalizedExitCode === 143) {
                        normalizedExitCode = 0;
                    }
                    complete(normalizedExitCode);
                }

                return {
                    id: runId,
                    processId,
                    session: { id: runId } as vscode.DebugSession,
                    stopSession: async () => {
                        complete(-1);
                    },
                    termination
                };
            }

            debugConfiguration.type = 'coreclr';
            debugConfiguration.request = 'attach';
            debugConfiguration.processId = String(processId);

            delete debugConfiguration.program;
            delete debugConfiguration.args;
            delete debugConfiguration.cwd;
            delete debugConfiguration.console;
            delete debugConfiguration.env;
        } catch (error) {
            cleanupRun(runId);
            throw error;
        } finally {
            if (startupTimeout) {
                clearTimeout(startupTimeout);
            }
            taskStartSubscription.dispose();
            if (launchOptions.debug || completed) {
                taskEndSubscription.dispose();
            } else {
                registerRunCleanup(runId, () => taskEndSubscription.dispose());
            }
        }
    }
};
