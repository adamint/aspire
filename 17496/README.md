# Aspire dashboard a11y #17496 evidence

Issue: https://github.com/microsoft/aspire/issues/17496
PR: https://github.com/microsoft/aspire/pull/17783

## Annotated evidence

These files visibly show console log resource-prefix contrast evidence:

- `annotated-before.webm`: before fix, the lowest observed prefix contrast is below 4.5:1.
- `annotated-after.webm`: after fix, the lowest observed prefix contrast is at or above 4.5:1.
- `17496-before-fix.json` / `17496-after-fix.json`: structured Playwright contrast capture.

Dashboard login tokens were redacted from text artifacts.
