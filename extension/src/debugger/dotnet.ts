import * as vscode from 'vscode';
import { DebugOptions, EnvVar, startAndGetDebugSession } from './common';
import { extensionLogOutputChannel } from '../utils/logging';
import { debugProject } from '../loc/strings';
import { execFile } from 'child_process';
import * as util from 'util';
import { mergeEnvs } from '../utils/environment';
import * as path from 'path';
import { getAspireTerminal } from '../utils/terminal';

export async function startDotNetProgram(projectFile: string, workingDirectory: string, args: string[], env: EnvVar[], debugOptions: DebugOptions): Promise<vscode.DebugSession | vscode.Terminal | undefined> {
    try {
        await buildDotNetProject(projectFile);
        const outputPath = await getDotnetTargetPath(projectFile);

        if (!debugOptions.debug) {
            throw new Error('Run without debug is not currently supported.');
        }

        const config: vscode.DebugConfiguration = {
            type: 'coreclr',
            request: 'launch',
            name: debugProject(path.basename(projectFile)),
            program: outputPath,
            args: args,
            cwd: workingDirectory,
            env: mergeEnvs(process.env, env),
            justMyCode: false,
            stopAtEntry: false,
        };

        // The build task brings the build terminal to the foreground. If build has succeeded,
        // we should then bring the Aspire terminal to the terminal foreground as it's actively running. 
        getAspireTerminal().show(true);

        return await startAndGetDebugSession(config);
    }
    catch (error) {
        if (error instanceof Error) {
            extensionLogOutputChannel.error(`Failed to start project: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to start project: ${error.message}`);
            return undefined;
        }
    }
}

async function buildDotNetProject(projectFile: string): Promise<void> {
    const csharpDevKit = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
    if (!csharpDevKit) {
        vscode.window.showErrorMessage('C# Dev Kit is not installed. Please install it from the marketplace.');
        return Promise.reject(new Error('C# Dev Kit is not installed. Please install it from the marketplace.'));
    }

    if (!csharpDevKit.isActive) {
        extensionLogOutputChannel.info('Activating C# Dev Kit extension...');
        await csharpDevKit.activate();
    }

    // C# Dev Kit may not register the build task immediately, so we need to retry until it is available
    const pRetry = (await import('p-retry')).default;
    await pRetry(async () => {
        const tasks = await vscode.tasks.fetchTasks();
        const buildTask = tasks.find(t => t.name?.includes('build'));
        if (!buildTask) {
            throw new Error('No C# Dev Kit build task found.');
        }
    });

    const tasks = await vscode.tasks.fetchTasks();
    const buildTask = tasks.find(t => t.name?.includes('build'));
    if (!buildTask) {
        return Promise.reject(new Error('No watch task found. Please ensure a watch task is defined in your workspace.'));
    }

    extensionLogOutputChannel.info(`Executing build task: ${buildTask.name} for project: ${projectFile}`);
    await vscode.tasks.executeTask(buildTask);

    return new Promise<void>((resolve, reject) => {
        vscode.tasks.onDidEndTaskProcess(async e => {
            if (e.execution.task === buildTask) {
                if (e.exitCode !== 0) {
                    reject(new Error(`Build failed with exit code ${e.exitCode}`));
                }
                else {
                    vscode.window.showInformationMessage(`Build succeeded for project ${projectFile}. Attempting to locate output dll...`);
                    return resolve();
                }
            }
        });
    });
}

const execFileAsync = util.promisify(execFile);

async function getDotnetTargetPath(projectFile: string): Promise<string> {
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
            throw new Error('No output from msbuild');
        }

        return output;
    } catch (err) {
        throw new Error(`Failed to get TargetPath: ${err}`);
    }
}