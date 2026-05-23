/// <reference types="mocha" />

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as cliModule from '../debugger/languages/cli';
import { AppHostDiscoveryService, findCandidateForEditorFile, getDebugTargetForCandidate } from '../utils/appHostDiscovery';
import type { AspireTerminalProvider } from '../utils/AspireTerminalProvider';

suite('AppHost discovery', () => {
    test('resolves SDK-style C# AppHost source file to discovered project candidate', () => {
        const appHostProjectPath = buildPath('workspace', 'AppHost', 'AppHost.csproj');
        const programPath = buildPath('workspace', 'AppHost', 'Program.cs');

        const candidate = findCandidateForEditorFile(programPath, [{
            path: appHostProjectPath,
            language: 'csharp',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, appHostProjectPath);
        assert.strictEqual(candidate ? getDebugTargetForCandidate(candidate) : undefined, appHostProjectPath);
    });

    test('keeps file-based C# AppHost candidate as source file', () => {
        const appHostPath = buildPath('workspace', 'AppHost', 'apphost.cs');

        const candidate = findCandidateForEditorFile(appHostPath, [{
            path: appHostPath,
            language: 'csharp',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, appHostPath);
        assert.strictEqual(candidate ? getDebugTargetForCandidate(candidate) : undefined, appHostPath);
    });

    test('keeps TypeScript AppHost candidate as source file', () => {
        const appHostPath = buildPath('workspace', 'AppHost', 'apphost.ts');

        const candidate = findCandidateForEditorFile(appHostPath, [{
            path: appHostPath,
            language: 'typescript/nodejs',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, appHostPath);
        assert.strictEqual(candidate ? getDebugTargetForCandidate(candidate) : undefined, appHostPath);
    });

    test('returns undefined when no discovered candidate contains C# source file', () => {
        const programPath = buildPath('workspace', 'Web', 'Program.cs');

        const candidate = findCandidateForEditorFile(programPath, [{
            path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
            language: 'csharp',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate, undefined);
    });

    test('does not map source file to non-C# project candidate', () => {
        const programPath = buildPath('workspace', 'AppHost', 'Program.cs');

        const candidate = findCandidateForEditorFile(programPath, [{
            path: buildPath('workspace', 'AppHost', 'apphost.ts'),
            language: 'typescript/nodejs',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate, undefined);
    });

    test('maps C# file in AppHost project directory to discovered project candidate', () => {
        const helperPath = buildPath('workspace', 'AppHost', 'Helper.cs');

        const candidate = findCandidateForEditorFile(helperPath, [{
            path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
            language: 'csharp',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, buildPath('workspace', 'AppHost', 'AppHost.csproj'));
    });

    test('does not map C# file under bin directory to discovered project candidate', () => {
        const generatedPath = buildPath('workspace', 'AppHost', 'bin', 'Debug', 'net10.0', 'Generated.cs');

        const candidate = findCandidateForEditorFile(generatedPath, [{
            path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
            language: 'csharp',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate, undefined);
    });

    suite('service', () => {
        let sandbox: sinon.SinonSandbox;

        setup(() => {
            sandbox = sinon.createSandbox();
        });

        teardown(() => {
            sandbox.restore();
        });

        test('does not force refresh discovery after cached negative editor lookup', async () => {
            stubFileSystemWatchers(sandbox);
            const spawnStub = sandbox.stub(cliModule, 'spawnCliProcess').callsFake((_terminalProvider, _command, _args, options) => {
                options?.stdoutCallback?.(JSON.stringify([{
                    path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
                    language: 'csharp',
                    status: 'buildable',
                }]));
                options?.exitCallback?.(0);
                return { kill: () => { } } as any;
            });
            const service = new AppHostDiscoveryService(makeTerminalProvider());

            try {
                const workspaceFolder = makeWorkspaceFolder(buildPath('workspace'));
                const firstResult = await service.tryFindCandidateForEditorFile(buildPath('workspace', 'Web', 'Program.cs'), workspaceFolder);
                const secondResult = await service.tryFindCandidateForEditorFile(buildPath('workspace', 'Web', 'Program.cs'), workspaceFolder);

                assert.strictEqual(firstResult, undefined);
                assert.strictEqual(secondResult, undefined);
                assert.strictEqual(spawnStub.callCount, 1);
            }
            finally {
                service.dispose();
            }
        });

        test('fires change event and invalidates cache when watched files change', async () => {
            const watcherCallbacks = stubFileSystemWatchers(sandbox);
            const spawnStub = sandbox.stub(cliModule, 'spawnCliProcess').callsFake((_terminalProvider, _command, _args, options) => {
                options?.stdoutCallback?.('[]');
                options?.exitCallback?.(0);
                return { kill: () => { } } as any;
            });
            const service = new AppHostDiscoveryService(makeTerminalProvider());
            const workspaceFolder = makeWorkspaceFolder(buildPath('workspace'));
            let changedWorkspaceFolder: vscode.WorkspaceFolder | undefined;
            const subscription = service.onDidChangeCandidates(folder => {
                changedWorkspaceFolder = folder;
            });

            try {
                await service.discover(workspaceFolder);
                assert.strictEqual(spawnStub.callCount, 1);

                watcherCallbacks[0]();
                assert.strictEqual(changedWorkspaceFolder, workspaceFolder);

                await service.discover(workspaceFolder);
                assert.strictEqual(spawnStub.callCount, 2);
            }
            finally {
                subscription.dispose();
                service.dispose();
            }
        });
    });
});

function buildPath(...segments: string[]): string {
    return path.join(path.sep, ...segments);
}

function makeWorkspaceFolder(folderPath: string): vscode.WorkspaceFolder {
    return {
        uri: vscode.Uri.file(folderPath),
        name: path.basename(folderPath),
        index: 0,
    };
}

function makeTerminalProvider(): AspireTerminalProvider {
    return {
        getAspireCliExecutablePath: async () => 'aspire',
        createEnvironment: () => ({}),
    } as unknown as AspireTerminalProvider;
}

function stubFileSystemWatchers(sandbox: sinon.SinonSandbox): Array<() => void> {
    const callbacks: Array<() => void> = [];
    sandbox.stub(vscode.workspace, 'createFileSystemWatcher').callsFake(() => ({
        onDidCreate: callback => {
            callbacks.push(() => callback(vscode.Uri.file(buildPath('workspace', 'AppHost', 'AppHost.csproj'))));
            return { dispose: () => { } };
        },
        onDidChange: callback => {
            callbacks.push(() => callback(vscode.Uri.file(buildPath('workspace', 'AppHost', 'AppHost.csproj'))));
            return { dispose: () => { } };
        },
        onDidDelete: callback => {
            callbacks.push(() => callback(vscode.Uri.file(buildPath('workspace', 'AppHost', 'AppHost.csproj'))));
            return { dispose: () => { } };
        },
        dispose: () => { },
    } as vscode.FileSystemWatcher));

    return callbacks;
}
