# Aspire VS Code Extension Changelog

## v1.0.8

### Features
- Increased the VS Code test download timeout to improve reliability.
- Introduced a new utility function for determining statement start lines in C# and JavaScript/TypeScript AppHost parsers.

### Bug Fixes
- Fixed an issue where the Aspire start command failed in the VS Code integrated terminal.
- Resolved a problem with CodeLens positioning inside preceding code blocks.
- Corrected missing awaits in TypeScript AppHost examples.

### Improvements
- Cleared the terminal input buffer before sending Aspire commands to enhance command execution.
- Updated dependencies, including a bump to PostCSS for better compatibility.
