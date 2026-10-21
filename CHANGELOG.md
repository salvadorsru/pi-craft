# Changelog

## 0.1.0

- First release: `ModeRegistry`, `getModes()`, exclusive mode transitions,
  single-owner active tool set, read-only `tool_call` guard, shared bash
  policy, mode prompt injection and filtering, `pi-modes` persistence, legacy
  entry migration, and the `pi-modes:change` event.
- Consumers vendor `src/` under `vendor/pi-modes/` with `bun run vendor`; there
  is no npm publish and no install step. The `globalThis` registry keeps the
  copies in sync.
