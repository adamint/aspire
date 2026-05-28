# Aspire Release Process

This document describes the release process for microsoft/aspire, including both the automated workflows and manual steps required by the release manager.

## Overview

The Aspire release process uses two main automation components:

1. **Azure DevOps pipeline** ([`release-publish-nuget`](https://dev.azure.com/dnceng/internal/_build?definitionId=1600&_a=summary), source: `eng/pipelines/release-publish-nuget.yml`)
   - Downloads signed artifacts from a selected official source build.
   - Re-publishes NuGet, npm, WinGet, and Homebrew release inputs so 1ES can generate release SBOMs.
   - Publishes NuGet packages to NuGet.org.
   - Publishes Aspire CLI npm packages through ESRP/MicroBuild.
   - Promotes the build to the GA channel via darc.
   - Submits WinGet manifests and Homebrew cask PRs.
   - Dispatches the GitHub Actions workflow below as the `aspire-repo-bot` GitHub App and waits for it to complete.
   - Uploads `aspire-cli-*` archives from the source build's `BlobArtifacts` onto the GitHub Release as the `aspire-repo-bot`.
2. **GitHub Actions workflow** (`.github/workflows/release-github-tasks.yml`)
   - Creates Git tags.
   - Creates GitHub Releases.
   - Creates merge-back PRs.
   - Creates baseline version update PRs.
   - Normally runs when dispatched by the AzDO pipeline; it can also be run manually as a fallback for partial-failure re-runs.

## Prerequisites

Before starting a release:

1. **Signed build**: Have a successful signed build from the official [`microsoft-aspire`](https://dev.azure.com/dnceng/internal/_build?definitionId=1602) pipeline.
   - Select this build from the `aspire-build` resource dropdown when running the release pipeline.
   - The build should have a `BAR ID - NNNNNN` tag, which the pipeline extracts automatically.
   - The build should also have a `release-version - X.Y.Z` tag, which the pipeline uses when `ReleaseVersion` is left as `auto`.
   - The build must include native CLI NuGet packages and `microsoft-aspire-cli*.tgz` npm tarballs from the native archive jobs.
2. **Release branch**: Ensure the release branch exists, for example `release/9.2`.
3. **Permissions and approvals**:
   - Access to run Azure DevOps pipelines with the publishing pool.
   - Permission to use the NuGet.org service connection.
   - Approval to use the DevDiv ESRP service connection for MicroBuild npm publishing.
   - Valid ESRP owner and approver aliases for npm publishing.
   - GitHub write access for creating tags, releases, and PRs if you need to run the GitHub workflow manually.
4. **AzDO secrets** (already configured for chained dispatch):
   - `aspire-bot-app-id` — `aspire-repo-bot` GitHub App ID.
   - `aspire-bot-private-key` — `aspire-repo-bot` GitHub App PEM private key.

   Both live in the **`Aspire-Release-Secrets`** variable group (AzDO → Pipelines → Library) and are marked as secret. To rotate the private key, generate a new one from the App settings page (github.com/organizations/dotnet/settings/apps/aspire-repo-bot → "Private keys" → "Generate a private key"), paste the full PEM (including the `-----BEGIN/END-----` lines) into the `aspire-bot-private-key` variable, save, then revoke the old key from the same App settings page. The App ID does not change on rotation.

## Step-by-step release process

### Step 1: Run the AzDO release pipeline

1. Navigate to the Azure DevOps pipeline: [release-publish-nuget](https://dev.azure.com/dnceng/internal/_build?definitionId=1600&_a=summary) (definition `1600` in `dnceng/internal`).
2. Click **Run pipeline**.
3. Fill in the parameters. Most should stay at their defaults; the ones flagged `[Advanced]` in the run-pipeline form are only for re-running after a partial failure or for testing pipeline changes on a topic branch.

   **Common (you may set these every release):**

   | Parameter | Description | Example |
   |-----------|-------------|---------|
   | `ReleaseVersion` | Override for the version label (used as `v<version>` tag). Leave as `auto` to derive from the source build's `release-version - *` tag, which is the normal case. Only set this when re-shipping under a corrected tag. | `auto` |
   | `IsPrerelease` | `true` for preview releases. | `false` |
   | `DryRun` | Set `true` to test without publishing, promoting, tagging, or creating PRs. | `false` |
   | `GaChannelName` | Target GA channel. | `Aspire 9.x GA` |

   **Advanced (leave defaults unless you know what you're doing):**

   | Parameter | Description | Default |
   |-----------|-------------|---------|
   | `SkipNuGetPublish` | Set `true` if re-running after NuGet success. | `false` |
   | `SkipNpmPublish` | Set `true` if re-running after all npm packages are published. | `false` |
   | `SkipNpmRidPublish` | Set `true` if npm RID packages published but the pointer package did not. | `false` |
   | `SkipChannelPromotion` | Set `true` if re-running after darc success. | `false` |
   | `SkipWinGetPublish` | Set `true` if re-running after WinGet success. | `true` |
   | `SkipHomebrewPublish` | Set `true` if re-running after Homebrew success. | `true` |
   | `SkipGitHubTasks` | Set `true` to skip dispatching the GH workflow. | `false` |
   | `SkipReleaseAssets` | Set `true` to skip uploading `aspire-cli-*` assets to the GitHub release. | `false` |
   | `NpmPublishOwners` | Comma-separated ESRP owner aliases or emails. Required when `DryRun` is `false` and npm publishing is not skipped. | `alias@microsoft.com` |
   | `NpmPublishApprovers` | Comma-separated ESRP approver aliases or emails. Required when `DryRun` is `false` and npm publishing is not skipped. | `approver@microsoft.com` |
   | `NpmRegistryPropagationDelayMinutes` | Delay between npm RID package and pointer package submissions. | `10` |
   | `GitHubTasksWorkflowRef` | Ref to load `release-github-tasks.yml` from when dispatching. Only affects the workflow source; the release branch and commit are passed via inputs. Override only when testing pipeline changes on a topic branch. | `main` |

4. Select the **Resources** button in the bottom right, then select the source build from the `aspire-build` dropdown.
   - The picker shows all recent builds from the `microsoft-aspire` pipeline regardless of branch. Pick the build that corresponds to the release branch and version you intend to ship.
   - Each build's tags are shown alongside its number. Verify the `release-version - X.Y.Z` tag matches the version you intend to ship before clicking **Run**. If the tag is missing, either re-run the source build after the tag-emitting change in `azure-pipelines.yml` is on that release branch or pass an explicit `ReleaseVersion` override.
5. Click **Run** and monitor the pipeline. The final stage (`GitHubTasks`) dispatches `release-github-tasks.yml`, waits for it to complete, and then uploads the `aspire-cli-*` archives from the source build's `BlobArtifacts` onto the newly-created GitHub release. The AzDO pipeline only succeeds if both pieces succeed.
6. Verify packages appear on NuGet.org and npm, and verify that the `aspire-cli-*` archives are attached to the GitHub release.

The npm release path publishes the seven RID packages first, waits for ESRP completion, waits for the configured propagation delay, and then publishes the top-level `@microsoft/aspire-cli` pointer package. This avoids installing a pointer package whose optional RID dependencies are not visible yet.

`commit_sha` and `release_branch` for the GitHub workflow are derived automatically from the source build resource, so there is no need to copy them by hand.

> **Tip**: Use `DryRun: true` to test end-to-end without publishing, promoting, tagging, creating PRs, or uploading release assets. The dry-run state is propagated to the GitHub workflow as `dry_run: true`.

### Step 2 (fallback): Manually re-run the GitHub workflow

The GitHub workflow is normally dispatched by the AzDO pipeline as the `aspire-repo-bot` GitHub App, with its `authorize` job bypassed for the bot. If a GitHub-side step fails partway through and you need to re-run only the GitHub work, you can:

1. Re-run the AzDO pipeline with completed AzDO-side work skipped, such as `SkipNuGetPublish`, `SkipNpmPublish`, `SkipChannelPromotion`, `SkipWinGetPublish`, `SkipHomebrewPublish`, and `SkipReleaseAssets` set as appropriate, keeping `SkipGitHubTasks: false`. The `GitHubTasks` stage will dispatch the workflow again with the right inputs, and the workflow's own `skip_*` idempotency makes the completed steps no-ops.
2. Or, navigate to Actions → **Release GitHub Tasks**, click **Run workflow**, and fill in the parameters manually:

   | Parameter | Description | Example |
   |-----------|-------------|---------|
   | `release_version` | The version being released. | `13.0.0` |
   | `commit_sha` | Full 40-character commit SHA from the build. | `abc123...` |
   | `release_branch` | Release branch name. | `release/9.2` |
   | `is_prerelease` | `true` for preview releases. | `false` |
   | `dry_run` | `true` to validate without making changes. | `false` |
   | `skip_tagging` | Skip if tag already created. | `false` |
   | `skip_github_release` | Skip if release already exists. | `false` |
   | `skip_merge_pr` | Skip if PR already created. | `false` |
   | `skip_baseline_pr` | Skip if PR already created. | `false` |

Manual runs go through the normal `authorize` check (admin/maintain permission required).

### Step 3: Post-release tasks

After automation completes:

1. **Review and merge automatically created PRs**:
   - Merge-back PR: `$RELEASE_BRANCH` → `main`.
   - Baseline version PR: updates `PackageValidationBaselineVersion`.
2. **Verify the release**:
   - Check the [GitHub Releases page](https://github.com/microsoft/aspire/releases).
   - Verify packages on [NuGet.org](https://www.nuget.org/packages?q=Aspire).
   - Verify npm packages on the Microsoft npm profile.
   - Test installation: `dotnet new install Aspire.ProjectTemplates::VERSION` and `aspire update --self`.
3. **Communicate**:
   - Update any tracking issues.
   - Notify stakeholders.

## Handling failures

Both automations are designed to be idempotent and safe to re-run.

### Azure DevOps pipeline failures

| Step failed | Resolution |
|-------------|------------|
| Validate Parameters | Fix the input parameters and re-run. |
| Derive ReleaseVersion | Check that the build has a `release-version - X.Y.Z` tag, or pass `ReleaseVersion` explicitly. |
| Extract BAR Build ID | Check that the build has a `BAR ID - NNNNNN` tag. |
| Prepare/List/Verify NuGet Packages | Check that the selected source build produced `PackageArtifacts`. |
| Prepare/List npm Packages | Check that the selected source build produced all eight `microsoft-aspire-cli*.tgz` tarballs in `BlobArtifacts`. |
| Push Packages to NuGet.org | Check NuGet.org for partial success, then re-run with already-completed steps skipped as needed. |
| MicroBuild npm Publish | Check the ESRP release result. If RID packages published but the pointer package did not, re-run with `SkipNuGetPublish: true`, `SkipNpmRidPublish: true`, and `SkipChannelPromotion: true`; do not set `SkipNpmPublish` until the pointer package is published. |
| Promote Build to Channel | Re-run with completed publish steps skipped. |
| WinGet/Homebrew publishing | Re-run with the corresponding skip flags for completed work. |
| GitHubTasks dispatch | Re-run with completed AzDO-side work skipped and `SkipGitHubTasks: false`; set `SkipReleaseAssets` according to whether release asset upload already completed. |
| Release asset upload | Re-run with `SkipGitHubTasks: true` and `SkipReleaseAssets: false` after the GitHub release exists. |

### GitHub Actions failures

The GitHub workflow runs as a single `release` job with all tasks as sequential steps. If a step fails, drill into the run UI to see exactly which step (tag, release, merge PR, baseline PR) hit the issue.

Re-run with the corresponding `skip_*` input set to `true` to skip steps that have already succeeded. The skip inputs are still passed step-by-step so partial-failure re-runs behave the same way they did before consolidation.

| Step failed | Resolution |
|-------------|------------|
| Authorize | Caller lacks admin/maintain permission, or the AzDO bot identity check failed. |
| Validate Version Format / Commit SHA | Fix the input parameters and re-run. |
| Create Tag | If the tag exists with the wrong SHA, resolve it manually. |
| Create GitHub Release | Re-run with `skip_tagging: true`. |
| Create Merge PR | Re-run with `skip_tagging: true` and `skip_github_release: true`. |
| Create Baseline PR | Re-run with all prior skips set to `true`. |

## Configuration

### 1ES and MicroBuild compliance

The AzDO pipeline extends the 1ES Official Pipeline Template (`v1/1ES.Official.PipelineTemplate.yml@1ESPipelineTemplates`) to be compliant with Microsoft organization requirements. It also consumes `MicroBuild.Publish.yml@MicroBuildTemplate` for npm submissions through ESRP. The source build creates, signs where platform signing applies, verifies, and stages the package artifacts; the release pipeline consumes those pre-built artifacts and does not rebuild or re-pack the CLI.

### Variable groups

The pipeline uses:

| Variable group | Purpose |
|----------------|---------|
| `Aspire-Release-Secrets` | Release pipeline secrets, including the `aspire-repo-bot` GitHub App credentials. NuGet publishing uses a service connection rather than a variable-group API key. |
| `Aspire-Secrets` | WinGet and Homebrew bot tokens. |

### Service connections

| Connection name | Purpose |
|-----------------|---------|
| `NuGet.org - dotnet/aspire` | NuGet service connection for publishing packages to NuGet.org. |
| `DevDivEsrpAzDoSrvConn` | ESRP service connection used by the MicroBuild publish template for npm publishing. |
| `Darc: Maestro Production` | Used for darc channel promotion. |

The release definition must be approved for the 1ES and MicroBuild publishing templates and must have permission to use `DevDivEsrpAzDoSrvConn`.

### Approved GitHub Actions

The workflow uses only pre-approved actions:

- `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4).
- `./.github/actions/create-pull-request` (local composite action).

## Troubleshooting

### Could not find BAR ID tag

The pipeline expects the build to have a tag in format `BAR ID - NNNNNN`. This is normally added automatically by the Maestro publishing process. If missing:

1. Check if the build completed its post-build steps.
2. Manually look up the BAR ID in Maestro and add the tag.
3. Contact the engineering team if the issue persists.

### npm tarballs are missing from release artifacts

The official source build should fail staging if npm tarballs are missing. If the release pipeline cannot find them:

1. Confirm the selected source build is from a branch that includes npm packaging.
2. Check the native archive jobs for `verify-cli-npm-package.ps1` failures.
3. Check `BlobArtifacts` for the eight `microsoft-aspire-cli*.tgz` files.

### npm publish fails after RID packages published

If ESRP published the RID packages but failed before publishing `@microsoft/aspire-cli`:

1. Verify the RID packages are visible on npm.
2. Re-run the release pipeline with completed non-npm steps skipped.
3. Set `SkipNpmRidPublish: true` and keep `SkipNpmPublish: false` so only the pointer package is submitted.
4. Set `SkipNpmPublish: true` only after the pointer package is visible.

### Tag already exists but points to different commit

This indicates a mismatch between the expected release commit and an existing tag. Resolution:

1. Verify you're using the correct commit SHA.
2. If the existing tag is wrong, it must be manually deleted by someone with the required permission.
3. If the SHA is wrong, correct it and re-run.

### NuGet publish failures

The `1ES.PublishNuget@1` task is configured with `allowPackageConflicts: true`, which means it skips packages that already exist on NuGet.org. If publishing fails:

1. Check the pipeline logs for specific error messages.
2. Verify the service connection `NuGet.org - dotnet/aspire` is properly configured.
3. Ensure the service connection has push permissions for the package IDs.
4. Re-run the pipeline with skip flags for work that already completed.

### PR creation fails

The workflow checks for existing PRs before creating. If a PR exists with a different title:

1. Close or merge the existing PR.
2. Re-run the workflow.

## Architecture diagram

```text
Official source build
  -> Native archive jobs
     -> signed native archives / native CLI packages
     -> npm tarballs verified against the native archive
  -> PackageArtifacts: NuGet packages
  -> BlobArtifacts: microsoft-aspire-cli*.tgz and aspire-cli-* release assets

Azure DevOps release-publish-nuget.yml
  -> PrepareArtifacts
     -> republish NuGet artifacts with SBOM
     -> split npm RID and pointer artifacts with SBOM
     -> republish installer artifacts with SBOM when selected
  -> ReleaseJob
     -> verify NuGet signatures
     -> publish NuGet through 1ES.PublishNuget@1
     -> publish npm RID packages through MicroBuild.Publish
     -> wait for npm propagation
     -> publish npm pointer package through MicroBuild.Publish
     -> promote BAR build to GA channel
  -> WinGetJob / HomebrewJob
  -> GitHubTasks
     -> dispatch release-github-tasks.yml as aspire-repo-bot
     -> upload aspire-cli-* assets to the GitHub release

GitHub release-github-tasks.yml
  -> create tag
  -> create GitHub release
  -> create merge-back PR
  -> create baseline version PR
```

## Related documentation

- [Contributing Guide](contributing.md)
- [Quarantined Tests](quarantined-tests.md)
