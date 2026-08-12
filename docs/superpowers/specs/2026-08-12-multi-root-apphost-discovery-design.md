# Multi-root AppHost discovery design

## Problem

The Aspire panel discovers workspace AppHosts through `AppHostDataRepository`. The underlying `AppHostDiscoveryService` is correctly scoped to one `vscode.WorkspaceFolder`, but the repository always calls it with `workspaceFolders[0]`. It also ignores candidate-change notifications from every folder except the first and treats only the first folder as part of the workspace while discovery is pending.

This makes a multi-root workspace run `aspire ls` successfully for each folder through other extension consumers while the panel renders candidates from only the first folder.

## Approach

Keep `AppHostDiscoveryService` folder-scoped. `AppHostDataRepository` will snapshot all current workspace folders, start one shared discovery call per folder in parallel, and combine those folder-local results before updating the existing workspace candidate state.

Incremental candidates remain grouped with the folder that produced them. The repository converts each folder's candidates with the existing `getWorkspaceAppHostProjectSearchResult` helper, merges candidates by normalized absolute path, and keeps a selected AppHost only when the combined result has exactly one distinct selected path. Two folders that each have one local default therefore produce two visible candidates without inventing a global selection.

The existing cancellation source, discovery version, queued refresh behavior, progress UI, polling synchronization, and tree rendering remain unchanged. Current-result validation will compare the complete workspace-folder snapshot instead of only the first folder.

## Change notifications and workspace membership

Candidate changes from any currently open workspace folder will mark discovery pending and queue a refresh. Notifications for folders that are no longer open remain ignored.

The fallback used while discovery is pending will consider a path inside any workspace folder. This lets a running AppHost from the second or later root appear from `aspire ps` before its discovery call completes.

## Errors

The combined discovery keeps the existing all-or-nothing error behavior. If one folder's discovery rejects, the repository cancels the sibling discovery callers, clears workspace discovery state, and surfaces the existing fetch error. Empty or non-buildable results from one folder are not errors and do not hide valid candidates from other folders.

No new user-facing strings, settings, telemetry events, or public APIs are required.

## Testing

Add focused `AppHostDataRepository` tests that prove:

- initial discovery calls every workspace folder and exposes both AppHost paths;
- a candidate-change event from the second folder refreshes discovery;
- a running AppHost in the second folder is visible before discovery completes.

Each regression test must fail against the current first-folder-only implementation before production code changes. Run the focused repository test file, extension lint, compilation, and the full extension unit suite after the fix.
