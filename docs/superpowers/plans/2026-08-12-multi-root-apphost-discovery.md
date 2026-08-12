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
        path: path.join(workspaceFolder.uri.fsPath, 'apphost.mts'),
        language: 'typescript',
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
            path.join(workspaceFolders[1].uri.fsPath, 'apphost.mts'),
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
const workspaceFolderSnapshot = [...workspaceFolders];
const workspaceFolderCandidates: WorkspaceFolderAppHostCandidates[] = workspaceFolderSnapshot.map(workspaceFolder => ({
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
        || !this._isCurrentWorkspaceDiscovery(discoveryVersion, workspaceFolderSnapshot)) {
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
        || !this._isCurrentWorkspaceDiscovery(discoveryVersion, workspaceFolderSnapshot)) {
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
        || !this._isCurrentWorkspaceDiscovery(discoveryVersion, workspaceFolderSnapshot)) {
        return;
    }

    const result = combineWorkspaceAppHostCandidates(workspaceFolderCandidates);
    this._workspaceAppHostDiscoveryComplete = true;
    this._handleWorkspaceAppHostCandidates(result.appHostCandidates, result.selectedAppHostPath);
```

Use the same complete-folder validation in the catch branch. After confirming the error belongs to the current discovery and is not a `CancellationError`, call `cancellationSource.cancel()` before clearing state and reporting the existing error so unfinished sibling callers cannot publish later candidates.

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
    const candidateChangeEmitter = new vscode.EventEmitter<vscode.WorkspaceFolder>();
    const discoveryService = {
        discover: () => new Promise<CandidateAppHostDisplayInfo[]>(() => { }),
        onDidChangeCandidates: candidateChangeEmitter.event,
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
        candidateChangeEmitter.dispose();
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

### Task 3: Address full-review findings

**Consumed by:** nothing

**Files:**
- Modify: `extension/src/test/appHostDataRepository.test.ts:268-550`
- Modify: `extension/src/test/appHostDiscovery.test.ts:274-345`
- Modify: `extension/src/views/AppHostDataRepository.ts:200-205`
- Modify: `extension/src/views/AppHostDataRepository.ts:301-308`
- Modify: `extension/src/views/AppHostDataRepository.ts:707-850`
- Modify: `extension/src/views/AppHostDataRepository.ts:2065-2150`
- Modify: `extension/src/utils/appHostDiscovery.ts:92-135`

- [ ] **Step 1: Write failing path and selection tests**

Add tests named:

```typescript
test('workspace discovery preserves case-distinct AppHost paths on case-sensitive platforms', async () => {
    // Return `/workspace/AppHost/apphost.mts` from one root and
    // `/workspace/apphost/apphost.mts` from another.
    // Expect one candidate only on Windows and two on macOS/Linux.
});

test('workspace discovery preserves one explicit selection across roots', async () => {
    // Root A returns two buildable candidates with one `selected: true`.
    // Root B returns one buildable candidate without `selected`.
    // Expect Root A's explicit path to remain `workspaceAppHostPath`.
});
```

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn unit-test --run out/test/appHostDataRepository.test.js --grep "case-distinct AppHost paths|preserves one explicit selection"
```

Expected: both tests fail against the pre-review merge behavior.

- [ ] **Step 2: Align merge identity and selection semantics**

Change the path key to normalize while preserving the repository's platform casing behavior:

```typescript
function getPathComparisonKey(filePath: string): string {
    return getComparisonKey(path.resolve(filePath));
}
```

Store the winning candidate with its workspace-root depth, replacing it only when the new candidate comes from a deeper root. Track explicit selections from `CandidateAppHostDisplayInfo.selected === true`. Return one explicit selected candidate when exactly one exists; otherwise fall back only when the merged buildable candidate list has one item.

- [ ] **Step 3: Write failing partial-result and concurrency tests**

Replace the sibling-cancellation fake with:

```typescript
test('workspace discovery failure preserves healthy folder candidates', async () => {
    // Reject Root A, resolve Root B with a buildable candidate.
    // Expect Root B to remain visible and `repository.hasError` to be false.
});
```

Add:

```typescript
test('workspace discovery limits concurrent folder scans', async () => {
    // Create six roots and controlled promises.
    // Assert four calls start, resolving one starts the fifth, and max active calls is four.
});

test('workspace-folder changes reuse surviving discovery caches', async () => {
    // Change [rootA, rootB] to [rootA, rootC].
    // Assert rootA is requested without `forceRefresh` and only rootC needs new CLI work.
});
```

Run the three tests and verify they fail for the expected all-or-nothing, unbounded, and forced-refresh behavior.

- [ ] **Step 4: Implement bounded partial discovery**

Add:

```typescript
private static readonly _workspaceAppHostDiscoveryConcurrency = 4;
```

Use a fixed worker pool that records an `error` on each `WorkspaceFolderAppHostCandidates` entry instead of rejecting early. Stop scheduling new work when the shared caller token is cancelled. After all workers finish:

```typescript
const failedFolders = workspaceFolderCandidates.filter(result => result.error !== undefined);
const combined = combineWorkspaceAppHostCandidates(workspaceFolderCandidates);
const hasBuildableCandidate = combined.appHostCandidates.some(isBuildableAppHostCandidate);

if (failedFolders.length > 0 && !hasBuildableCandidate) {
    // Preserve the existing fatal error path.
} else {
    // Log each failed root and apply healthy candidates.
}
```

Folder-set changes must call `_fetchWorkspaceAppHost()` without `forceRefresh`; explicit user refresh keeps `forceRefresh: true`.

- [ ] **Step 5: Retire removed-root discovery state**

Add this service method:

```typescript
forgetWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    const key = path.resolve(workspaceFolder.uri.fsPath);
    this._cache.delete(key);
    const timer = this._pendingInvalidationTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        this._pendingInvalidationTimers.delete(key);
    }
    this._watchers.get(key)?.forEach(watcher => watcher.dispose());
    this._watchers.delete(key);
}
```

The method intentionally does not cancel an active cached promise so existing subscribers can finish. Call it for every removed folder in the workspace-folder change handler. Add an `AppHostDiscoveryService` test that proves watchers are disposed and the next discovery creates fresh watchers/cache.

- [ ] **Step 6: Verify and re-review**

Run:

```bash
cd extension
corepack yarn lint
corepack yarn compile-tests
corepack yarn compile
corepack yarn unit-test --run out/test/appHostDataRepository.test.js --run out/test/appHostDiscovery.test.js
corepack yarn unit-test
```

Then rerun the affected regression/domain/performance lanes and the Playwright CLI proof against the new head. Expected: all tests pass, no blocking review findings remain, and Playwright again shows both real AppHosts while the base SHA shows one.
