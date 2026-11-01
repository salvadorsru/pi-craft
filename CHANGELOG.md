# Changelog

## 1.4.0

- In execute mode the parent agent can do step work itself: the `[DONE:n]`
  markers in its own reply close those steps as the turn ends, so work done
  outside the batch runner is not stuck open. Invalid and duplicated markers
  cannot corrupt the count.
- A batch closes only the steps the subagent actually finished, instead of
  marking the whole block done, so unfinished work is not silently skipped.
- A failed model call (a 429, a cut-off token limit, an empty run) pauses the
  plan with the step, the reason and `/plan:retry` as the way back, instead of
  freezing the checklist with nothing in the transcript.
- A subagent that hands the same open batch back twice stops with an error
  instead of looping forever.
- Leaving execute mode for another mode aborts the subagent in flight, so a
  batch can no longer keep working in the background with full tool access,
  unreachable by `/plan:stop`.
- `/plan off` really leaves execute mode instead of claiming it was already off,
  and switching to plan mode while a plan runs asks first.
- A plan header with extra words (`Plan: move the tests`, `## Plan for the
  tests`) is read in full, and a refinement that ends in a question keeps the
  current plan instead of clearing it for good.
- Only the live batch instruction stays in context: older "work on steps 1-3"
  texts no longer mislead a later turn.
- `ask_question` with several questions puts the finishing choice first, so
  Enter cannot repeat the same question, and dismissing a later round keeps the
  answers already picked.
- `turn_end` no longer fails with "could not resolve the persisted assistant
  entry ID" for a turn started by `/ask <question>` outside plan mode.
- The "what next?" dialog lists **Stay in plan mode** first, so a plain Enter
  never starts the execution by accident, and a failure while starting the
  execution reaches the user instead of vanishing into the event handler.

## 1.3.0

- A re-stated plan keeps the ticks of the steps it repeats: replacing the list no
  longer resets every step to open when the same work is written again with a note or
  a rephrase.
- `/plan:done [n]` closes a step whose work the main agent did outside the batch
  runner; without it such a plan stayed at `0/n` for good. `finishPlan` also works
  outside execute mode, so that plan gets its final card.

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
