# Aspire VS Code Extension Changelog

## v1.0.8

### Features
- Introduced a new utility function to improve statement start line detection for C# and JavaScript/TypeScript AppHost parsers.

### Bug Fixes
- Resolved an issue causing the Aspire start command to fail in the VS Code integrated terminal.
- Fixed the positioning of CodeLens when placed inside preceding code blocks.
- Corrected missing awaits in TypeScript AppHost examples.

### Improvements
- Increased the VS Code test download timeout to enhance reliability.
- Cleared the terminal input buffer before sending Aspire commands to prevent command conflicts.
- Updated dependencies, including a bump to PostCSS and Next.js versions for better performance.
