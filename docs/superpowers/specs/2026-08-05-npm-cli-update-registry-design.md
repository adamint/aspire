# Align npm CLI Update Discovery with npm Availability

Issue: [microsoft/aspire#17808](https://github.com/microsoft/aspire/issues/17808)

## Summary

When the Aspire CLI is launched from `@microsoft/aspire-cli`, update discovery
will use the `latest` version from the internal `dotnet-public-npm` mirror
instead of Aspire CLI package metadata from NuGet.

The release pipeline will seed the newly published npm pointer package into
that mirror after public npm validation succeeds. It will then prove that an
anonymous client can resolve an internal `@latest` version at-or-above the
published version before channel promotion continues.

This keeps every automatic update decision aligned with a version proven to be
published to npm and anonymously mirrored by Aspire's package source while
reusing the existing `INpmRunner` implementation.

## Problem

`CliUpdateNotifier` currently chooses a newer version from NuGet metadata and
only changes the suggested command after that decision:

```csharp
var newerVersion = PackageUpdateHelpers.GetNewerVersion(logger, currentVersion, _availablePackages);
var updateCommand = newerVersion is null
    ? null
    : DotNetToolDetection.GetDotNetToolUpdateCommand(processPathProvider.ProcessPath)
        ?? NpmInstallDetection.GetNpmUpdateCommand()
        ?? "aspire update";
```

The npm release has a separate pointer-package publish step and propagation
window. Publishing may also be skipped or partially fail. NuGet can therefore
advertise a version before the npm pointer package is available, causing the
CLI to recommend:

```text
npm install -g @microsoft/aspire-cli@latest
```

while npm still resolves the already-installed version.

The same notifier now feeds three behaviors:

- post-command update notifications
- the CLI version check in `aspire doctor`
- `UpdateCommand.IsUpdateAvailable()` after project updates

Fixing only the displayed command would leave those consumers inconsistent.

## Goals

- Use npm package metadata for automatic update decisions when the CLI was
  launched by the npm package.
- Reuse `INpmRunner.ResolvePackageAsync` and its existing internal registry,
  process-launch, parsing, and telemetry behavior.
- Guarantee that stable npm releases are anonymously resolvable through
  `dotnet-public-npm` before release channel promotion.
- Keep normal command completion quiet when update discovery fails while
  preserving the existing `aspire doctor` warning.
- Avoid duplicate npm resolution within one CLI process.

## Non-goals

- Changing explicit `aspire update --self` behavior for npm installations.
- Adding an Aspire-specific npm registry setting.
- Supporting prerelease npm publication or non-`latest` npm dist-tags.
- Publishing a second copy of the npm package directly to Azure Artifacts.
- Changing update discovery for dotnet tool, standalone archive, Nix, or local
  development installations.

## Design

### Release-time mirror seeding

The release pipeline already validates the published pointer package from
`https://registry.npmjs.org/` before channel promotion. Add a mirror-seeding
gate immediately after that public registry smoke and before the
`# ===== PROMOTE TO CHANNEL =====` boundary.

The gate will:

1. Create a temporary `.npmrc` under `$(Agent.TempDirectory)` that points at:

   ```text
   https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/
   ```

2. Run `npmAuthenticate@0` against that file. The task uses the release
   pipeline's `internal Build Service (dnceng)` identity.
3. In an isolated temporary directory, install the exact public
   pointer-package version through `dotnet-public-npm` with the equivalent of:

   ```text
   npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false @microsoft/aspire-cli@<version>
   ```

   This is a local temporary install, not a global install. It avoids lifecycle
   scripts and persistent project files while causing Azure Artifacts to save
   the package from its npm upstream.
4. Switch to a clean npm user configuration with no credentials and retry:

   ```text
   npm view @microsoft/aspire-cli@latest version
   ```

   against `dotnet-public-npm`.
5. Parse a stable SemVer result and require the anonymous internal `latest`
   version to be at-or-above the selected pointer-package version.
6. Clean up the temporary npm configuration, cache, prefix, and install
   directory.

The at-or-above rule handles safe reruns after a newer stable release has
already advanced `latest`. A normal release should resolve the exact version
that was just published.

The seeding gate runs on real stable release paths, including reruns where
`SkipNpmPointerPublish=true` because the public pointer package already exists.
It does not run during dry runs or prerelease runs because it mutates the
internal upstream cache.

Failure to authenticate, ingest the package, parse the mirrored version, or
prove anonymous resolution fails the release job before channel promotion.
Public npm publication is immutable, so the documented recovery is to rerun
with completed npm publishing steps skipped and let the mirror gate retry.

The live feed ACL was checked during design. `internal Build Service (dnceng)`
has the `contributor` role on `dotnet-public-npm`; that role includes ingesting
packages from configured upstream sources. No feed permission change is
expected.

### npm update source selection

Inject the existing `INpmRunner` into `CliUpdateNotifier`.

`CheckForCliUpdatesAsync` will choose one update source:

```csharp
if (NpmInstallDetection.IsRunningFromNpm())
{
    // Resolve @microsoft/aspire-cli@latest from dotnet-public-npm.
}
else
{
    // Preserve the existing NuGet package lookup.
}
```

For an npm launch, call:

```csharp
await npmRunner.ResolvePackageAsync(
    NpmInstallDetection.ExpectedPackageName,
    "latest",
    cancellationToken);
```

Do not query NuGet for that invocation. The npm dist-tag has already selected
one version, so compare it directly with the physical CLI binary version using
SemVer precedence. Equal or older mirrored versions produce no update.

Non-npm installations keep the current NuGet package selection rules,
including stable/prerelease handling.

### Caching and concurrency

Share one in-flight npm resolution between concurrent notifier consumers.
Retain a successful result for the CLI process lifetime.

If resolution fails or is cancelled, clear the in-flight entry. This allows an
explicit later call, such as `aspire doctor`, to retry instead of permanently
caching a transient failure.

The cached npm result and the existing NuGet package cache remain separate so
the selected source is explicit and one install type cannot accidentally reuse
the other source.

### Status and command behavior

`GetCachedVersionStatus` will use the selected source to compute
`LatestVersion`, then preserve the existing update-command selection. An npm
launch continues to produce:

```text
npm install -g @microsoft/aspire-cli@latest
```

`LatestVersionChannel` continues to derive from the selected version's
prerelease flag. Current npm publishing only advances the stable `latest`
dist-tag.

Because all consumers read `CliVersionStatus`, the source change applies
consistently to:

- post-command notifications
- `aspire doctor`
- project-update CLI prompting through `IsUpdateAvailable()`

Explicit `aspire update --self` remains package-manager driven and continues to
print the npm command without first requiring automatic update metadata.

### Failure behavior

If `INpmRunner` is unavailable, returns no package, or cannot parse a version,
the npm update check fails with a clear diagnostic. It does not fall back to
NuGet.

This uses the existing caller behavior:

- background prefetch logs the failure at debug level and normal command
  completion shows no update notification
- `GetVersionStatusAsync` returns `UpdateCheckError`, allowing `aspire doctor`
  to show its existing update-check warning

Treating lookup failure as "up to date" would hide registry problems.
Falling back to NuGet would recreate the false npm guidance from this issue.

## Testing

### CLI tests

Extend `CliUpdateNotificationServiceTests` to cover:

- mirrored npm `latest` newer than the physical binary
- mirrored npm `latest` equal to or older than the physical binary
- NuGet metadata being ignored for npm launches
- npm resolution failure producing `UpdateCheckError`
- routine notification suppression after npm resolution failure
- successful npm resolution being reused across notifier consumers
- unchanged NuGet behavior for non-npm installations

Use a configurable test `INpmRunner` rather than network access.

Extend `NpmRunnerTests` with the existing fake npm executable pattern to prove
that resolving `@microsoft/aspire-cli@latest` uses the internal registry and
parses the returned version.

### Pipeline tests

Extend `ReleasePublishNugetPipelineTests` to require:

- temporary internal-feed `.npmrc` creation
- `npmAuthenticate@0`
- authenticated upstream ingestion
- a clean anonymous verification configuration
- bounded retries and the at-or-above version gate
- ordering after public npm validation and before channel promotion
- execution on pointer-publish reruns
- no mirror mutation during dry runs or prerelease runs

### Real-path proof

After targeted local tests pass, run the internal release pipeline against an
already-published stable build with public publishing, channel promotion, and
unrelated release actions skipped. The only intended external mutation is
seeding `@microsoft/aspire-cli` into `dotnet-public-npm`.

The proof is complete when an anonymous:

```text
npm view @microsoft/aspire-cli@latest version
```

against `dotnet-public-npm` returns a version at-or-above the selected build.

## Documentation

Update:

- `docs/specs/npm-cli-package.md` to describe the mirrored npm version source
  and release-time seeding contract
- `docs/release-process.md` with mirror gate ordering, rerun instructions, and
  troubleshooting for authentication or anonymous-resolution failures

## Tradeoffs

- The CLI depends on the Microsoft-managed mirror rather than each user's npm
  registry configuration. This gives Aspire one controlled source and reuses
  existing hardened npm resolution behavior, but makes mirror seeding part of
  the release contract.
- A mirror-gate failure happens after public npm publication. The package
  cannot be withdrawn, but promotion remains blocked and the idempotent seeding
  step can be retried without republishing.
- Anonymous users cannot cause Azure Artifacts to ingest a missing upstream
  package. The authenticated release step is therefore required; relying on
  organic package access would leave the original race unresolved.

## Success criteria

- An npm-launched CLI never recommends a NuGet-only Aspire CLI version.
- Every automatic notifier consumer agrees on the mirrored npm version.
- A stable release cannot promote until the internal mirror anonymously serves
  an `@latest` version at-or-above the published pointer package.
- Non-npm update behavior remains unchanged.
