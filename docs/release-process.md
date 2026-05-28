# Aspire Release Process

This document describes the release process for microsoft/aspire, including both the automated workflows and manual steps required by the release manager.

## Overview

The Aspire release process uses two main automation components:

1. **Azure DevOps release pipeline** (`eng/pipelines/release-publish-nuget.yml`)
   - Downloads signed artifacts from a selected official source build.
   - Re-publishes NuGet, npm, WinGet, and Homebrew release inputs so 1ES can generate release SBOMs.
   - Publishes NuGet packages to NuGet.org.
   - Publishes Aspire CLI npm packages through ESRP/MicroBuild.
   - Promotes the build to the GA channel via darc.
   - Submits WinGet manifests and Homebrew cask PRs.
2. **GitHub Actions workflow** (`.github/workflows/release-github-tasks.yml`)
   - Creates Git tags.
   - Creates GitHub Releases.
   - Creates merge-back PRs.
   - Creates baseline version update PRs.

## Prerequisites

Before starting a release:

1. **Signed build**: Have a successful signed build from the official `dotnet-aspire` pipeline.
   - Select this build from the `aspire-build` resource dropdown when running the release pipeline.
   - The build should have a `BAR ID - NNNNNN` tag, which the pipeline extracts automatically.
   - The build must include native CLI NuGet packages and `microsoft-aspire-cli*.tgz` npm tarballs from the native archive jobs.
2. **Release branch**: Ensure the release branch exists, for example `release/9.2`.
3. **Permissions and approvals**:
   - Access to run Azure DevOps pipelines with the publishing pool.
   - Permission to use the NuGet.org service connection.
   - Approval to use the DevDiv ESRP service connection for MicroBuild npm publishing.
   - Valid ESRP owner and approver aliases for npm publishing.
   - GitHub write access for creating tags, releases, and PRs.

## Step-by-step release process

### Step 1: Publish packages and promote the build (Azure DevOps)

1. Navigate to the Azure DevOps pipeline: `release-publish-nuget`.
2. Click **Run pipeline**.
3. Under **Resources**, select the source build from the `aspire-build` dropdown.
4. Fill in the parameters:

   | Parameter | Description | Example |
   |-----------|-------------|---------|
   | `GaChannelName` | Target GA channel | `Aspire 9.x GA` |
   | `DryRun` | Set `true` to validate without publishing | `false` |
   | `SkipNuGetPublish` | Set `true` if NuGet publishing already completed | `false` |
   | `SkipNpmPublish` | Set `true` if npm publishing already completed | `false` |
   | `SkipNpmRidPublish` | Set `true` if npm RID packages completed but the pointer package did not | `false` |
   | `SkipChannelPromotion` | Set `true` if darc channel promotion already completed | `false` |
   | `SkipWinGetPublish` | Set `true` if WinGet publishing already completed | `false` |
   | `SkipHomebrewPublish` | Set `true` if Homebrew publishing already completed | `false` |
   | `NpmPublishOwners` | Comma-separated ESRP owner aliases or emails | `alias@microsoft.com` |
   | `NpmPublishApprovers` | Comma-separated ESRP approver aliases or emails | `approver@microsoft.com` |
   | `NpmRegistryPropagationDelayMinutes` | Delay between npm RID package and pointer package submissions | `10` |

5. Click **Run** and monitor the pipeline.
6. Verify packages appear on NuGet.org and npm.

The npm release path publishes the seven RID packages first, waits for ESRP completion, waits for the configured propagation delay, and then publishes the top-level `@microsoft/aspire-cli` pointer package. This avoids installing a pointer package whose optional RID dependencies are not visible yet.

### Step 2: GitHub tasks (GitHub Actions)

1. Navigate to Actions -> **Release GitHub Tasks**.
2. Click **Run workflow**.
3. Fill in the parameters:

   | Parameter | Description | Example |
   |-----------|-------------|---------|
   | `release_version` | The version being released | `13.2.0` |
   | `commit_sha` | Full 40-character commit SHA from the build | `abc123...` |
   | `release_branch` | Release branch name | `release/9.2` |
   | `is_prerelease` | `true` for preview releases | `false` |
   | `dry_run` | `true` to validate without making changes | `false` |
   | `skip_tagging` | Skip if tag already exists | `false` |
   | `skip_github_release` | Skip if release already exists | `false` |
   | `skip_merge_pr` | Skip if PR already exists | `false` |
   | `skip_baseline_pr` | Skip if PR already exists | `false` |

4. Click **Run workflow** and monitor progress.

Use `dry_run: true` to test the workflow without creating tags, releases, or PRs.

### Step 3: Post-release tasks (manual)

After automation completes:

1. Review and merge PRs:
   - Merge-back PR: `$RELEASE_BRANCH` -> `main`
   - Baseline version PR: updates `PackageValidationBaselineVersion`
