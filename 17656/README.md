# Aspire dashboard a11y #17656 evidence

Issue: https://github.com/microsoft/aspire/issues/17656
PR: https://github.com/microsoft/aspire/pull/17776

## Before
- `menu-open.png`
- `after-select-before.png`
- `before.webm`

## After
- `view-options-menu-open-after.png`
- `view-options-after-select-after.png`
- `after.webm`
- `view-options-focus-after.json`

Result: after the fix, selecting `Collapse child resources` leaves focus on the `FLUENT-BUTTON` with `ariaLabel: View options` and `isBody: false`. Dashboard login tokens were redacted from text artifacts.
