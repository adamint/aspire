---
name: dashboard-e2e-testing
description: Interactive browser-based E2E testing of Aspire dashboard features/fixes using Playwright CLI against a running playground app. Enumerates branch changes, starts an app via Aspire CLI, tests each change in a real browser, and captures screenshot + video evidence. NOT the same as dashboard-testing (which is unit/bUnit).
---

# Dashboard E2E Testing with Playwright CLI

Test dashboard changes in a real browser against a running playground app. Produces screenshot and video evidence for every feature/fix on the branch.

**Not the same as the `dashboard-testing` skill** — that covers unit tests and bUnit (in-memory, no browser).

## Prerequisites

- `aspire` CLI on PATH
- `playwright-cli` on PATH (run `playwright-cli install-browser` if no browser is installed)
- Repo built (`./build.sh` or `./build.cmd`)

## Command Reference

| Command | Purpose |
|---------|---------|
| `git log --oneline main..HEAD` | List branch commits |
| `git diff main --name-only` | List changed files |
| `aspire start --isolated --apphost <path>` | Start playground app in background (isolated) |
| `aspire describe --format Json` | Get resource endpoints (including dashboard URL) |
| `aspire wait <resource>` | Block until resource is healthy |
| `aspire stop` | Stop the running app |
| `playwright-cli open <url>` | Open browser (headless by default) |
| `playwright-cli snapshot` | Get element refs for the current page |
| `playwright-cli click <ref>` | Click element |
| `playwright-cli fill <ref> <text>` | Fill input field |
| `playwright-cli screenshot --filename <f>` | Save screenshot |
| `playwright-cli screenshot --full-page --filename <f>` | Full-page screenshot |
| `playwright-cli video-start` | Begin recording |
| `playwright-cli video-stop --filename <f>` | Stop recording, save video |
| `playwright-cli resize <w> <h>` | Resize viewport |
| `playwright-cli eval <js>` | Evaluate JS on page |

## Workflow

### Step 1: Discover Branch Changes

```bash
git log --oneline main..HEAD
git diff main --name-only
git diff main --name-only -- 'src/Aspire.Dashboard/' 'tests/Aspire.Dashboard*'
```

**Enumerate every feature and bug fix.** For each, determine:
- What changed and which dashboard page/area it affects (Resources, Console Logs, Structured Logs, Traces, Metrics, Settings)
- What data, resources, or configuration the playground app needs to exercise it

### Step 2: Choose and Prepare the Playground App

| Dashboard Area | Playground | AppHost Path |
|---------------|-----------|--------------|
| General UI, logs, traces | TestShop | `playground/TestShop/AppHost/AppHost.csproj` |
| Health checks | HealthChecks | `playground/HealthChecks/HealthChecks.AppHost/HealthChecks.AppHost.csproj` |
| Database resources | PostgresEndToEnd | `playground/PostgresEndToEnd/PostgresEndToEnd.AppHost/PostgresEndToEnd.AppHost.csproj` |
| Redis | Redis | `playground/Redis/Redis.AppHost/Redis.AppHost.csproj` |
| Container resources | CustomResources | `playground/CustomResources/CustomResources.AppHost/CustomResources.AppHost.csproj` |
| Azure resources | AzureStorageEndToEnd | `playground/AzureStorageEndToEnd/AzureStorageEndToEnd.AppHost/AzureStorageEndToEnd.AppHost.csproj` |
| Stress / high volume | Stress | `playground/Stress/Stress.AppHost/Stress.AppHost.csproj` |
| Browser telemetry | BrowserTelemetry | `playground/BrowserTelemetry/BrowserTelemetry.AppHost/BrowserTelemetry.AppHost.csproj` |

**TestShop is the default** — it provides diverse resources, logs, traces, and metrics.

#### When No Playground Has the Right Data

For each change, check whether the chosen playground actually produces the data the feature needs:
- Does it have the required resource types? (e.g., resources with volumes, failing health checks, specific env vars)
- Does it emit the required telemetry? (e.g., error traces, specific log severities, particular metric counters)
- Does it have the right topology? (e.g., multiple interconnected services, endpoints in a particular state)

