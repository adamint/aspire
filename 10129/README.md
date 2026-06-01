# Issue 10129 investigation evidence

No current repro was found for [microsoft/aspire#10129](https://github.com/microsoft/aspire/issues/10129).

The `current/` folder contains JSON focus trails and screenshots from these attempts:

- Desktop left navigation: `Tab` to **Resources**, `Enter`, then `Shift+Tab`.
- Resources page tabs: `Tab` to the **Resources** view tab, `Enter`, then `Shift+Tab`.
- Resources page tabs after dismissing the update banner.
- Narrow/mobile navigation: open the menu, activate **Resources**, then `Shift+Tab`.
- Resource filter popover probe.

In each Resources-tab/nav sequence, `Shift+Tab` moved to the previous interactive element in the observed tab order. No code change or draft PR was created because the reported unexpected backward focus navigation could not be reproduced.
