# Aspire dashboard a11y #10299 evidence

Issue: https://github.com/microsoft/aspire/issues/10299
PR: https://github.com/microsoft/aspire/pull/17780

The live Copilot flow was not reachable in the local dashboard environment, so the evidence is from the verified component test path.

## Verified states

- Initial state: Helpful `aria-pressed="false"`, Unhelpful `aria-pressed="false"`
- After Helpful click: Helpful `aria-pressed="true"`, Unhelpful `aria-pressed="false"`
- After Helpful click again: Helpful `aria-pressed="false"`, Unhelpful `aria-pressed="false"`
- After Unhelpful click: Helpful `aria-pressed="false"`, Unhelpful `aria-pressed="true"`

Targeted test: `FeedbackButtonsExposePressedState` passed.
