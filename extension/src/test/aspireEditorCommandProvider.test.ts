/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AspireEditorCommandProvider } from '../editor/AspireEditorCommandProvider';
import { AppHostDiscoveryService } from '../utils/appHostDiscovery';

function createEditor(filePath: string): vscode.TextEditor {
    return {
        document: {
            uri: vscode.Uri.file(filePath),
            fileName: filePath,
            languageId: 'csharp'
        } as vscode.TextDocument
    } as vscode.TextEditor;
}

suite('AspireEditorCommandProvider', () => {
    let tempDir: string;
    let activeEditor: vscode.TextEditor | undefined;
    let activeEditorStub: sinon.SinonStub;
    let workspaceFoldersStub: sinon.SinonStub;
    let getWorkspaceFolderStub: sinon.SinonStub;
    let onDidChangeWorkspaceFoldersStub: sinon.SinonStub;
    let onDidChangeActiveTextEditorStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-editor-command-provider-'));
        activeEditor = undefined;

        activeEditorStub = sinon.stub(vscode.window, 'activeTextEditor').get(() => activeEditor);
        workspaceFoldersStub = sinon.stub(vscode.workspace, 'workspaceFolders').value(undefined);
        getWorkspaceFolderStub = sinon.stub(vscode.workspace, 'getWorkspaceFolder').callsFake((uri: vscode.Uri) => {
            if (uri.fsPath.startsWith(tempDir)) {
                return { uri: vscode.Uri.file(tempDir), name: 'test', index: 0 };
            }

            return undefined;
        });
        onDidChangeWorkspaceFoldersStub = sinon.stub(vscode.workspace, 'onDidChangeWorkspaceFolders').returns({ dispose: () => { } } as vscode.Disposable);
        onDidChangeActiveTextEditorStub = sinon.stub(vscode.window, 'onDidChangeActiveTextEditor').returns({ dispose: () => { } } as vscode.Disposable);
        executeCommandStub = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
    });

    teardown(() => {
        executeCommandStub.restore();
        onDidChangeActiveTextEditorStub.restore();
        onDidChangeWorkspaceFoldersStub.restore();
        getWorkspaceFolderStub.restore();
        workspaceFoldersStub.restore();
        activeEditorStub.restore();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('returns containing project file when active editor is SDK-style AppHost Program.cs', async () => {
        const appHostDirectory = path.join(tempDir, 'AppHost');
        fs.mkdirSync(appHostDirectory);

        const programPath = path.join(appHostDirectory, 'Program.cs');
        const projectPath = path.join(appHostDirectory, 'AppHost.csproj');
        fs.writeFileSync(programPath, 'var builder = DistributedApplication.CreateBuilder(args);\nbuilder.Build().Run();');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        activeEditor = createEditor(programPath);

        const provider = new AspireEditorCommandProvider(createAppHostDiscoveryService(projectPath));
        try {
            assert.strictEqual(await provider.getAppHostPath(), projectPath);
        }
        finally {
            provider.dispose();
        }
    });

    test('returns source file when active editor is single-file apphost.cs', async () => {
        const appHostPath = path.join(tempDir, 'apphost.cs');
        fs.writeFileSync(appHostPath, '#:sdk Aspire.AppHost.Sdk\nvar builder = DistributedApplication.CreateBuilder(args);');
        activeEditor = createEditor(appHostPath);

        const provider = new AspireEditorCommandProvider(createAppHostDiscoveryService(appHostPath));
        try {
            assert.strictEqual(await provider.getAppHostPath(), appHostPath);
        }
        finally {
            provider.dispose();
        }
    });
});

function createAppHostDiscoveryService(resolvedPath: string): AppHostDiscoveryService {
    return {
        onDidChangeCandidates: () => ({ dispose: () => { } }),
        tryFindCandidateForEditorFile: async () => ({
            path: resolvedPath,
            language: 'C#',
            status: 'buildable',
        }),
    } as unknown as AppHostDiscoveryService;
}
