# VS Code New-Project Output Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the VS Code new-project wizard alive after a colliding output folder is selected, show the existing validation error, and let the user choose another destination.

**Architecture:** The CLI already computes and validates the final project output path, including the project-named subdirectory used by the VS Code flow. Change only the extension file-picker branch in `ExtensionInteractionService` so invalid selections display their validation message and reopen the picker; explicit CLI values and console prompts remain unchanged.

**Tech Stack:** .NET 10, C# 13, xUnit v3 with Microsoft.Testing.Platform, VS Code extension backchannel RPC, VS Code Insiders `serve-web`, Playwright CLI.

---

### Task 1: Add failing collision-retry coverage

**Consumed by:** Task 2 — the implementation must satisfy these service and command-level regressions

**Files:**
- Modify: `tests/Aspire.Cli.Tests/Interaction/ExtensionInteractionServiceTests.cs`
- Modify: `tests/Aspire.Cli.Tests/Commands/NewCommandTests.cs`

- [ ] **Step 1: Restore the local SDK**

Run:

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
./restore.sh
```

Expected: restore completes successfully and the repository-local .NET 10 SDK is available.

- [ ] **Step 2: Add focused extension file-picker tests**

Append these tests to `ExtensionInteractionServiceTests`:

```csharp
[Fact]
public async Task PromptForFilePathAsync_RetriesAfterInvalidSelection()
{
    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    var invalidPath = Path.Combine(workspace.WorkspaceRoot.FullName, "invalid");
    var validPath = Path.Combine(workspace.WorkspaceRoot.FullName, "valid");
    var selections = new Queue<string?>([invalidPath, validPath]);
    var displayedErrors = new List<string>();
    var promptCount = 0;
    const string validationMessage = "The selected directory is not available.";

    var backchannel = new TestExtensionBackchannel
    {
        HasCapabilityAsyncCallback = (capability, _) => Task.FromResult(capability == KnownCapabilities.FilePickers),
        PromptForFilePathAsyncCallback = (_, _, _) =>
        {
            promptCount++;
            return Task.FromResult(selections.Dequeue());
        },
        DisplayErrorAsyncCallback = error =>
        {
            displayedErrors.Add(error);
            return Task.CompletedTask;
        }
    };

    using var interactionService = CreateExtensionInteractionService(workspace, backchannel);

    var result = await interactionService.PromptForFilePathAsync(
        "Select a directory",
        validator: path => string.Equals(path, validPath, StringComparison.Ordinal)
            ? ValidationResult.Success()
            : ValidationResult.Error(validationMessage),
        directory: true);
    await interactionService.FlushAsync();

    Assert.Equal(validPath, result);
    Assert.Equal(2, promptCount);
    Assert.Equal([validationMessage], displayedErrors);
}

