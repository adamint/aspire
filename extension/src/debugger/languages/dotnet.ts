import * as vscode from 'vscode';
import { extensionLogOutputChannel } from '../../utils/logging';
import { debugProject, noCsharpBuildTask, noWatchTask, buildFailedWithExitCode, buildSucceeded, noOutputFromMsbuild, failedToGetTargetPath, csharpSupportNotEnabled, failedToStartProject } from '../../loc/strings';
import { execFile } from 'child_process';
import * as util from 'util';
import { mergeEnvs } from '../../utils/environment';
import * as path from 'path';
import { doesFileExist } from '../../utils/io';
import { getSupportedCapabilities } from '../../capabilities';
import { EnvVar, LaunchOptions, AspireResourceDebugSession, AspireExtendedDebugConfiguration } from '../../dcp/types';
import { extensionContext } from '../../extension';

const execFileAsync = util.promisify(execFile);

export async function startDotNetProgram(projectFile: string, workingDirectory: string, args: string[], env: EnvVar[], launchOptions: LaunchOptions): Promise<AspireResourceDebugSession | undefined> {
    try {
        const outputPath = await getDotNetTargetPath(projectFile);

        if (!(await doesFileExist(outputPath)) || launchOptions.forceBuild) {
            await buildDotNetProject(projectFile);
        }

        if (!getSupportedCapabilities().includes('csharp')) {
            throw new Error(csharpSupportNotEnabled);
        }

        const config: AspireExtendedDebugConfiguration = {
            type: 'coreclr',
            request: 'launch',
            name: debugProject(path.basename(projectFile)),
            program: outputPath,
            args: args,
            cwd: workingDirectory,
            env: mergeEnvs(process.env, env),
            justMyCode: false,
            stopAtEntry: false,
            noDebug: !launchOptions.debug,
            runId: launchOptions.runId,
            dcpId: launchOptions.dcpId,
            console: 'internalConsole'
        };

        return await extensionContext.aspireDebugSession.startAndGetDebugSession(config);
    }
    catch (error) {
        if (error instanceof Error) {
            extensionLogOutputChannel.error(failedToStartProject(error.message));
            vscode.window.showErrorMessage(`Failed to start project: ${error.message}`);
            return undefined;
        }
    }
}

async function buildDotNetProject(projectFile: string): Promise<void> {
    const csharpDevKit = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
    if (!csharpDevKit) {
        // If c# dev kit is not installed, we will have already built this project on the command line using the Aspire CLI
        // thus we should just immediately return
        return Promise.resolve();
    }

    if (!csharpDevKit.isActive) {
        extensionLogOutputChannel.info('Activating C# Dev Kit extension...');
        await csharpDevKit.activate();
    }

    // C# Dev Kit may not register the build task immediately, so we need to retry until it is available
    const pRetry = (await import('p-retry')).default;
    const buildTask = await pRetry(async () => {
        const tasks = await vscode.tasks.fetchTasks();
        const buildTask = tasks.find(t => t.source === "dotnet" && t.name?.includes('build'));
        if (!buildTask) {
            throw new Error(noCsharpBuildTask);
        }

        return buildTask;
    });

    extensionLogOutputChannel.info(`Executing build task: ${buildTask.name} for project: ${projectFile}`);
    await vscode.tasks.executeTask(buildTask);

    return new Promise<void>((resolve, reject) => {
        vscode.tasks.onDidEndTaskProcess(async e => {
            if (e.execution.task === buildTask) {
                if (e.exitCode !== 0) {
                    reject(new Error(buildFailedWithExitCode(e.exitCode ?? 0)));
                }
                else {
                    vscode.window.showInformationMessage(buildSucceeded(projectFile));
                    return resolve();
                }
            }
        });
    });
}

async function getDotNetTargetPath(projectFile: string): Promise<string> {
    const args = [
        'msbuild',
        projectFile,
        '-nologo',
        '-getProperty:TargetPath',
        '-v:q',
        '-property:GenerateFullPaths=true'
    ];
    try {
        const { stdout } = await execFileAsync('dotnet', args, { encoding: 'utf8' });
        const output = stdout.trim();
        if (!output) {
            throw new Error(noOutputFromMsbuild);
        }

        return output;
    } catch (err) {
        throw new Error(failedToGetTargetPath(String(err)));
    }
}