**If there's a gap, modify a playground before testing:**

1. Pick the closest playground to modify (TestShop for general features, domain-specific playgrounds otherwise)
2. Determine the minimum addition: a new resource in `Program.cs`, a service that emits specific telemetry, config changes, or data seeding
3. **Prompt the user** with what you plan to add, why, and to which playground. Wait for confirmation.
4. Make the changes, keeping them minimal and well-commented
5. Rebuild: `./build.sh`

**Example:** Branch adds a "Volumes" column to Resources. No playground has resources with volumes. → Add a container with `WithVolume()` to TestShop's AppHost → Prompt user → After confirmation, add and rebuild.

### Step 3: Build, Start, and Connect

```bash
# Build (skip if no changes since last build)
./build.sh

# Start the app (--isolated avoids port conflicts with other running AppHosts)
aspire start --isolated --apphost playground/TestShop/AppHost/AppHost.csproj

# Wait for resources to be healthy
aspire wait catalogservice

# Get the dashboard URL
aspire describe --format Json
```

From the JSON output, extract the dashboard URL. It will be an `https://localhost:XXXXX` endpoint. The output from `aspire start` also prints the dashboard URL with a login token — use this URL directly as it includes authentication.

If `aspire start` fails, check `aspire describe` for resource states and `aspire logs <resource>` for errors before retrying.

### Step 4: Open Browser and Start Recording

```bash
# Evidence MUST be stored outside the git repo to avoid committing test artifacts
export EVIDENCE_DIR=$(mktemp -d)/dashboard-e2e-evidence
mkdir -p "$EVIDENCE_DIR"
playwright-cli open <dashboard-url-with-token>
playwright-cli video-start
```

The browser runs **headless by default**, which is correct for agent workflows — screenshots and video still capture everything. Use `--headed` only if a human needs to watch the browser live. Start video **before** any testing.

**Important:** Always use `$EVIDENCE_DIR` for screenshot and video filenames instead of a relative `evidence/` path. This prevents test artifacts from being added to the git repo.

The dashboard URL from `aspire start` includes a login token query parameter (e.g., `?t=<token>`). Use this full URL to bypass authentication. If you only have the base URL, check `aspire describe` output for the token.

### Step 5: Test Each Change

For each feature/fix, repeat this cycle:

```bash
# 1. Navigate
playwright-cli goto <dashboard-url>/structuredlogs  # or use snapshot + click
playwright-cli snapshot                               # get element refs

# 2. Interact
playwright-cli click <ref>
playwright-cli fill <ref> "filter text"
playwright-cli press "Enter"
playwright-cli select <ref> <value>
playwright-cli hover <ref>

# 3. Verify
playwright-cli snapshot                               # examine output for expected state
playwright-cli eval "document.querySelectorAll('.resource-row').length"

# 4. Capture evidence
playwright-cli screenshot --filename "$EVIDENCE_DIR/01-feature-name.png"
```

**Screenshot naming:** `NN-short-description.png` (zero-padded sequence number).

**Key rule:** Always run `snapshot` before interacting — refs are ephemeral and change on every page update.

#### 5b. Visual Review of Screenshots

After taking each screenshot, **view the image and inspect it for visual/stylistic issues**. Use the view tool or equivalent to examine the screenshot. Check for:

- **Spacing:** Uneven margins or padding between elements, cramped or overly spread-out content, misaligned columns
- **Icon sizing:** Icons that are too large, too small, or inconsistently sized relative to adjacent text or other icons
- **Text truncation:** Labels or values that are cut off, overlapping, or missing ellipsis where expected
- **Alignment:** Elements that should be vertically or horizontally aligned but aren't (e.g., badges next to tab labels, buttons in a row)
- **Color/contrast:** Elements that are hard to read, have unexpected colors, or don't match the surrounding UI style
- **Responsive issues:** Content that overflows its container, scrollbars that shouldn't appear, or layout breakage at the current viewport size
- **Empty states:** Missing placeholder text, blank areas where data should appear, or incorrect "no data" messages