[Fact]
public async Task PromptForFilePathAsync_CancelAfterInvalidSelectionThrows()
{
    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    var invalidPath = Path.Combine(workspace.WorkspaceRoot.FullName, "invalid");
    var selections = new Queue<string?>([invalidPath, null]);
    var displayedErrors = new List<string>();
    var promptCount = 0;
    const string validationMessage = "The selected directory is not available.";

    var backchannel = new TestExtensionBackchannel
    {
        HasCapabilityAsyncCallback = (capability, _) => Task.FromResult(capability == KnownCapabilities.FilePickers),
        PromptForFilePathAsyncCallback = (_, _, _) =>
        {
            promptCount++;
            return Task.FromResult(selections.Dequeue());
        },
        DisplayErrorAsyncCallback = error =>
        {
            displayedErrors.Add(error);
            return Task.CompletedTask;
        }
    };

    using var interactionService = CreateExtensionInteractionService(workspace, backchannel);

    await Assert.ThrowsAsync<ExtensionOperationCanceledException>(() =>
        interactionService.PromptForFilePathAsync(
            "Select a directory",
            validator: _ => ValidationResult.Error(validationMessage),
            directory: true));
    await interactionService.FlushAsync();

    Assert.Equal(2, promptCount);
    Assert.Equal([validationMessage], displayedErrors);
}
```

Add this helper at the bottom of the test class:

```csharp
private ExtensionInteractionService CreateExtensionInteractionService(
    TemporaryWorkspace workspace,
    TestExtensionBackchannel backchannel)
{
    var console = AnsiConsole.Create(new AnsiConsoleSettings
    {
        Ansi = AnsiSupport.No,
        ColorSystem = ColorSystemSupport.NoColors,
        Out = new AnsiConsoleOutput(new StringWriter()),
        Enrichment = new ProfileEnrichment { UseDefaultEnrichers = false }
    });
    console.Profile.Width = int.MaxValue;

    var consoleInteractionService = new ConsoleInteractionService(
        new ConsoleEnvironment(console, console),
        workspace.CreateExecutionContext(),
        TestHelpers.CreateInteractiveHostEnvironment(),
        new EnvironmentProcessPathProvider(),
        NullLoggerFactory.Instance,
        new ConsoleLogBufferContext());

    return new ExtensionInteractionService(
        consoleInteractionService,
        backchannel,
        extensionPromptEnabled: true,
        logger: NullLogger<ExtensionInteractionService>.Instance);
}
```

- [ ] **Step 3: Add the new-project regression**

Add this test beside the existing extension-mode output-path tests in `NewCommandTests`:

```csharp
[Fact]
public async Task NewCommandInExtensionModeRetriesFolderPickerAfterProjectSubdirectoryCollision()
{
    const string projectName = "aspire-starter";

    using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
    var collidingParent = workspace.CreateDirectory("colliding-parent");
    var collidingProject = Directory.CreateDirectory(Path.Combine(collidingParent.FullName, projectName));
    File.WriteAllText(Path.Combine(collidingProject.FullName, "existing.txt"), "existing content");
    var validParent = workspace.CreateDirectory("valid-parent");
    var selectedParents = new Queue<string?>([collidingParent.FullName, validParent.FullName]);
    var displayedErrors = new List<string>();
    var promptCount = 0;
    string? capturedOutputPath = null;

    var backchannel = new TestExtensionBackchannel
    {
        HasCapabilityAsyncCallback = (capability, _) => Task.FromResult(
            capability is KnownCapabilities.Baseline or KnownCapabilities.FilePickers),
        PromptForFilePathAsyncCallback = (_, _, _) =>
        {
            promptCount++;
            return Task.FromResult(selectedParents.Dequeue());
        },
        DisplayErrorAsyncCallback = error =>
        {
            displayedErrors.Add(error);
            return Task.CompletedTask;
        }
    };

    var services = CreateServiceCollection(workspace, options =>
    {
        options.CliHostEnvironmentFactory = _ => TestHelpers.CreateInteractiveHostEnvironment();
        options.ExtensionBackchannelFactory = _ => backchannel;
        options.InteractionServiceFactory = sp =>
        {
            var consoleInteractionService = new ConsoleInteractionService(
                sp.GetRequiredService<ConsoleEnvironment>(),
                sp.GetRequiredService<CliExecutionContext>(),
                sp.GetRequiredService<ICliHostEnvironment>(),
                sp.GetRequiredService<IProcessPathProvider>(),
                NullLoggerFactory.Instance,
                sp.GetRequiredService<ConsoleLogBufferContext>());

            return new ExtensionInteractionService(
                consoleInteractionService,
                backchannel,
                extensionPromptEnabled: true,
                logger: NullLogger<ExtensionInteractionService>.Instance);
        };
        options.DotNetCliRunnerFactory = _ =>
        {
            var runner = CreateTestRunnerWithStandardPackages();
            runner.InstallTemplateAsyncCallback = (_, version, _, _, _, _, _) => (0, version);
            runner.NewProjectAsyncCallback = (_, _, outputPath, _, _) =>
            {
                capturedOutputPath = outputPath;
                return 0;
            };
            return runner;
        };
    });

    using var provider = services.BuildServiceProvider();
    var command = provider.GetRequiredService<RootCommand>();
    var result = command.Parse(
        $"new aspire-starter --name {projectName} --version 9.2.0 --use-redis-cache --test-framework None --suppress-agent-init");

    var exitCode = await result.InvokeAsync().DefaultTimeout();

    Assert.Equal(CliExitCodes.Success, exitCode);
    Assert.Equal(2, promptCount);
    Assert.Equal(Path.Combine(validParent.FullName, projectName), capturedOutputPath);
    var expectedError = string.Format(
        CultureInfo.CurrentCulture,
        NewCommandStrings.OutputDirectoryNotEmptyInteractive,
        collidingProject.FullName);
    Assert.Equal([expectedError], displayedErrors);
}
```

- [ ] **Step 4: Run the new tests and verify the current behavior fails**

Run:

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-launch-profile -- \
  --filter-method "*.PromptForFilePathAsync_RetriesAfterInvalidSelection" \
  --filter-method "*.PromptForFilePathAsync_CancelAfterInvalidSelectionThrows" \
  --filter-method "*.NewCommandInExtensionModeRetriesFolderPickerAfterProjectSubdirectoryCollision" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: FAIL. The current service throws `InvalidOperationException` after the first invalid selection, so the picker is called once and the command-level test does not reach the valid parent.

### Task 2: Retry invalid extension file-picker selections

**Consumed by:** Task 3 — the browser proof uses this behavior

**Files:**
- Modify: `src/Aspire.Cli/Interaction/ExtensionInteractionService.cs:194-250`
- Test: `tests/Aspire.Cli.Tests/Interaction/ExtensionInteractionServiceTests.cs`
- Test: `tests/Aspire.Cli.Tests/Commands/NewCommandTests.cs`

- [ ] **Step 1: Replace the one-shot file-picker path with a validation loop**

Replace the `if (hasFilePickersCapability)` body in `PromptForFilePathAsync` with:

```csharp
if (hasFilePickersCapability)
{
    while (true)
    {
        var tcs = new TaskCompletionSource<string?>();

        await _extensionTaskChannel.Writer.WriteAsync(async () =>
        {
            try
            {
                var result = await Backchannel.PromptForFilePathAsync(StringUtils.RemoveMarkup(promptText), binding?.DefaultValue, directory, _cancellationToken).ConfigureAwait(false);
                tcs.SetResult(result);
            }
            catch (Exception ex)
            {
                tcs.SetException(ex);
            }
        }, cancellationToken).ConfigureAwait(false);

        var picked = await tcs.Task.ConfigureAwait(false);

        if (picked is null)
        {
            throw new ExtensionOperationCanceledException(promptText);
        }

        if (validator is null)
        {
            return picked;
        }

        var validationResult = validator(picked);
        if (validationResult.Successful)
        {
            return picked;
        }

        // VS Code file pickers cannot show inline validation, so keep the wizard alive
        // by displaying the error before reopening the picker.
        DisplayError(validationResult.Message ?? "Invalid selection.");
    }
}
```

- [ ] **Step 2: Run the focused regression tests**

Run:

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-launch-profile -- \
  --filter-method "*.PromptForFilePathAsync_RetriesAfterInvalidSelection" \
  --filter-method "*.PromptForFilePathAsync_CancelAfterInvalidSelectionThrows" \
  --filter-method "*.NewCommandInExtensionModeRetriesFolderPickerAfterProjectSubdirectoryCollision" \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: all three tests PASS.

- [ ] **Step 3: Run the complete CLI test project**

Run:

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
dotnet test --project tests/Aspire.Cli.Tests/Aspire.Cli.Tests.csproj --no-launch-profile -- \
  --filter-not-trait "quarantined=true" \
  --filter-not-trait "outerloop=true"
```

