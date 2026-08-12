# VS Code new-project output collision design

## Problem

The VS Code `Aspire: New Aspire Project` command launches `aspire new` through the extension backchannel. In extension mode, the CLI asks for a project name, asks whether to create a project-named subdirectory, and then opens the VS Code folder picker.

The CLI already validates the resolved output path after the folder is selected. However, `ExtensionInteractionService.PromptForFilePathAsync` treats a failed validation as a terminal command error. If the selected parent already contains a non-empty project-named directory, the wizard ends instead of letting the user choose another location.

## Approaches considered

1. **Retry validated extension file pickers.** When a selected file or folder fails the supplied validator, display the validation message and reopen the picker. This is the recommended approach because it fixes the failure before scaffolding, preserves the existing wizard order, and applies the same behavior to every validated extension file picker.
2. **Reorder the new-project wizard.** Select the destination before collecting the project name. This matches C# Dev Kit, but it requires restructuring both .NET and CLI template flows and complicates the existing "create a project-named subdirectory" choice.
3. **Silently suffix the project or directory name.** Generate `aspire-starter-2` after detecting a collision. This avoids another prompt but can make the project name and directory name diverge or unexpectedly change a name the user already accepted.

## Design

Change `ExtensionInteractionService.PromptForFilePathAsync` so the file-picker capability path loops until one of these outcomes:

- the user cancels, preserving `ExtensionOperationCanceledException`;
- the selected path passes validation and is returned;
- the selected path fails validation, in which case the existing validation message is displayed and the picker opens again.

Explicit command-line values and the console interaction service keep their current behavior. No public API or localization change is required because the existing output-directory validation message is reused.

## Tests

Add focused `ExtensionInteractionServiceTests` coverage proving that:

- an invalid first selection displays the validator message;
- the picker is called again;
- a valid second selection is returned;
- cancellation still exits instead of retrying.

Add a `NewCommandTests` regression that reproduces the issue shape: extension mode, project-named subdirectory selected, first parent containing a non-empty matching child, then a second valid parent. Assert that scaffolding uses the second resolved target and does not run against the colliding directory.

## End-to-end proof

Build the local CLI and package the local VS Code extension. Run VS Code Insiders with `serve-web`, an isolated server data directory, and a workspace containing an existing non-empty `aspire-starter` directory. Configure the extension to use the locally built CLI.

Use Playwright CLI to:

1. open the browser-hosted VS Code instance;
2. run `Aspire: New Aspire Project`;
3. accept the starter template and default project name;
4. choose project-named subdirectory creation;
5. select the colliding parent and verify the validation message appears;
6. verify the folder picker reopens;
7. select a valid parent and verify project creation completes there.

Capture a Playwright trace and screenshot as persistent proof.
