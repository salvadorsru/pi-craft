# Changelog

## 1.1.0

- `/plan:skip`, `/plan:stop` and `/plan:retry`: mark the current step done and
  start the next one, leave the execution without losing the plan, or run the
  open step again after an aborted or failed run.
- `/plan on|off|status`, matching `/ask`. Without an argument it still toggles.
- Leaving execution no longer clears the step list; only a finished plan does,
  so `/plan:status` can still show it.
- CI: `bun run typecheck` and `bun test` on every push and pull request.

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
