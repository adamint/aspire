# Symlinked AppHost Editor State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Aspire CodeLens actions and gutter resource state when an AppHost workspace is opened through a directory symlink.

**Architecture:** Keep the existing normalized path comparison as the fast path in the editor-state helper. When that comparison fails, resolve both existing filesystem paths to their canonical locations and repeat the same exact-file or same-directory comparison, leaving all AppHost identity and discovery flows unchanged.

**Tech Stack:** TypeScript 5.9, Node.js `fs.realpathSync.native`, VS Code extension tests with Mocha and `@vscode/test-cli`.

---

### Task 1: Add symlink path regression coverage

**Consumed by:** Task 2

**Files:**
- Modify: `extension/src/test/resourceStateUtils.test.ts`

- [ ] **Step 1: Import filesystem and path helpers plus the matcher**

```typescript
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findResourceState, findWorkspaceResourceState, matchesAppHostPathOrDirectory, ResourceMatch } from '../editor/resourceStateUtils';
```

- [ ] **Step 2: Add a temporary symlinked workspace fixture**

```typescript
function createSymlinkedWorkspace(): {
    canonicalDirectory: string;
    linkedDirectory: string;
    dispose(): void;
} {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-resource-state-'));
    const canonicalDirectory = path.join(tempDirectory, 'workspace');
    const linkedDirectory = path.join(tempDirectory, 'workspace-link');

    fs.mkdirSync(canonicalDirectory);
    fs.symlinkSync(canonicalDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    return {
        canonicalDirectory,
        linkedDirectory,
        dispose() {
            fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        },
    };
}
```

- [ ] **Step 3: Add exact-file and same-directory regression tests**

```typescript
suite('matchesAppHostPathOrDirectory', () => {
    test('matches a TypeScript AppHost opened through a directory symlink', () => {
        const workspace = createSymlinkedWorkspace();
        try {
            const canonicalAppHostPath = path.join(workspace.canonicalDirectory, 'apphost.ts');
            const linkedAppHostPath = path.join(workspace.linkedDirectory, 'apphost.ts');
            fs.writeFileSync(canonicalAppHostPath, '');

            assert.strictEqual(matchesAppHostPathOrDirectory(linkedAppHostPath, canonicalAppHostPath), true);
        } finally {
            workspace.dispose();
        }
    });

    test('matches a C# source file to its project through a directory symlink', () => {
        const workspace = createSymlinkedWorkspace();
        try {
            const canonicalProjectPath = path.join(workspace.canonicalDirectory, 'AppHost.csproj');
            const linkedSourcePath = path.join(workspace.linkedDirectory, 'AppHost.cs');
            fs.writeFileSync(canonicalProjectPath, '');
            fs.writeFileSync(path.join(workspace.canonicalDirectory, 'AppHost.cs'), '');

            assert.strictEqual(matchesAppHostPathOrDirectory(linkedSourcePath, canonicalProjectPath), true);
        } finally {
            workspace.dispose();
        }
    });

    test('does not match unrelated canonical directories', () => {
        const firstWorkspace = createSymlinkedWorkspace();
        const secondWorkspace = createSymlinkedWorkspace();
        try {
            const documentPath = path.join(firstWorkspace.linkedDirectory, 'apphost.ts');
            const appHostPath = path.join(secondWorkspace.canonicalDirectory, 'apphost.ts');
            fs.writeFileSync(path.join(firstWorkspace.canonicalDirectory, 'apphost.ts'), '');
            fs.writeFileSync(appHostPath, '');

            assert.strictEqual(matchesAppHostPathOrDirectory(documentPath, appHostPath), false);
        } finally {
            firstWorkspace.dispose();
            secondWorkspace.dispose();
        }
    });
});
```

- [ ] **Step 4: Compile and run the new tests to verify they fail**

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn unit-test --run out/test/resourceStateUtils.test.js
```

Expected: the new symlink matching tests fail because the helper only compares normalized path strings.

- [ ] **Step 5: Commit the failing regression tests**

```bash
git add extension/src/test/resourceStateUtils.test.ts
git commit -m "test: cover symlinked AppHost editor paths"
```

### Task 2: Canonicalize mismatched editor paths

**Consumed by:** nothing

**Files:**
- Modify: `extension/src/editor/resourceStateUtils.ts`
- Test: `extension/src/test/resourceStateUtils.test.ts`

- [ ] **Step 1: Import native realpath support**

```typescript
import { realpathSync } from 'node:fs';
import * as path from 'path';
```

- [ ] **Step 2: Preserve the fast path and retry with canonical paths**

```typescript
export function matchesAppHostPathOrDirectory(documentPath: string, appHostPath: string | undefined): boolean {
    if (!appHostPath) {
        return false;
    }

    if (pathsMatch(documentPath, appHostPath)) {
        return true;
    }

    const canonicalDocumentPath = tryGetCanonicalPath(documentPath);
    const canonicalAppHostPath = tryGetCanonicalPath(appHostPath);
    return canonicalDocumentPath !== undefined
        && canonicalAppHostPath !== undefined
        && pathsMatch(canonicalDocumentPath, canonicalAppHostPath);
}

function pathsMatch(documentPath: string, appHostPath: string): boolean {
    const normalizedDocumentPath = getComparisonKey(path.normalize(documentPath));
    const normalizedAppHostPath = getComparisonKey(path.normalize(appHostPath));
    return normalizedAppHostPath === normalizedDocumentPath
        || getComparisonKey(path.dirname(normalizedAppHostPath)) === getComparisonKey(path.dirname(normalizedDocumentPath));
}

function tryGetCanonicalPath(value: string): string | undefined {
    try {
        return realpathSync.native(value);
    } catch (error) {
        if (isMissingPathError(error)) {
            return undefined;
        }

        throw error;
    }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error
        && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
```

- [ ] **Step 3: Add missing-path fallback coverage**

```typescript
test('preserves normalized matching when paths no longer exist', () => {
    const documentPath = path.join(path.sep, 'missing', 'AppHost', 'AppHost.cs');
    const appHostPath = path.join(path.sep, 'missing', 'AppHost', 'AppHost.csproj');

    assert.strictEqual(matchesAppHostPathOrDirectory(documentPath, appHostPath), true);
});
```

- [ ] **Step 4: Run focused editor-state tests**

Run:

```bash
cd extension
corepack yarn compile-tests
corepack yarn compile
corepack yarn unit-test --run out/test/resourceStateUtils.test.js --run out/test/aspireCodeLensProvider.test.js --run out/test/aspireGutterDecorationProvider.test.js
```

Expected: all focused tests pass, including the new symlink cases.

- [ ] **Step 5: Run lint**

Run:

```bash
cd extension
corepack yarn lint
```

Expected: ESLint completes without errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add extension/src/editor/resourceStateUtils.ts extension/src/test/resourceStateUtils.test.ts
git commit -m "fix: match symlinked AppHost editor paths"
```
