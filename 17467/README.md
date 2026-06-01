# Aspire dashboard a11y #17467 evidence

Issue: https://github.com/microsoft/aspire/issues/17467
PR: https://github.com/microsoft/aspire/pull/17784

## Annotated evidence

These files visibly show Manage logs/telemetry selection button accessible-name evidence:

- `annotated-before.webm`: before fix, nested selection icon buttons have missing/non-action names.
- `annotated-after.webm`: after fix, selection buttons expose action-oriented names such as `Deselect all` and `Deselect Console logs for apigateway`.
- `17467-before-fix.json` / `17467-after-fix.json`: structured Playwright capture.

Dashboard login tokens were redacted from text artifacts.