Expected: PASS with no new warnings or failures.

- [ ] **Step 4: Check the diff**

Run:

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
git diff --check
git status --short
```

Expected: no whitespace errors; only the planned source, tests, design, and plan files are changed.

- [ ] **Step 5: Commit the implementation**

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
git add src/Aspire.Cli/Interaction/ExtensionInteractionService.cs \
  tests/Aspire.Cli.Tests/Interaction/ExtensionInteractionServiceTests.cs \
  tests/Aspire.Cli.Tests/Commands/NewCommandTests.cs \
  docs/superpowers/plans/2026-08-12-vscode-new-project-output-collision.md
git commit -m "Retry invalid VS Code project locations" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Prove the real VS Code flow with Playwright CLI

**Consumed by:** nothing

**Files:**
- Create proof artifacts outside the repository under `/Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/`
- Read local extension package from `extension/.test-artifacts/aspire-extension-issue19283.vsix`
- Read local CLI from `artifacts/bin/Aspire.Cli/Debug/net10.0/aspire`

- [ ] **Step 1: Build the CLI and package the extension**

Run:

```bash
cd /Volumes/DevDrive/source/aspire-issue19283
dotnet build src/Aspire.Cli/Aspire.Cli.csproj --no-restore
cd extension
mkdir -p .test-artifacts
corepack yarn run vsce package --pre-release \
  -o .test-artifacts/aspire-extension-issue19283.vsix
