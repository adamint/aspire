# FluentUI Blazor popover focus proof

Captured from the Aspire Dashboard Resources page using Microsoft.FluentUI.AspNetCore.Components 4.14.1.

## Overflow MoreButtonTemplate + FluentPopover

- `01-overflow-more-focused.png`: focus starts on the FluentOverflow `MoreButtonTemplate` button (`+20`).
- `02-overflow-first-link-before-shift-tab.png`: focus on the first link inside the popover.
- `03-overflow-after-shift-tab.png`: after pressing `Shift+Tab`, focus remains on the first popover link instead of returning to the `MoreButtonTemplate` trigger/anchor.
- `04-overflow-last-link-before-tab.png`: focus on the last link inside the popover.
- `05-overflow-after-tab.png`: after pressing `Tab`, focus jumps to the page logo instead of returning to the trigger or the next focusable element after the overflow trigger.

## FluentDataGrid column width popup

- `07-column-resize-open-autofocus.png`: column width popup opens and autofocuses the shrink button.
- `09-column-resize-after-shift-tab.png`: after pressing `Shift+Tab`, focus moves to the Name header button, but the column width popup remains open.
- `11-column-resize-after-tab.png`: after pressing `Tab` from the last resize control, focus moves to the State header button, but the column width popup remains open.

`focus-log.jsonl` contains serialized `document.activeElement` snapshots for each transition.
