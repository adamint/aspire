# Aspire dashboard a11y #17468 evidence

Issue: https://github.com/microsoft/aspire/issues/17468
PR: https://github.com/microsoft/aspire/pull/17786

## Annotated evidence

These files visibly show Manage logs/telemetry selection control role/state evidence:

- `annotated-before.webm`: before fix, there are zero checkbox-role selection controls.
- `annotated-after.webm`: after fix, selection controls are focusable `span role="checkbox"` elements with `aria-checked` state.
- `17468-before-fix.json` / `17468-after-fix.json`: structured Playwright capture.

Dashboard login tokens were redacted from text artifacts.
