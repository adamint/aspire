# Aspire dashboard a11y #17466 evidence

Issue: https://github.com/microsoft/aspire/issues/17466
PR: https://github.com/microsoft/aspire/pull/17774

## Annotated evidence

These files visibly show the relevant state on-screen while the interaction happens:

- `annotated-before.webm`: before fix, `aria-expanded` is absent when closed and an empty string when open.
- `annotated-after.webm`: after fix, `aria-expanded="false"` when closed and `aria-expanded="true"` when open; the accessibility snapshot reports `[expanded]`.
- `17466-before-fix.json` / `17466-after-fix.json`: structured Playwright state capture.

## Supporting screenshots

- `17466-before-fix-closed.png`
- `17466-before-fix-open.png`
- `17466-after-fix-closed.png`
- `17466-after-fix-open.png`

Dashboard login tokens were redacted from text artifacts.
