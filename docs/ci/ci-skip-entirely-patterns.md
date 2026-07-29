# CI Skip-Entirely Patterns

## Overview

The file `eng/github-ci/ci-skip-entirely-patterns.txt` lists glob patterns for files whose changes do **not** require the full CI to run. This is the top-level skip gate, not the selective-test router (see [`test-trigger-map.md`](test-trigger-map.md) for path → test/job routing).

When a pull request is opened or updated, the CI workflow (`ci.yml`) checks whether **all** changed files match at least one pattern in the file. If they do, the workflow is skipped (no build or test jobs run). This keeps CI fast for changes that only affect documentation, pipeline configuration, or unrelated workflow files.

> **Note:** This mechanism applies only to **pull requests**. Pushes to `main` or `release/*` branches always run the full CI pipeline. The `check-changed-files` action explicitly rejects non-`pull_request` events.

Some Markdown files are packaging inputs rather than documentation. The CI workflow passes those files through the action's `keep_unmatched` input so they are not hidden by the global `**.md` skip pattern. Today that carve-out covers the CLI npm packaging templates under `eng/scripts/pack-cli-npm-package.*.md`; template-only PRs therefore continue into the regular test selector, which routes them to the npm packaging validation coverage.

## Why a Separate File?

Previously the patterns were inlined in `.github/workflows/ci.yml`. Any change to that file (even just adding a new pattern to skip CI) would trigger CI on itself. Moving the patterns to `eng/github-ci/ci-skip-entirely-patterns.txt` decouples pattern maintenance from the workflow definition.

## Pattern Syntax

Patterns use a simple **glob** style:

| Syntax | Meaning |
|--------|---------|
| `**`   | Matches any path including directory separators (recursive) |
| `*`    | Matches any characters except a directory separator        |
| `.`    | Treated as a literal dot — no backslash escaping needed    |

All other characters (letters, digits, `-`, `_`, `/`, etc.) are treated as literals.

Lines starting with `#` and blank lines are ignored.

### Examples

```text
# All Markdown files anywhere in the repo
**.md

# All files under eng/pipelines/ recursively
eng/pipelines/**

# A specific file
eng/test-configuration.json

# Workflow files matching a glob (e.g. labeler-promote.yml, labeler-train.yml)
.github/workflows/labeler-*.yml
```

## How to Add a New Pattern

To add files whose changes should not trigger CI:

1. Open `eng/github-ci/ci-skip-entirely-patterns.txt`.
2. Add one pattern per line, optionally preceded by a comment.
3. Submit a PR — CI will not run for that PR if all changed files match the patterns.

> **Tip:** Changing the patterns file itself is listed as a skippable change (`eng/github-ci/ci-skip-entirely-patterns.txt`), so a PR that only updates this file will not trigger CI.

## How It Works

The `.github/actions/check-changed-files` composite action:

1. Reads `eng/github-ci/ci-skip-entirely-patterns.txt` from the checked-out repository.
2. Converts each glob pattern to an anchored ERE (Extended Regular Expression) regex:
   - `**` → `.*`
   - `*` → `[^/]*`
   - `.` and other regex metacharacters (`+`, `?`, `[`, `]`, `(`, `)`, `|`, `$`, `^`, `{`, `}`) → escaped with `\`
3. For every file changed in the PR, checks whether the file path matches at least one of the converted regexes.
4. Applies the caller's `keep_unmatched` carve-outs before the skip patterns, forcing those files to stay unmatched even if a broad skip pattern such as `**.md` would otherwise match them. Carve-outs are written as globs (not literal file lists) so that adding a file to a carved-out family — such as a new `pack-cli-npm-package.<name>.md` template — is covered automatically instead of depending on someone remembering to update every place the family is enumerated.
5. Outputs `only_changed=true` when every changed file matched, allowing the calling workflow to skip further jobs.

> **Important:** step 2's glob-to-regex conversion exists twice — in the action's `glob_to_regex` bash function and in its C# port in `tools/SelectTests/ChangedFileFilter.cs`, which the selective-test selector uses to drop skippable files. Both read this same patterns file, so the selector's "excluded" set must equal the gate's "skip" set. Change the escape set in one and you must change it in the other; `GlobToRegexParityTests` fails if they diverge.

## Related Files

- `eng/github-ci/ci-skip-entirely-patterns.txt` — the patterns file described on this page
- `.github/actions/check-changed-files/action.yml` — the composite action that reads and evaluates the patterns
- `.github/workflows/ci.yml` — the CI workflow that calls the action
- `eng/github-ci/test-trigger-map.yml` — the selective-test map that routes the CLI npm templates to packaging validation after `keep_unmatched` lets them through the skip gate
- `tests/Infrastructure.Tests/TestTriggerMap/CheckChangedFilesActionTests.cs` — behavioral tests for the skip gate action
- `tests/Infrastructure.Tests/TestTriggerMap/GlobToRegexParityTests.cs` — pins the action's `glob_to_regex` and its C# port to the same glob semantics
