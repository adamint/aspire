import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export async function resolveAppHostLaunchPath(filePath: string): Promise<string> {
    if (path.extname(filePath).toLowerCase() !== '.cs') {
        return filePath;
    }

    let fileText: string;
    try {
        fileText = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(buffer => buffer.toString());
    }
    catch {
        return filePath;
    }

    const lines = fileText.split(/\r?\n/);

    // Single-file C# AppHosts are launched directly from source and start with:
    //   #:sdk Aspire.AppHost.Sdk
    // The CLI accepts this source file shape, so do not rewrite it to a project path.
    if (lines.some(line => line.startsWith('#:sdk Aspire.AppHost.Sdk'))) {
        return filePath;
    }

    if (!lines.some(line => line.includes('DistributedApplication.CreateBuilder'))) {
        return filePath;
    }

    // SDK-style C# AppHosts usually launch from Program.cs:
    //   var builder = DistributedApplication.CreateBuilder(args);
    // The CLI needs the containing .csproj instead of Program.cs so the AppHost SDK
    // and project references load.
    return await tryFindContainingProjectFile(filePath) ?? filePath;
}

async function tryFindContainingProjectFile(filePath: string): Promise<string | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    const workspaceRoot = workspaceFolder?.uri.fsPath;
    let directory = path.dirname(filePath);

    while (true) {
        const projectFile = await tryGetProjectFileInDirectory(directory);
        if (projectFile !== undefined) {
            return projectFile;
        }

        if (workspaceRoot && path.resolve(directory) === path.resolve(workspaceRoot)) {
            return null;
        }

        const parent = path.dirname(directory);
        if (parent === directory) {
            return null;
        }

        directory = parent;
    }
}

async function tryGetProjectFileInDirectory(directory: string): Promise<string | null | undefined> {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    }
    catch {
        return undefined;
    }

    const projectFiles = entries
        .filter(entry => entry.isFile() && /\.(csproj|fsproj|vbproj)$/i.test(entry.name))
        .map(entry => entry.name);

    if (projectFiles.length === 0) {
        return undefined;
    }

    if (projectFiles.length === 1) {
        return path.join(directory, projectFiles[0]);
    }

    const directoryName = path.basename(directory);
    const matchingProjectFile = projectFiles.find(projectFile =>
        path.basename(projectFile, path.extname(projectFile)).toLowerCase() === directoryName.toLowerCase());
    return matchingProjectFile ? path.join(directory, matchingProjectFile) : null;
}
