# pi-craft

Three ways to work on a codebase, one mode at a time:

- **Ask** — read-only questions. The model reads the project to answer, but
  cannot change it.
- **Plan** — read-only exploration that turns the analysis into a numbered
  plan.
- **Execute** — runs the plan one step at a time with live progress.

`/ask` and `/plan` are mutually exclusive: entering one leaves the other. The
tool set, the read-only guard, the instructions and persistence are owned by a
single mode runtime, so two modes can never fight over the active tools.

## Install

From GitHub:

```bash
pi install git:github.com/salvadorsru/pi-craft
```

From a local checkout:

```bash
pi install ./pi-craft
```

No build step and no dependencies: pi loads the TypeScript extension directly.

> Replaces `pi-ask` and `pi-plan`. Remove them before installing `pi-craft`;
> the last mode is migrated from their session entries.

## Usage

| Input | What it does |
|---|---|
| `/ask` | Toggle ask mode |
| `/ask on` / `/ask off` / `/ask status` | Control ask mode explicitly |
| `/ask <question>` | Turn ask mode on and ask in one step |
| `Ctrl+Alt+A` | Toggle ask mode |
| `--ask` | Start in ask mode |
| `/plan` | Toggle plan mode |
| `/plan:status` | Show the current plan and progress |
| `Ctrl+Alt+P` | Toggle plan mode |
| `--plan` | Start in plan mode |

### Ask mode

Read the code before answering, cite `file:line`, and propose changes instead of
applying them. The footer shows `ask` in the success color.

### Plan mode

Ask the agent to analyze the code and write a plan under a `Plan:` header.
Then choose **Execute the plan**, **Stay in plan mode**, or **Refine the plan**.
Execution runs one step per agent run: the checklist advances while the plan is
running, and the final card repeats the completed list with a summary.

While planning, the agent can ask structured questions with the `ask_question`
tool: a selector with suggested answers and an **Other — write my own answer**
entry. Asking does not tick the current step.

## What the modes restrict

- **Tools**: `edit`, `write` and `powershell` are removed while ask or plan is
  active. Plan keeps `read`, `bash`, `grep`, `find`, `ls` and `ask_question`;
  ask keeps the same set without `ask_question`.
- **Bash**: only read-only commands. The check requires every pipe segment to be
  a known read-only command (`cat`, `head`, `grep`, `rg`, `find`, `ls`, `tree`,
  `jq`, `git status/log/diff/show`, `cargo tree/metadata`, …) and rejects
  redirection, chaining, substitution, flags that write (`find -delete`,
  `sort -o`, `git -c`, …), dangerous assignments, interpreters and package
  managers.
- **Third-party tools**: tools that declare `destructiveHint` or
  `openWorldHint` without `readOnlyHint` are blocked too.

The guard is a second line of defense: even if a tool is re-activated
mid-session, a mutating call is rejected while a read-only mode is current.

## Icons

The UI uses single-width ASCII, not emoji, so the footer and the checklist keep
their columns in any terminal and font:

```
ask                     plan 2/3
Plan  ###---  1/3 · 33%
[x] 1. Parse the config
[>] 2. Add the new option
[ ] 3. Update the docs
```

`[x]` done, `[>]` current, `[ ]` pending. The progress bar is `#`/`-`.

## State and migration

The current mode is persisted as a `pi-craft` session entry and restored from
the active branch on resume. Older entries are migrated:

- `pi-plan` (plan mode and execution)
- `ask-mode` (`pi-ask`)
- `pi-modes` (the short-lived shared runtime)

## Architecture

```
extensions/craft/index.ts   wires the modes together
src/modes/                  mode state, tool ownership, guard, shell policy
src/ask/                    ask mode: commands, badge, instructions
src/plan/                   plan mode: parser, progress, renderers, questions
```

- One `ModeRegistry` per extension session owns the current mode.
- Only the registry calls `pi.setActiveTools()`; entering a mode applies its
  set, leaving restores the baseline captured before any mode was applied.
- The registry injects the mode instructions and filters them out once the mode
  is off.
- `onEnter`/`onLeave` let plan keep its steps when moving to execution and
  reset them when leaving to another mode.

## Development

```bash
bun test
```

The suite covers the mode runtime, the shell policy, plan extraction, progress
rendering, clarifying questions, the full extension flow with a mocked pi, and
the ask/plan handoff.

## Español

Tres modos, uno a la vez:

- **Ask** (`/ask`, `Ctrl+Alt+A`, `--ask`): preguntas de solo lectura.
- **Plan** (`/plan`, `Ctrl+Alt+P`, `--plan`): exploración de solo lectura y plan
  numerado; `/plan:status` muestra el progreso.
- **Execute**: lo elige el agente al confirmar el plan, y avanza un paso por
  corrida.

`/ask` y `/plan` son mutuamente excluyentes: entrar a uno apaga el otro. La
iconografía es ASCII de ancho fijo para que no se desalinee en ningún terminal.

```bash
pi install git:github.com/salvadorsru/pi-craft
```

## License

MIT
