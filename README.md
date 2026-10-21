# @salvadorsru/pi-modes

One owner for editor modes in [pi](https://pi.dev).

Pi extensions are isolated: each one keeps its own flags and can call
`pi.setActiveTools()` whenever it wants. When two extensions both implement a
mode (say, a read-only "ask" mode and a read-only "plan" mode), switching to
one leaves the other active, both `tool_call` guards keep firing, and the last
extension to call `setActiveTools()` wins. The tool set also gets a snapshot
that can contain the other mode's restricted tools.

`@salvadorsru/pi-modes` gives those extensions one shared state machine and one
owner for the tool set. Use it when your extension implements a mode that must
coexist with other modes.

## Install

```bash
npm install @salvadorsru/pi-modes
```

or install a local checkout:

```bash
pi install ./pi-modes
```

`@salvadorsru/pi-modes` is a library, not an extension: it declares no commands
on its own. Install it as a dependency of the extension that uses it.

## Use

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModes } from "@salvadorsru/pi-modes";

export default function askExtension(pi: ExtensionAPI): void {
  const modes = getModes(pi);

  modes.define({
    id: "ask",
    label: "Ask mode",
    readOnly: true,
    tools: ["read", "grep", "find", "ls", "bash"],
    flag: "ask",
    marker: "[ASK MODE ACTIVE]",
    contextType: "ask-mode-context",
    prompt: "[ASK MODE ACTIVE]\nAnswer questions; do not edit.",
  });

  pi.registerCommand("ask", {
    description: "Toggle ask mode",
    handler: async (_args, ctx) => {
      if (modes.is("ask")) modes.leave(ctx);
      else modes.enter("ask", ctx);
    },
  });
}
```

Entering `ask` from any other mode leaves that mode first. The extension that
declares `plan` does not need to know that `ask` exists.

## API

### `getModes(pi?)`

Returns the process-wide `ModeRegistry` and binds it to `pi`. The first call
installs the runtime handlers (`session_start`, `before_agent_start`, `context`,
`tool_call`); later calls only bind and let the caller declare more modes.

The runtime is stored on a `Symbol.for` slot of `globalThis`. Pi loads packages
in separate module roots, so two packages cannot rely on sharing a dependency
instance; the global slot guarantees that duplicated copies still talk to the
same registry.

### `registry.define(spec)`

Declares a mode. Call it during extension load, before `session_start`.

| Field | Meaning |
|---|---|
| `id` | Unique id (`ask`, `plan`, `execute`, ...). |
| `label` | Human name used in guard reasons. |
| `tools` | Active tools while the mode is current. Omit for the baseline. |
| `readOnly` | Block mutating tools and unsafe bash. |
| `flag` | CLI flag that starts Pi in this mode. Register the flag yourself. |
| `marker` | Text inside the injected instructions, e.g. `[ASK MODE ACTIVE]`. |
| `contextType` | `customType` of the hidden instructions. Defaults to `pi-mode-<id>`. |
| `prompt` | Instructions injected before each user run. |
| `keepNewestContext` | Keep only the newest instruction message in context. |
| `onEnter` / `onLeave` | Mode-specific setup and cleanup. |

`onLeave(ctx, to)` knows the destination: a plan mode can preserve its steps
when moving to `execute` and reset them when leaving to any other mode.

### Transitions

```ts
modes.enter(id, ctx);   // returns true when the state changed
modes.leave(ctx);       // back to normal, returns true when it changed
modes.toggle(id, ctx);  // "entered" | "left" | "unchanged"
```

Only one mode is current at a time; `normal` is the absence of a mode.

### Queries

```ts
modes.current();   // ModeId | undefined
modes.is("plan");  // boolean
modes.spec();      // current ModeSpec
modes.readOnly();  // current mode blocks mutations
modes.modeIds();
```

### `registry.onChange(listener)`

Called after every transition, including a session restore:

```ts
const unsubscribe = modes.onChange((to, from, ctx) => {
  ctx.ui.setStatus("my-mode", to === "ask" ? "🔒 ask" : undefined);
});
```

The runtime also emits `pi-modes:change` on `pi.events` with
`{ mode, previous }`.

### `registry.registerLegacy(customType, resolve)`

Maps an old session entry to the mode it represented, so a version bump does
not lose the mode on resume:

```ts
modes.registerLegacy("ask-mode", (data) =>
  (data as { enabled?: boolean })?.enabled ? "ask" : undefined,
);
```

The last legacy entry wins. A shared `pi-modes` entry always takes precedence.

## What the runtime owns

- **The tool set.** `define({ tools })` describes the set per mode; everything
  else uses the baseline captured before any mode was applied. Leaving a mode
  restores that baseline, not a per-mode snapshot.
- **The read-only guard.** `edit`, `write` and `powershell` are blocked while a
  read-only mode is current, bash is checked command by command, and third-party
  tools that declare `destructiveHint` or `openWorldHint` without
  `readOnlyHint` are blocked too.
- **The bash policy.** `checkReadOnlyCommand()` is exported for tests and for
  extensions that need the same rules outside a `tool_call`.
- **The mode prompt.** Injected before user runs, filtered out of the context
  once the mode is off, and pruned to the newest copy when
  `keepNewestContext` is set.
- **Persistence.** Every transition appends `{ mode }` under the `pi-modes`
  custom type and restores it from the active branch on `session_start`.

## Guarantees

- Two extensions that call `getModes()` share one registry, one current mode
  and one tool-set owner.
- Entering a mode calls `onLeave` on the previous mode before applying tools.
- The baseline is captured before the first mode is applied, so leaving a mode
  never restores another mode's restricted set.
- A guard or event consumer that throws never breaks a transition.

## Publishing

This package is a library, not an extension. Publish it **before** releasing an
extension that depends on it, so `pi install git:...` and
`pi install npm:...` can resolve the dependency:

```bash
npm publish --access public
```

`pi-ask` 0.2+ and `pi-plan` 0.5+ declare `@salvadorsru/pi-modes` in
`dependencies`.

## Development

```bash
bun test
```

The package is plain TypeScript with no build step: pi loads it through jiti,
like any other pi package.

## License

MIT
