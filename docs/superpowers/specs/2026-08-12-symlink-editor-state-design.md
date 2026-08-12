# Symlinked AppHost Editor State Design

## Problem

The Aspire CLI reports the canonical AppHost path, while VS Code keeps the path used to open the document. When the workspace was opened through a directory symlink, `matchesAppHostPathOrDirectory` compares different path strings and CodeLens plus gutter resource state disappear.

## Scope

Fix path matching only for the editor-state providers that use `matchesAppHostPathOrDirectory`. Do not change AppHost identity, discovery, launch tracking, or repository ingestion elsewhere in the extension.

## Approaches

1. **Canonicalize in the shared editor helper (recommended).** Keep the current normalized comparison as the fast path. If it fails, resolve both existing paths with `realpathSync.native` and repeat the same exact-path or same-directory comparison. This fixes CodeLens and gutter state together without changing unrelated behavior.
2. **Canonicalize AppHost paths when CLI data enters the repository.** This avoids repeated filesystem calls, but changes AppHost identity for tree, command, and launch flows that are not part of this bug.
3. **Make provider matching asynchronous through `vscode.workspace.fs`.** This can support non-file providers, but requires broader provider refactoring for a local filesystem symlink issue.

## Design

`matchesAppHostPathOrDirectory` will first use its existing platform-aware normalized comparison. Only a mismatch triggers filesystem canonicalization, so canonical workspaces keep the current no-I/O path.

The helper will resolve both paths with `realpathSync.native`, then apply the existing exact-path or parent-directory comparison. Missing or stale paths (`ENOENT` and `ENOTDIR`) will remain a non-match instead of breaking editor rendering. Unexpected filesystem errors will not be silently swallowed.

No provider changes are required because `AspireCodeLensProvider` and `AspireGutterDecorationProvider` already share this helper.

## Testing

Add cross-platform unit coverage in `resourceStateUtils.test.ts` using a temporary real workspace and a directory symlink or Windows junction:

- a TypeScript AppHost source file matches its canonical path;
- a C# source file opened through the link matches the canonical `.csproj` by directory;
- unrelated paths remain unmatched;
- missing paths preserve the current normalized fallback behavior.

Run the focused helper, CodeLens, and gutter test files, then run extension lint and compilation.
