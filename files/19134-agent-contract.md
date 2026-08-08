# Agent-facing contract review

Reviewed `aspire_apphost_start` and `aspire_apphost_stop` as model-facing tools, using only the manifest descriptions, schemas, and JSON results.

## Contract shape

- The two tools are distinct enough: start launches a discovered AppHost in `run` or `debug`; stop only stops an AppHost this editor started.
- I fixed one schema-description mismatch: multi-root workspaces always require the workspace-folder-qualified selector, not only when duplicate relative paths currently exist.
- `appHostPath` is now described as a selector over discovered AppHosts, not a filesystem path the agent can invent.

## Misuse paths

Every checked invoke misuse path returns a bounded JSON result instead of throwing: invalid input, unknown selector, ambiguous selector, discovery failure, untrusted workspace, externally owned AppHost, lock timeout, cancellation, launch failure, and stop failure.

One path was structured but misleading: stopping while a start was reserved but before a debug session existed returned `notRunning`. I changed it to `alreadyStarting` with `controller: "editor"`, so an agent can wait/retry instead of concluding nothing is happening.

## Concurrency and idempotency

Covered by tests:

- duplicate starts serialize to one launch (`started` plus `alreadyStarting`/`alreadyRunning`), also proven red by the E2E mutation;
- F5/tool launch races are covered by the synchronous reservation tests;
- two stops serialize and stop the session once;
- stop racing a pre-session start now returns `alreadyStarting`;
- external process discovery is rechecked after waiting for the lock.

Not fully proven by a real-path test: an AppHost that exits or fails on its own in the middle of a start/stop call. Unit coverage covers launch failure and `stopDebugging` failure as bounded `failed` results, but not every organic process-exit interleaving.

Retries look safe after the fix. Retrying start is process-idempotent (`alreadyStarting`/`alreadyRunning` once a first call is in flight or finished). Retrying stop is also safe: after success it returns `notRunning`, while external ownership returns `notEditorOwned` and is never killed.

## Granularity

Start/stop feels like the right granularity for lifecycle ownership: mode belongs on start, and stop should stay editor-owned only. The only design question I would keep in mind is whether agents eventually need a read-only status tool; without one, a model may use `start` as a status probe and trigger confirmation even when it only wanted to inspect state.

## Proof

- Red: the new stop/start race unit test first failed with `notRunning`/`none` instead of `alreadyStarting`/`editor`.
- Green: the same test passed after the stop path checks the launching reservation.
- Red: the schema-description test first failed because the text only mentioned duplicate relative paths in multi-root workspaces.
- Green: the same manifest test passed after the description changed to always require the workspace folder prefix in multi-root workspaces.