```

Expected: the CLI executable exists at `artifacts/bin/Aspire.Cli/Debug/net10.0/aspire`, and the VSIX exists at `extension/.test-artifacts/aspire-extension-issue19283.vsix`. If `yarn` reports missing locked dependencies, run `corepack yarn install --frozen-lockfile` once and rerun the VSIX command.

- [ ] **Step 2: Prepare an isolated browser-hosted VS Code workspace**

Create:

```text
/Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/
├── server-data/
├── workspace/
│   ├── .vscode/settings.json
│   ├── colliding-parent/aspire-starter/existing.txt
│   └── valid-parent/
└── vscode-serve-web.log
```

Write this exact workspace setting:

```json
{
  "aspire.aspireCliExecutablePath": "/Volumes/DevDrive/source/aspire-issue19283/artifacts/bin/Aspire.Cli/Debug/net10.0/aspire"
}
```

The existing file content can be any non-empty text, for example:

```text
existing project
```

- [ ] **Step 3: Start VS Code Insiders `serve-web`**

Run the server as a detached background process:

```bash
nohup '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code' serve-web \
  --host 127.0.0.1 \
  --port 8765 \
  --without-connection-token \
  --accept-server-license-terms \
  --disable-telemetry \
  --server-data-dir /Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/server-data \
  --default-folder /Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/workspace \
  > /Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/vscode-serve-web.log 2>&1 &
```

Verify:

```bash
curl --fail --silent --show-error http://127.0.0.1:8765/ >/dev/null
```

Expected: `curl` exits successfully.

- [ ] **Step 4: Install the local VSIX through Playwright CLI**

Run:

```bash
playwright-cli -s=issue19283 open http://127.0.0.1:8765/ --headed
playwright-cli -s=issue19283 tracing-start
playwright-cli -s=issue19283 press Control+Shift+P
playwright-cli -s=issue19283 type "Extensions: Install from VSIX..."
playwright-cli -s=issue19283 press Enter
playwright-cli -s=issue19283 upload /Volumes/DevDrive/source/aspire-issue19283/extension/.test-artifacts/aspire-extension-issue19283.vsix
```

Use `playwright-cli -s=issue19283 snapshot` after each command. If VS Code presents workspace-trust or reload confirmation, click the visible `Yes, I trust the authors` or `Reload Now` node returned by the snapshot, then wait for the workbench to reload.

Expected: the Extensions view shows the local `Aspire` extension as installed and enabled.

- [ ] **Step 5: Reproduce the colliding selection and verify the picker retries**

Drive the flow with Playwright CLI:

```bash
playwright-cli -s=issue19283 press Control+Shift+P
playwright-cli -s=issue19283 type "Aspire: New Aspire Project"
playwright-cli -s=issue19283 press Enter
```

After every prompt, run `playwright-cli -s=issue19283 snapshot`, then click the node with the exact visible label:

1. `Starter App (ASP.NET Core/Blazor)`.
2. Press `Enter` to accept the default `aspire-starter` project name.
3. `In a subdirectory named 'aspire-starter' in the selected folder`.
4. `colliding-parent`.

Expected after selecting `colliding-parent`:

- the existing message `The output directory '.../colliding-parent/aspire-starter' already exists and is not empty. Specify a different location.` is visible;
- the folder picker opens again instead of the command ending.

Select `valid-parent` in the reopened picker.

Expected: the wizard continues and creates the project under `workspace/valid-parent/aspire-starter`.

- [ ] **Step 6: Save persistent Playwright proof**

Run:

```bash
playwright-cli -s=issue19283 screenshot \
  --filename /Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/fixed-flow.png \
  --full-page
playwright-cli -s=issue19283 tracing-stop
playwright-cli -s=issue19283 close
```

Copy the trace path reported by `tracing-stop` into the proof directory if Playwright stored it elsewhere.

Verify:

```bash
test -f /Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/fixed-flow.png
test -f /Users/adamratzman/.copilot/session-state/75ac937a-798f-4895-b1b5-ee4948b12b56/files/issue19283-playwright/workspace/valid-parent/aspire-starter/aspire-starter.AppHost/aspire-starter.AppHost.csproj
git -C /Volumes/DevDrive/source/aspire-issue19283 status --short --branch
```

Expected: the screenshot and generated project exist, and the repository has no uncommitted implementation changes.
