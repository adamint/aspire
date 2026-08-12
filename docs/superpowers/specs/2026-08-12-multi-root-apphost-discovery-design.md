# Multi-root AppHost discovery design

## Problem

The Aspire panel discovers workspace AppHosts through `AppHostDataRepository`. The underlying `AppHostDiscoveryService` is correctly scoped to one `vscode.WorkspaceFolder`, but the repository always calls it with `workspaceFolders[0]`. It also ignores candidate-change notifications from every folder except the first and treats only the first folder as part of the workspace while discovery is pending.

This makes a multi-root workspace run `aspire ls` successfully for each folder through other extension consumers while the panel renders candidates from only the first folder.

## Approach

Keep `AppHostDiscoveryService` folder-scoped. `AppHostDataRepository` will snapshot all current workspace folders, run up to four folder discoveries concurrently, and combine those folder-local results before updating the existing workspace candidate state.

Incremental candidates remain grouped with the folder that produced them. The repository converts each folder's candidates with the existing `getWorkspaceAppHostProjectSearchResult` helper and merges candidates by normalized absolute path using the repository's existing platform casing rules. When overlapping roots discover the same AppHost, the candidate from the deepest root wins. One explicit selection wins across roots; incidental single-candidate defaults are used only when the combined workspace has one buildable candidate.

The existing cancellation source, discovery version, queued refresh behavior, progress UI, polling synchronization, and tree rendering remain unchanged. Current-result validation will compare the complete workspace-folder snapshot instead of only the first folder.

## Change notifications and workspace membership

Candidate changes from any currently open workspace folder will mark discovery pending and queue a refresh. Notifications for folders that are no longer open remain ignored. Folder-set changes reuse cached discovery for surviving roots, create discovery only for new roots, and retire removed-root watchers and cached results without cancelling existing subscribers.

The fallback used while discovery is pending will consider a path inside any workspace folder. This lets a running AppHost from the second or later root appear from `aspire ps` before its discovery call completes.

## Errors

The repository waits for every scheduled folder discovery to settle. A failed root is logged and excluded while healthy roots remain visible. The existing fetch error is shown only when failures leave no buildable AppHost from any root. Cancellation and stale-result checks still prevent superseded discoveries from updating the panel.

No new user-facing strings, settings, telemetry events, or public APIs are required.

## Testing

Add focused `AppHostDataRepository` tests that prove:

- initial discovery calls every workspace folder and exposes both AppHost paths;
- a candidate-change event from the second folder refreshes discovery;
- a running AppHost in the second folder is visible before discovery completes.
- equivalent paths deduplicate without collapsing case-distinct AppHosts on macOS/Linux;
- one explicit selection survives incidental defaults in sibling roots;
- one failed root preserves healthy-root candidates, while total failure keeps the existing error;
- no more than four folder discovery calls run concurrently;
- folder-set changes reuse surviving caches and retire removed-root watchers.

Each regression test must fail against the current first-folder-only implementation before production code changes. Run the focused repository test file, extension lint, compilation, and the full extension unit suite after the fix.
