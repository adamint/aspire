# Aspire dashboard a11y #17650 evidence

Issue: https://github.com/microsoft/aspire/issues/17650
PR: https://github.com/microsoft/aspire/pull/17778

## Annotated evidence

These files visibly show the Help dialog shortcut semantics on-screen:

- `annotated-before.webm`: before fix, `Reset panel sizes shift+r` is flat row text with no semantic list ancestor.
- `annotated-after.webm`: after fix, `Reset panel sizes` is a `dt` term and `shift+r` is its `dd` definition in a labelled `dl`.
- `17650-before-fix.json` / `17650-after-fix.json`: structured Playwright accessibility capture.

Dashboard login tokens were redacted from text artifacts.
