# Aspire dashboard a11y #17470 evidence

Issue: https://github.com/microsoft/aspire/issues/17470
PR: https://github.com/microsoft/aspire/pull/17779

## Annotated evidence

These files visibly show the mobile/hamburger navigation selected-state evidence:

- `annotated-before.webm`: before fix, Structured has no `aria-current` and no selected marker.
- `annotated-after.webm`: after fix, Structured has `aria-current="page"`, active styling, and a visible `✓` marker.
- `17470-before-fix.json` / `17470-after-fix.json`: structured Playwright capture.

Dashboard login tokens were redacted from text artifacts.
