# Aspire dashboard a11y #17498 evidence

Issue: https://github.com/microsoft/aspire/issues/17498
PR: https://github.com/microsoft/aspire/pull/17787

## Annotated evidence

These files visibly show Text Visualizer Select format evidence:

- `annotated-before.webm`: before fix, Select format is exposed as a button/menu-style control.
- `annotated-after.webm`: after fix, Select format is a `fluent-select` with an accessible label and options.
- `17498-before-fix.json` / `17498-after-fix.json`: structured Playwright capture.

Dashboard login tokens were redacted from text artifacts.
