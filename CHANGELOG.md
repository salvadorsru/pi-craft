# Changelog

## Unreleased


- Plan execution runs in subagents: each batch of up to three consecutive steps
  (`/plan:batch <n>`) runs in its own session, in plan order, so a batch never
  splits a step from the one it depends on. The main session keeps the plan and
  the checklist while the work happens in a clean context.
- The parent no longer ticks steps from its own messages or from `[DONE:n]` in
  them, and resuming reads the completed steps from the persisted entry instead
  of scanning the branch.
- A subagent has no UI, so `ask_question` is not available while executing. `Esc`
  no longer aborts a step either: `/plan:stop` aborts the subagent in flight.

## 1.2.0

- The two skills are now `commit` and `pr`, invoked with `/skill:commit` and
  `/skill:pr`. The old `/skill:new-commit` and `/skill:new-pr` names no longer
  exist, so any muscle memory or script pointing at them must be updated.
- The package ships those two skills and the `pack` prompt template: semantic
  commits split by story, pull requests built from the branch diff, and
  stage-everything-then-pack. They replace the personal copies, so remove
  `~/.pi/agent/skills/create-commit`, `~/.pi/agent/skills/create-pr` and
  `~/.pi/agent/prompts/pack.md` to avoid running two of each.
- `/plan:skip`, `/plan:stop` and `/plan:retry`: mark the current step done and
  start the next one, leave the execution without losing the plan, or run the
  open step again after an aborted or failed run.
- `/plan on|off|status`, matching `/ask`. Without an argument it still toggles.
- Leaving execution no longer clears the step list; only a finished plan does,
  so `/plan:status` can still show it.
- The checklist widget keeps a fixed height. It shows the five steps around
  the current one with `… N above` / `… N below`, so a long plan no longer
  pushes the editor off the screen and the step in progress stays visible.
- Undo no longer turns plan mode back on. The mode is recorded in the session
  branch, so a rewind restored the last entry it had just left: the toggle
  worked, and the next undo silently undid it.
- A plan written with a bold step number (`**1.** …`), a title on the header
  line (`Plan: move the tests`) or `---` between steps is read in full. Those
  shapes silently produced an empty list, so no steps appeared and the
  execute dialog never opened.
- `package.test.ts` checks the `pi` manifest against the files on disk, so a
  skill or prompt cannot be declared but left out of the tarball.
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
