# Changelog

## 1.0.0

- First release of `pi-craft`, replacing the separate `pi-ask` and `pi-plan`
  packages with one extension that owns all three modes.
- Ask, plan and execute are mutually exclusive modes of a single runtime:
  entering one leaves the other, and only one of them owns the active tools.
- One tool-set owner. Leaving a mode restores the set from before any mode was
  active, instead of a per-mode snapshot that could contain another mode's
  restricted tools.
- One read-only policy (mutating tools, bash allowlist, third-party tool
  annotations) shared by ask and plan.
- The mode is persisted as a `pi-craft` session entry; sessions from `pi-ask`,
  `pi-plan` and the intermediate `pi-modes` runtime are migrated.
- The UI uses single-width ASCII instead of emoji: `ask`/`plan` badges, an
  `#`/`-` progress bar, and `[x]`/`[>]`/`[ ]` step markers.
- Plan mode keeps the structured `ask_question` tool, one run per step, live
  progress, the final card, and branch-aware resume.
