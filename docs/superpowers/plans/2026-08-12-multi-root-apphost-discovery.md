# Multi-root AppHost Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show AppHosts from every VS Code workspace folder in the Aspire panel and refresh them when any folder's candidates change.

**Architecture:** Keep `AppHostDiscoveryService` scoped to one folder and aggregate its results in `AppHostDataRepository`. Preserve the repository's existing cancellation, refresh coalescing, progress, polling, and tree contracts while replacing first-folder checks with complete workspace-folder checks.

**Tech Stack:** TypeScript, VS Code extension APIs, Sinon, Mocha TDD UI, Yarn, `@vscode/test-electron`

---

### Task 1: Aggregate initial discovery across workspace folders

**Consumed by:** Task 2 — candidate-change refreshes reuse the multi-folder discovery path

**Files:**
- Modify: `extension/src/test/appHostDataRepository.test.ts:196`
- Modify: `extension/src/views/AppHostDataRepository.ts:243-260`
- Modify: `extension/src/views/AppHostDataRepository.ts:696-819`
- Modify: `extension/src/views/AppHostDataRepository.ts:2039-2084`

- [ ] **Step 1: Write the failing multi-root discovery test**

Add this test after `workspace-folder change starts new discovery without cancelling unrelated old-root subscriber`:

```typescript
test('workspace discovery includes AppHosts from every workspace folder', async () => {
    const workspaceFolders = [
        {
            uri: vscode.Uri.file('/workspace/typescript'),
            name: 'typescript',
            index: 0,
        },
        {
            uri: vscode.Uri.file('/workspace/python'),
            name: 'python',
            index: 1,
        },
    ];
    const workspaceFoldersStub = stubWorkspaceFolders(workspaceFolders);
    const candidateChangeEmitter = new vscode.EventEmitter<vscode.WorkspaceFolder>();
    const discover = sinon.stub().callsFake(async (workspaceFolder: vscode.WorkspaceFolder) => [{
        path: path.join(workspaceFolder.uri.fsPath, workspaceFolder.name === 'typescript' ? 'apphost.mts' : 'apphost.py'),
        language: workspaceFolder.name,
        status: 'buildable',
        selected: true,
    }]);
    const discoveryService = {
        discover,
        onDidChangeCandidates: candidateChangeEmitter.event,
        dispose: () => { },
    } as unknown as AppHostDiscoveryService;
    const repository = new AppHostDataRepository(terminalProvider, discoveryService);

    try {
        await waitForCondition(
            () => repository.isWorkspaceAppHostDiscoveryComplete,
            'workspace AppHost discovery did not complete');

        assert.deepStrictEqual(
            discover.getCalls().map(call => (call.args[0] as vscode.WorkspaceFolder).uri.fsPath),
            workspaceFolders.map(folder => folder.uri.fsPath));
        assert.deepStrictEqual(repository.workspaceAppHostCandidatePaths, [
            path.join(workspaceFolders[1].uri.fsPath, 'apphost.py'),
            path.join(workspaceFolders[0].uri.fsPath, 'apphost.mts'),
        ]);
        assert.strictEqual(repository.workspaceAppHostPath, undefined);
    } finally {
        repository.dispose();
        candidateChangeEmitter.dispose();
        workspaceFoldersStub.restore();
    }
});
```

- [ ] **Step 2: Compile and run the new test to verify RED**

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn compile
corepack yarn unit-test --run out/test/appHostDataRepository.test.js --grep "workspace discovery includes AppHosts from every workspace folder"
```

Expected: FAIL because `discover` is called only for `/workspace/typescript` and the Python AppHost is absent.

- [ ] **Step 3: Add folder-associated discovery state**

Add this interface near the repository's other private state types:

```typescript
interface WorkspaceFolderAppHostCandidates {
    workspaceFolder: vscode.WorkspaceFolder;
    candidates: CandidateAppHostDisplayInfo[];
}