2. Verify the release:
   - Check the [GitHub Releases page](https://github.com/microsoft/aspire/releases).
   - Verify packages on [NuGet.org](https://www.nuget.org/packages?q=owner%3Adotnet+aspire).
   - Verify npm packages on the Microsoft npm profile.
   - Test installation: `dotnet new install Aspire.ProjectTemplates::VERSION`.
3. Communicate:
   - Update any tracking issues.
   - Notify stakeholders.

## Handling failures

Both automations are designed to be idempotent and safe to re-run.

### Azure DevOps pipeline failures

| Step failed | Resolution |
|-------------|------------|
| Validate Parameters | Fix the input parameters and re-run. |
| Extract BAR Build ID | Check that the build has a `BAR ID - NNNNNN` tag. |
| Prepare/List/Verify NuGet Packages | Check that the selected source build produced `PackageArtifacts`. |
| Prepare/List npm Packages | Check that the selected source build produced all eight `microsoft-aspire-cli*.tgz` tarballs in `BlobArtifacts`. |
| Push Packages to NuGet.org | Check NuGet.org for partial success, then re-run with already-completed steps skipped as needed. |
| MicroBuild npm Publish | Check the ESRP release result. If RID packages published but the pointer package did not, re-run with `SkipNuGetPublish: true`, `SkipNpmRidPublish: true`, and `SkipChannelPromotion: true`; do not set `SkipNpmPublish` until the pointer package is published. |
| Promote Build to Channel | Re-run with `SkipNuGetPublish: true` and `SkipNpmPublish: true`. |
| WinGet/Homebrew publishing | Re-run with the corresponding skip flags for completed work. |

### GitHub Actions failures

| Job failed | Resolution |
|------------|------------|
| validate | Fix the input parameters and re-run. |
| create-tag | If the tag exists with the wrong SHA, resolve it manually. |
| create-release | Re-run with `skip_tagging: true`. |
| create-merge-pr | Re-run with `skip_tagging: true` and `skip_github_release: true`. |
| create-baseline-pr | Re-run with all prior skips set to `true`. |

## Configuration

### 1ES and MicroBuild compliance

The Azure DevOps pipeline extends `azure-pipelines/1ES.Official.Publish.yml@MicroBuildTemplate`. This keeps the pipeline on the official 1ES publishing template while allowing the `MicroBuild.Publish.yml@MicroBuildTemplate` step to submit npm packages through ESRP.

The source build creates, signs where platform signing applies, verifies, and stages the package artifacts. The release pipeline consumes those pre-built artifacts; it does not rebuild or re-pack the CLI.

### Variable groups

The pipeline uses:

| Variable group | Purpose |
|----------------|---------|
| `Aspire-Release-Secrets` | Release pipeline secrets. NuGet publishing uses a service connection rather than a variable-group API key. |
| `Aspire-Secrets` | WinGet and Homebrew bot tokens. |

### Service connections

| Connection name | Purpose |
|-----------------|---------|
| `NuGet.org - dotnet/aspire` | NuGet service connection for publishing packages to NuGet.org. |
| `DevDivEsrpAzDoSrvConn` | ESRP service connection used by the MicroBuild publish template for npm publishing. |
| `Darc: Maestro Production` | Used for darc channel promotion. |

The release definition must be approved for the MicroBuild publishing template and must have permission to use `DevDivEsrpAzDoSrvConn`.

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

If NuGet publishing fails:

1. Check the pipeline logs for specific error messages.
2. Verify the service connection `NuGet.org - dotnet/aspire` is properly configured.
3. Ensure the service connection has push permissions for the package IDs.
4. Re-run the pipeline with skip flags for work that already completed.

## Architecture diagram

```text
Official source build
  -> Native archive jobs
     -> signed native archives / native CLI packages
     -> npm tarballs verified against the native archive
  -> PackageArtifacts: NuGet packages
  -> BlobArtifacts: microsoft-aspire-cli*.tgz

Azure DevOps release-publish-nuget.yml
  -> PrepareArtifacts
     -> republish NuGet artifacts with SBOM
     -> split npm RID and pointer artifacts with SBOM
  -> ReleaseJob
     -> verify NuGet signatures
     -> publish NuGet through 1ES.PublishNuget@1
     -> publish npm RID packages through MicroBuild.Publish
     -> wait for npm propagation
     -> publish npm pointer package through MicroBuild.Publish
     -> promote BAR build to GA channel
  -> WinGetJob / HomebrewJob

GitHub release-github-tasks.yml
  -> create tag
  -> create GitHub release
  -> create merge-back PR
  -> create baseline version PR
```

## Related documentation

- [Contributing Guide](contributing.md)
- [Quarantined Tests](quarantined-tests.md)
