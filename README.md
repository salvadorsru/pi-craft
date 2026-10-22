# pi-craft

<p align="center">
  <img src="assets/banner.png" alt="pi-craft — three ways in, one mode at a time.">
</p>

> Three ways in, one mode at a time.

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="pi package" src="https://img.shields.io/badge/pi-package-brightgreen.svg">
  <img alt="No build step" src="https://img.shields.io/badge/build-none-3178c6.svg">
</p>

`pi-craft` gives [pi](https://github.com/earendil-works/pi) three modes — **ask**,
**plan** and **execute** — and only one of them is ever active. A single mode
runtime owns the tool set, the read-only guard, the instructions and the
persistence, so two modes can never fight over the active tools. It also ships
the commit and pull-request workflows below, so installing it is all it takes.

## Install

```bash
pi install git:github.com/salvadorsru/pi-craft
```

From a local checkout: `pi install ./pi-craft`. There is no build step and no
dependency: pi loads the TypeScript extension directly.

Coming from `pi-ask` or `pi-plan`? Remove them first: the last mode you were in
is migrated from their session entries.

## Usage

| Input | What it does |
|---|---|
| `/ask` | Toggle ask mode |
| `/ask <question>` | Turn ask mode on and ask in one step |
| `/ask on` · `/ask off` · `/ask status` | Control ask mode explicitly |
| `Ctrl+Alt+A` · `--ask` | Shortcut and startup flag |
| `/plan` | Toggle plan mode |
| `/plan on` · `/plan off` · `/plan status` | Control plan mode explicitly |
| `/plan:status` | Show the current plan and its progress |
| `/plan:batch <n>` | Steps one subagent runs at once (default 3) |
| `/plan:skip` · `/plan:done` · `/plan:stop` · `/plan:retry` | Drop the step in flight, mark a step done by hand, stop the run, retry the open step |
| `Ctrl+Alt+P` · `--plan` | Shortcut and startup flag |

## Skills and prompts

The package also ships three git workflows. They are not part of the mode
runtime: pi keeps a skill out of context until the task matches it (or until you
force it with `/skill:name`), and a prompt template is just another `/` command.

**`commit`** — `/skill:commit`

Takes the pending changes and groups them by story, not by file or directory.
Each group becomes one commit: `type(scope): subject`, English and imperative,
72 characters at most, a body only when it explains *why*, and a
`BREAKING CHANGE:` or `Relates-to:` footer when they apply. It reads
`git log --oneline -15` first to copy the repository's own style, and restages
the index between commits so a message never covers someone else's files.

**`pr`** — `/skill:pr`

Reads the branch (`git log origin/main..HEAD`, `git diff --stat`) and writes the
pull request body: summary, why now, changes, how to test, screenshots,
checklist and deployment notes. With `gh` installed it opens the PR; without it,
it prints the body for you to paste.

**`pack`** — `/pack`

`git add -A`, then hands the result to `commit`, so a mixed working tree
becomes several commits in one command. It takes extra instructions as an
argument.

They live in `skills/` and `prompts/`, and there is nothing to install
separately: `bun test` fails if the `pi` manifest and those folders drift apart.
If you used these as personal skills before, delete the old `create-commit`,
`create-pr` and `/pack` copies — pi keeps the first one it finds and warns about
the duplicate.

## Modes

### Ask

Read the code, answer, cite `file:line`, and propose a change instead of applying
it. The footer shows `ask` while the mode is on.

### Plan

Explore, then write a numbered list under a `Plan:` header. pi turns it into a
checklist and asks what to do: **Execute the plan**, **Stay in plan mode** or
**Refine the plan**.

When the plan needs a decision, the agent calls `ask_question` instead of ending
its turn with a question in prose: a selector with short options and a free-text
answer. Asking works in plan mode; the subagents that execute the plan have no
UI (see [Execute](#execute)).

```
Plan  ######------------  1/3 · 33%
[x] 1. Extract the numbered steps from the reply
[>] 2. Advance the cursor between runs
[ ] 3. Show the final card with a summary
```

### Execute

Each batch of steps runs in its own subagent session, in plan order: the plan
order is the dependency order, so a step never starts before the one it needs. A
batch is up to three steps (`/plan:batch <n>` changes it) and the checklist is
repainted when the batch ends.

A step that needs no tool call declares `[DONE:n]`. A batch that reported no
marker and used no tool leaves its steps open, so `/plan:retry` can pick them
up. When the last step ends, the card repeats the whole list with the duration
and, expanded, the files the subagents changed.

Two things change because the work leaves the main session:

- The subagent has no UI, so `ask_question` is not available while executing. A
  step that needs a decision stops and says what it needs; answer it in plan
  mode, or refine the plan.
- `Esc` no longer aborts the step: there is no parent turn to interrupt. Use
  `/plan:stop`, which aborts the subagent in flight and leaves the list intact
  so `/plan:status` can still show it.

`/plan:skip` drops the step in flight and restarts the batch without it.
`/plan:done [n]` marks a step done without running it — the door for work the main
agent did itself, which is otherwise left open (and the checklist stuck at `0/n`).

## What the modes block

- **Tools.** `edit`, `write` and `powershell` are removed while ask or plan is
  active; the full set comes back when you leave.
- **Bash.** Every pipe segment must be a read-only command (`cat`, `grep`, `rg`,
  `find`, `ls`, `tree`, `jq`, `git status/log/diff/show`, `cargo tree`, …).
  Redirection, chaining, substitution, `find -delete`, `sort -o`, `git -c`,
  env assignments that repoint `PATH` or `LD_PRELOAD`, interpreters and package
  managers are rejected.
- **Third-party tools.** A tool that declares `destructiveHint` or
  `openWorldHint` without `readOnlyHint` is blocked too.

The guard is a second line of defence: a mutating call is rejected while a
read-only mode is current, even if the tool was re-enabled mid-session.

## Architecture

```
extensions/craft/index.ts   wires the modes and the legacy entries
src/modes/                  mode state, tool ownership, guard, bash allowlist
src/ask/                    ask mode: commands, badge, instructions
src/plan/                   plan mode: parser, progress, cards, questions
src/plan/agents.ts          the subagent that runs one batch of steps
skills/                     commit and pr, one directory each
prompts/                    pack, which stages everything and calls commit
```

- One `ModeRegistry` per session; only it calls `setActiveTools()`, and leaving a
  mode restores the set captured before any mode was applied.
- The mode lives in a `pi-craft` session entry and is restored from the active
  branch on resume; entries from `pi-ask`, `pi-plan` and the short-lived
  `pi-modes` runtime are migrated.

## Development

```bash
bun test
bun run typecheck
```

The suite covers the mode runtime, the bash allowlist, plan extraction, progress
rendering, the question tool, the full flow against a mocked pi, and that every
skill and prompt named in the `pi` manifest exists on disk. CI runs both commands
on every push and pull request.

## License

MIT
