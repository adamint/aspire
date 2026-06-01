# Aspire dashboard a11y #17466 evidence

Issue: https://github.com/microsoft/aspire/issues/17466
PR: https://github.com/microsoft/aspire/pull/17774

## Before
- `view-options-before.png`
- `view-options-open-before.png`
- `before.webm`

## After
- `view-options-closed-after.png`
- `view-options-open-after.png`
- `after.webm`
- `view-options-after.json`

Result: after the fix, the View options button has `aria-expanded="false"` when closed and `aria-expanded="true"` when open. The Playwright accessibility snapshot reports `button "View options" [expanded]` when the menu is open. Dashboard login tokens were redacted from text artifacts.
