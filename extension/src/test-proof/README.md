# Hot Reload proof harness (local only)

These are **not** unit tests and they do not run in CI or under `yarn run test`. They exist to prove,
against real software rather than stubs, that .NET Hot Reload reaches project resources launched by
the Aspire debug adapter.

They need things CI does not have: a real C# Dev Kit installation, a real Aspire CLI, and a real
Aspire app on disk. Keep them here so the claim in the pull request that introduced Hot Reload
support stays reproducible.

| File | What it proves |
|------|----------------|
| `devkitHotReload.proof.ts` | Dev Kit exports a brokered service pipe name, and the value the extension injects is byte-identical to Dev Kit's own. |
| `aspireHotReloadE2E.proof.ts` | Edits to **three concurrently running** project resources are applied to the running processes: every HTTP response changes while every process id stays the same. |

## Running them

```bash
yarn run compile-tests
yarn vscode-test --config .vscode-test-devkit.mjs     # pipe-name proof
yarn vscode-test --config .vscode-test-e2eproof.mjs   # end-to-end proof
```

Both harnesses use `--extensions-dir extension/.proof-extensions` so the proof runs against a pinned
extension set instead of whatever the developer happens to have installed. Populate it by **copying**
(not symlinking — VS Code ignores symlinked extension directories) `ms-dotnettools.csharp`,
`ms-dotnettools.csdevkit`, `ms-dotnettools.vscode-dotnet-runtime`, and their platform-specific
companions out of `~/.vscode-insiders/extensions`. Delete `.proof-extensions/extensions.json`
afterwards; it is a scan cache and a stale copy silently hides newly added extensions.

## The end-to-end fixture

`aspireHotReloadE2E.proof.ts` reads its workspace from `ASPIRE_HOT_RELOAD_PROOF_WORKSPACE`, falling
back to `~/aspire-hr-proof`. The fixture is an ordinary Aspire app running **three** .NET project
resources, because a single resource does not show whether a solution-wide delta reaches every
running process:

- `HotReloadProof.AppHost` — adds `api`, `api2`, and `api3` as project resources.
- `HotReloadProof.Api`, `HotReloadProof.Api2`, `HotReloadProof.Api3` — each serves
  `BEFORE-EDIT-<n>` from `/`, its own process id from `/pid`, and writes `app.Urls` to `url.txt`
  next to its own binary so the test can find the port Aspire assigned it.

Each project needs a `Properties/launchSettings.json` with a distinct `applicationUrl`. Without one
Aspire allocates no endpoint, every project falls back to Kestrel's default port 5000, and the second
and third resources die with `AddressInUseException` before they ever serve a request.

The test asserts on both the changed body **and** the unchanged process id, per resource. Only the
pid distinguishes an applied delta from a silent restart, which is the failure mode that makes hot
reload claims easy to get wrong.

### Fixture constraints that will waste your afternoon

- **Rebuild before every run.** This is the one that bites hardest. If the built binary and the
  on-disk source disagree, Dev Kit rejects the edit with
  `Checksum differs for source file 'Program.cs'` and reports `No code changes were found`, which
  looks exactly like a hot reload failure but is a stale build. It reproduces reliably when a run
  follows a previous run without an intervening rebuild.
- **Do not edit immediately after the sessions start.** Dev Kit captures its Edit-and-Continue
  baseline documents a few seconds after a debug session begins. An edit inside that window produces
  the same `Checksum differs` / `No code changes were found` pair as a stale build, for a completely
  different reason: Roslyn read the already-edited file as the baseline. Three fast-starting
  resources reach the edit step roughly two seconds after launch, which no human would, so the test
  waits `ASPIRE_HOT_RELOAD_PROOF_SETTLE_MS` (default 20000) first.
- **Do not put the fixture in `/tmp` on macOS.** The PDB records the real `/private/tmp` path while
  the workspace opens as `/tmp`, and Dev Kit rejects the edit with
  `Source '...' doesn't match output PDB: no document`.
- Pre-build the fixture, or raise `ASPIRE_CLI_START_TIMEOUT`. The CLI gives up after 120 seconds and
  a cold first build can exceed that.
- Clear `.proof-user-data/User/workspaceStorage` after changing the set of projects. Dev Kit caches
  a generated solution there and a stale one silently omits the new projects.

Solution composition does **not** matter, despite appearances. The proof passes with a solution
scoped to the api project alone, with a solution containing the api projects and the AppHost, and
with the solution Dev Kit auto-generates into workspace storage. Do not go looking for a solution
scoping problem; look at the build and the baseline timing first.
