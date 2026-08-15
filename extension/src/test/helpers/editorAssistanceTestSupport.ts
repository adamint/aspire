import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { type AspireOperationKind } from '../../dcp/types';
import {
    type AppHostEditorStateLaunchService,
    type AppHostLifecycleDiscoveryService,
    type AppHostLifecycleEditorSessions,
} from '../../lm/appHostLifecycleToolContracts';
import { type CandidateAppHostDisplayInfo } from '../../utils/appHostDiscovery';
import { compareAppHostIdentity } from '../../utils/appHostIdentity';

interface TestEditorSession {
    readonly appHostPath: string | undefined;
    readonly resolvedAppHostPath: string | undefined;
    readonly operationKind: AspireOperationKind;
    readonly startupCompleted: boolean;
    readonly noDebug: boolean | undefined;
    readonly isStopping: boolean;
}

class FakeDiscoveryService implements AppHostLifecycleDiscoveryService {
    readonly candidatesByFolder = new Map<string, CandidateAppHostDisplayInfo[]>();
    readonly discoverErrorsByFolder = new Map<string, Error>();
    discoverCalls = 0;
    discoverError: Error | undefined;

    async discover(workspaceFolder: vscode.WorkspaceFolder, _forceRefresh?: boolean, cancellationToken?: vscode.CancellationToken): Promise<readonly CandidateAppHostDisplayInfo[]> {
        this.discoverCalls++;
        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.discoverError) {
            throw this.discoverError;
        }

        const folderError = this.discoverErrorsByFolder.get(workspaceFolder.uri.fsPath);
        if (folderError) {
            throw folderError;
        }

        return this.candidatesByFolder.get(workspaceFolder.uri.fsPath) ?? [];
    }
}

class FakeEditorStateLaunchService implements AppHostEditorStateLaunchService {
    readonly launchingPaths = new Set<string>();
    readonly pendingOrActiveRunLaunchPaths = new Set<string>();
    readonly editorSessions: TestEditorSession[] = [];

    isLaunching(appHostPath: string): boolean {
        return this.launchingPaths.has(path.resolve(appHostPath));
    }

    hasPendingOrActiveRunLaunch(appHostPath: string): boolean {
        return this.pendingOrActiveRunLaunchPaths.has(path.resolve(appHostPath));
    }

    getEditorRunSessions(appHostPath: string): AppHostLifecycleEditorSessions {
        const sessions = [] as Array<{
            appHostPath: string | undefined;
            startupCompleted: boolean;
            configuration: { noDebug?: boolean; command?: string };
            stopDebugging(): Promise<void>;
        }>;
        let ambiguous = false;
        for (const session of this.editorSessions) {
            if (session.operationKind !== 'run') {
                continue;
            }

            switch (compareAppHostIdentity(session.resolvedAppHostPath ?? session.appHostPath, appHostPath)) {
                case 'same':
                    sessions.push({
                        appHostPath: session.appHostPath,
                        startupCompleted: session.startupCompleted,
                        configuration: { noDebug: session.noDebug, command: session.operationKind },
                        stopDebugging: async () => { },
                    });
                    break;
                case 'ambiguous':
                    ambiguous = true;
                    break;
            }
        }

        return { sessions, ambiguous };
    }

    getEditorSessions(): readonly TestEditorSession[] {
        return this.editorSessions;
    }
}

const appHostProjectContents = `<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.0.0" />
</Project>`;

function createFixtureDirectory(prefix: string): string {
    const fixtureRoot = path.resolve(__dirname, '..', '..', '.test-workspace', 'editor-assistance');
    const directory = path.join(fixtureRoot, `${prefix}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function createWorkspaceFolder(root: string, name: string, index: number): vscode.WorkspaceFolder {
    return {
        uri: vscode.Uri.file(root),
        name,
        index,
    };
}

function addCandidate(discoveryService: FakeDiscoveryService, folderRoot: string, candidatePath: string): void {
    const existing = discoveryService.candidatesByFolder.get(folderRoot) ?? [];
    existing.push({ path: candidatePath, language: 'csharp', status: 'buildable' });
    discoveryService.candidatesByFolder.set(folderRoot, existing);
}

function assertResolved<T extends { resolved: boolean }>(resolution: T): asserts resolution is T & { resolved: true; target: { absolutePath: string; relativePath: string; displayPath: string; identity: string } } {
    assert.strictEqual(resolution.resolved, true, `Expected a resolved target but got ${JSON.stringify(resolution)}`);
}

export {
    addCandidate,
    appHostProjectContents,
    assertResolved,
    createFixtureDirectory,
    createWorkspaceFolder,
    FakeDiscoveryService,
    FakeEditorStateLaunchService,
    type TestEditorSession,
};