If a visual issue is found, note it in the results report with:
- What the issue is (e.g., "badge overlaps tab text", "icon is 2x larger than adjacent icons")
- Which screenshot shows it
- Whether it's a regression from this branch's changes or pre-existing

### Step 6: Stop Recording and Cleanup

```bash
# Stop video BEFORE stopping the app
playwright-cli video-stop --filename "$EVIDENCE_DIR/dashboard-e2e-test.webm"

# Convert to MP4 if ffmpeg is available
ffmpeg -i "$EVIDENCE_DIR/dashboard-e2e-test.webm" -c:v libx264 -c:a aac "$EVIDENCE_DIR/dashboard-e2e-test.mp4" 2>/dev/null || true

# Close browser and stop app
playwright-cli close
aspire stop
```

Video saves as WebM. If `ffmpeg` is available, also produce MP4. Both formats are widely playable.

### Step 7: Report Results

Present a summary table:

| # | Change | Dashboard Area | Status | Screenshot |
|---|--------|---------------|--------|------------|
| 1 | Feature: Added X | Resources | ✅ Pass | `$EVIDENCE_DIR/01-feature-x.png` |
| 2 | Fix: Bug Y | Structured Logs | ✅ Pass | `$EVIDENCE_DIR/02-bug-y.png` |
| 3 | Feature: Z | Traces | ❌ Fail | `$EVIDENCE_DIR/03-feature-z.png` |

Include: paths to all screenshots, path to video, and for any failures: expected vs. observed behavior.

## Dashboard Pages

| Page | URL Path | Key Elements |
|------|----------|-------------|
| Resources | `/` | Resource list, state badges, endpoints, actions |
| Console Logs | `/consolelogs/resource/<name>` | Log stream, search, filters |
| Structured Logs | `/structuredlogs` | Log entries, severity filter, details panel |
| Traces | `/traces` | Trace list, span waterfall, timing |
| Metrics | `/metrics` | Charts, metric selector, time range |

## Example Scenarios

**New column on Resources page:**
```bash
playwright-cli snapshot
playwright-cli click <column-header-ref>   # test sorting
playwright-cli snapshot
playwright-cli screenshot --filename "$EVIDENCE_DIR/01-new-column.png"
```

**Filter/search feature:**
```bash
playwright-cli snapshot
playwright-cli fill <search-ref> "filter text"
playwright-cli press "Enter"
playwright-cli snapshot
playwright-cli screenshot --filename "$EVIDENCE_DIR/02-filter.png"
```

**Dialog or panel:**
```bash
playwright-cli click <trigger-ref>
playwright-cli snapshot
playwright-cli screenshot --filename "$EVIDENCE_DIR/03-dialog.png"
playwright-cli click <action-ref>
playwright-cli screenshot --filename "$EVIDENCE_DIR/04-dialog-result.png"
```

**Responsive layout:**
```bash
playwright-cli resize 1920 1080
playwright-cli screenshot --filename "$EVIDENCE_DIR/05-desktop.png"
playwright-cli resize 768 1024
playwright-cli screenshot --filename "$EVIDENCE_DIR/06-tablet.png"
playwright-cli resize 375 812
playwright-cli screenshot --filename "$EVIDENCE_DIR/07-mobile.png"
playwright-cli resize 1920 1080
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Playwright opens before app is healthy | `aspire wait` before `playwright-cli open` |
| Video not recording during tests | `video-start` immediately after `open` |
| Clicking stale element refs | Run `snapshot` before every interaction |
| Dashboard login fails | Use the full URL with token from `aspire start` output |
| Video lost on crash | `video-stop` before `aspire stop` |
| Partial test coverage | Enumerate ALL branch changes in Step 1 |
| No playground data for feature | Detect gaps in Step 2, modify playground, prompt user |
| Confusing with dashboard-testing skill | That skill = unit/bUnit; this skill = browser E2E |
