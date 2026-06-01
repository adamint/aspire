# Aspire dashboard a11y #17656 evidence

Issue: https://github.com/microsoft/aspire/issues/17656
PR: https://github.com/microsoft/aspire/pull/17776

## Annotated evidence

These files visibly show the relevant active-element state on-screen while the interaction happens:

- `annotated-before.webm`: before fix, selecting `Collapse child resources` leaves focus on `BODY` (`isBody: true`).
- `annotated-after.webm`: after fix, selecting `Collapse child resources` leaves focus on the `FLUENT-BUTTON` with `ariaLabel: View options` (`isBody: false`).
- `17656-before-fix.json` / `17656-after-fix.json`: structured Playwright focus capture.

## Supporting screenshots

- `17656-before-fix-menu-open.png`
- `17656-before-fix-after-select.png`
- `17656-after-fix-menu-open.png`
- `17656-after-fix-after-select.png`

Dashboard login tokens were redacted from text artifacts.
