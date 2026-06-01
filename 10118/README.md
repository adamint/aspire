# Issue 10118 characterization evidence

Current investigation for [microsoft/aspire#10118](https://github.com/microsoft/aspire/issues/10118).

No Aspire code change was made because the reported Sort/Resize menu keyboard path is already reachable in the current dashboard. The captured characterization shows:

- Resources grid header menu buttons are present for keyboard interaction.
- Sort can be activated from the header menu and updates `aria-sort`.
- Resize menu actions can be activated from the keyboard and change the grid column widths.
- Raw drag resize handles are pointer-only FluentDataGrid implementation details, while keyboard resizing is exposed through the header menu resize actions.

See `characterization-summary.txt`, `playwright-characterization.log`, and `before/resources-dom.json` for details.