interface CombinedWorkspaceAppHostCandidates {
    appHostCandidates: AppHostCandidate[];
    selectedAppHostPath: string | null;
}
```

Add this helper near `shortenPaths`:

```typescript
function combineWorkspaceAppHostCandidates(
    workspaceFolderCandidates: readonly WorkspaceFolderAppHostCandidates[]
): CombinedWorkspaceAppHostCandidates {
    const appHostCandidatesByPath = new Map<string, AppHostCandidate>();
    const selectedAppHostPaths = new Map<string, string>();

    for (const folderCandidates of workspaceFolderCandidates) {
        const result = getWorkspaceAppHostProjectSearchResult(
            folderCandidates.workspaceFolder,
            folderCandidates.candidates);
        for (const candidate of result.app_host_candidates) {
            appHostCandidatesByPath.set(getComparisonKey(candidate.path), candidate);
        }
        if (result.selected_project_file) {
            selectedAppHostPaths.set(
                getComparisonKey(result.selected_project_file),
                result.selected_project_file);
        }
    }

    const selectedAppHostPath = selectedAppHostPaths.size === 1
        ? selectedAppHostPaths.values().next().value
        : null;

    return {
        appHostCandidates: [...appHostCandidatesByPath.values()],
        selectedAppHostPath: selectedAppHostPath ?? null,
    };
}
```

- [ ] **Step 4: Run all folder discoveries concurrently**

In `_fetchWorkspaceAppHost`, replace `rootFolder` and the single streamed candidate array with a snapshot:

```typescript
const discoveryVersion = ++this._workspaceAppHostDiscoveryVersion;
const workspaceFolderCandidates: WorkspaceFolderAppHostCandidates[] = workspaceFolders.map(workspaceFolder => ({
    workspaceFolder,
    candidates: [],
}));
```

Change incremental candidate handling to receive its folder state and update that folder's array:

```typescript
const onIncrementalCandidate = (
    folderCandidates: WorkspaceFolderAppHostCandidates,
    candidate: CandidateAppHostDisplayInfo
): void => {
    if (cancellationSource.token.isCancellationRequested
        || !this._isCurrentWorkspaceDiscovery(discoveryVersion, workspaceFolders)) {
        return;
    }

    const existingCandidateIndex = folderCandidates.candidates.findIndex(
        existingCandidate => isMatchingAppHostPath(existingCandidate.path, candidate.path));
    if (existingCandidateIndex >= 0) {
        folderCandidates.candidates[existingCandidateIndex] = candidate;
    } else {
        folderCandidates.candidates.push(candidate);
    }

    if (!incrementalCandidateMaxWaitTimer) {
        incrementalCandidateMaxWaitTimer = setTimeout(
            applyIncrementalCandidateUpdates,
            AppHostDataRepository._streamedCandidateUpdateMaxWaitMs);
    }
    if (incrementalCandidateUpdateTimer) {
        clearTimeout(incrementalCandidateUpdateTimer);
    }
    incrementalCandidateUpdateTimer = setTimeout(
        applyIncrementalCandidateUpdates,
        AppHostDataRepository._streamedCandidateUpdateDebounceMs);
};
```

Use the combined helper for incremental updates:

```typescript
const applyIncrementalCandidateUpdates = (): void => {
    cancelIncrementalCandidateUpdate();
    if (cancellationSource.token.isCancellationRequested
        || !this._isCurrentWorkspaceDiscovery(discoveryVersion, workspaceFolders)) {
        return;
    }

    const result = combineWorkspaceAppHostCandidates(workspaceFolderCandidates);
    const buildableAppHostCandidates = result.appHostCandidates.filter(isBuildableAppHostCandidate);
    if (buildableAppHostCandidates.length > 0) {
        this._setWorkspaceAppHostCandidatePaths(buildableAppHostCandidates);
        this._updateWorkspaceContext();
    }
};
```

Replace the single `discover` promise with:

```typescript
Promise.all(workspaceFolderCandidates.map(async folderCandidates => {
    folderCandidates.candidates = await this._appHostDiscoveryService.discover(
        folderCandidates.workspaceFolder,
        options?.forceRefresh,
        cancellationSource.token,
        candidate => onIncrementalCandidate(folderCandidates, candidate));
})).then(() => {
    cancelIncrementalCandidateUpdate();
    if (cancellationSource.token.isCancellationRequested
        || !this._isCurrentWorkspaceDiscovery(discoveryVersion, workspaceFolders)) {
        return;
    }

    const result = combineWorkspaceAppHostCandidates(workspaceFolderCandidates);
    this._workspaceAppHostDiscoveryComplete = true;
    this._handleWorkspaceAppHostCandidates(result.appHostCandidates, result.selectedAppHostPath);
```

Use the same complete-folder validation in the catch branch.

- [ ] **Step 5: Validate the complete folder snapshot**

Change `_isCurrentWorkspaceDiscovery` to:

```typescript
private _isCurrentWorkspaceDiscovery(
    discoveryVersion: number,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
): boolean {
    const currentWorkspaceFolders = vscode.workspace.workspaceFolders;
    return !this._disposed
        && discoveryVersion === this._workspaceAppHostDiscoveryVersion
        && currentWorkspaceFolders?.length === workspaceFolders.length
        && workspaceFolders.every((workspaceFolder, index) =>
            currentWorkspaceFolders[index].uri.toString() === workspaceFolder.uri.toString());
}
```

- [ ] **Step 6: Compile and run the focused test to verify GREEN**

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn unit-test --run out/test/appHostDataRepository.test.js --grep "workspace discovery includes AppHosts from every workspace folder"
```

Expected: PASS.

- [ ] **Step 7: Commit the initial aggregation**

```bash
git add extension/src/test/appHostDataRepository.test.ts extension/src/views/AppHostDataRepository.ts
git commit -m "Fix multi-root AppHost discovery"
```

### Task 2: Refresh and pre-discovery behavior for every root

**Consumed by:** nothing

**Files:**
- Modify: `extension/src/test/appHostDataRepository.test.ts:196-330`
- Modify: `extension/src/views/AppHostDataRepository.ts:283-289`
- Modify: `extension/src/views/AppHostDataRepository.ts:2310-2320`

- [ ] **Step 1: Write the failing second-root refresh test**

Add:

```typescript
test('candidate changes in any workspace folder refresh workspace discovery', async () => {
    const workspaceFolders = [
        { uri: vscode.Uri.file('/workspace/typescript'), name: 'typescript', index: 0 },
        { uri: vscode.Uri.file('/workspace/python'), name: 'python', index: 1 },
    ];
    const workspaceFoldersStub = stubWorkspaceFolders(workspaceFolders);
    const candidateChangeEmitter = new vscode.EventEmitter<vscode.WorkspaceFolder>();
    const discover = sinon.stub().callsFake(async (workspaceFolder: vscode.WorkspaceFolder) => [{
        path: path.join(workspaceFolder.uri.fsPath, 'apphost.mts'),
        language: 'typescript',
        status: 'buildable',
    }]);
    const discoveryService = {
        discover,
        onDidChangeCandidates: candidateChangeEmitter.event,
        dispose: () => { },
    } as unknown as AppHostDiscoveryService;
    const repository = new AppHostDataRepository(terminalProvider, discoveryService);

    try {
        await waitForCondition(() => discover.callCount === 2, 'initial multi-root discovery did not start');

        candidateChangeEmitter.fire(workspaceFolders[1]);

        await waitForCondition(() => discover.callCount === 4, 'second-root change did not refresh discovery');
        assert.strictEqual(discover.getCalls().filter(call =>
            (call.args[0] as vscode.WorkspaceFolder).uri.toString() === workspaceFolders[1].uri.toString()).length, 2);
    } finally {
        repository.dispose();
        candidateChangeEmitter.dispose();
        workspaceFoldersStub.restore();
    }
});
```

- [ ] **Step 2: Write the failing second-root runtime test**

Add:

```typescript
test('workspace ps shows running AppHosts from every folder before discovery completes', async () => {
    const workspaceFolders = [
        { uri: vscode.Uri.file('/workspace/typescript'), name: 'typescript', index: 0 },
        { uri: vscode.Uri.file('/workspace/python'), name: 'python', index: 1 },
    ];
    const workspaceFoldersStub = stubWorkspaceFolders(workspaceFolders);
    const discoveryService = {
        discover: () => new Promise<CandidateAppHostDisplayInfo[]>(() => { }),
        onDidChangeCandidates: new vscode.EventEmitter<vscode.WorkspaceFolder>().event,
        dispose: () => { },
    } as unknown as AppHostDiscoveryService;
    const repository = new AppHostDataRepository(terminalProvider, discoveryService);

    try {
        repository.activate();
        repository.setPanelVisible(true);
        await waitForCondition(
            () => spawnStub.getCalls().some(call => (call.args[2] as string[])[0] === 'ps'),
            'workspace ps did not start');
        const psCall = spawnStub.getCalls().find(call =>
            (call.args[2] as string[])[0] === 'ps' && (call.args[2] as string[]).includes('--follow'));
        assert.ok(psCall);
        const appHostPath = path.join(workspaceFolders[1].uri.fsPath, 'apphost.py');

        psCall.args[3].lineCallback(JSON.stringify([{
            appHostPath,
            appHostPid: 1,
        }]));
        await waitForMicrotasks();

        assert.deepStrictEqual(repository.appHosts.map(appHost => appHost.appHostPath), [appHostPath]);
    } finally {
        repository.dispose();
        workspaceFoldersStub.restore();
    }
});
```

- [ ] **Step 3: Run both tests to verify RED**

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn unit-test --run out/test/appHostDataRepository.test.js --grep "candidate changes in any workspace folder|workspace ps shows running AppHosts from every folder"
```

Expected: FAIL because the candidate-change listener and `isPathInWorkspace` inspect only `workspaceFolders[0]`.

- [ ] **Step 4: Refresh on a change from any current folder**

Replace the constructor listener body with:

```typescript
this._appHostDiscoveryChangeDisposable = this._appHostDiscoveryService.onDidChangeCandidates(workspaceFolder => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.some(currentWorkspaceFolder =>
        currentWorkspaceFolder.uri.toString() === workspaceFolder.uri.toString())) {
        this._markWorkspaceAppHostDiscoveryPending();
        this._fetchWorkspaceAppHost();
    }
});
```

- [ ] **Step 5: Treat every folder as workspace membership**

Replace `isPathInWorkspace` with:

```typescript
function isPathInWorkspace(filePath: string): boolean {
    return vscode.workspace.workspaceFolders?.some(workspaceFolder => {
        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        return relativePath !== ''
            && !relativePath.startsWith('..')
            && !path.isAbsolute(relativePath);
    }) ?? false;
}
```

- [ ] **Step 6: Run both tests to verify GREEN**

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn unit-test --run out/test/appHostDataRepository.test.js --grep "candidate changes in any workspace folder|workspace ps shows running AppHosts from every folder"
```

Expected: PASS.

- [ ] **Step 7: Run focused and full extension validation**

Run:

```bash
cd extension
corepack yarn lint
corepack yarn compile-tests
corepack yarn compile
corepack yarn unit-test --run out/test/appHostDataRepository.test.js
corepack yarn test
```

Expected: lint and compilation succeed; the repository test file and complete extension unit suite pass.

- [ ] **Step 8: Commit refresh and membership behavior**

```bash
git add extension/src/test/appHostDataRepository.test.ts extension/src/views/AppHostDataRepository.ts
git commit -m "Handle every workspace root in the Aspire panel"
```
