# Issue 17469 evidence

Evidence for [microsoft/aspire#17469](https://github.com/microsoft/aspire/issues/17469).

The current live dashboard no longer reproduced the visible reset on the View options menu in this environment, so this folder includes:

- `evidence.txt`: root-cause characterization and validation commands.
- `root-cause-before/`: deterministic browser reproduction of the Fluent popup focus-wrap failure mode.
- `root-cause-after/`: deterministic browser evidence of Aspire popup navigation closing the popup and moving focus predictably.
- `before/` and `after/`: live dashboard focus-sequence captures for the View options popup in the tested environment.

The root-cause before video shows Tab from an open popup moving focus to the first page control. The root-cause after video shows Tab closing the popup and moving focus to the next logical page control.
