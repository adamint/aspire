# Aspire VS Code Extension Changelog

## v1.0.8

### Features
- Added support for environment variables in the Aspire debug launch configuration.
- Introduced additional arguments for Aspire CLI commands in the debug configuration.

### Bug Fixes
- Fixed an issue causing the Aspire start command to fail in the VS Code integrated terminal.
- Resolved a problem with CodeLens positioning inside preceding code blocks.
- Corrected missing awaits in TypeScript AppHost examples.

### Improvements
- Increased the VS Code test download timeout for better reliability.
- Updated vulnerable npm dependencies to enhance security.
- Cleared the terminal input buffer before sending Aspire commands to improve command execution.
