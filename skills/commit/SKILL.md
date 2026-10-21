---
name: commit
description: Split pending changes into semantic commits, one story per commit, with an imperative English subject and a body only when it explains why. Use when the user asks to commit, to write a commit message, or to review what is staged.
---

# Commits

One story per commit, in the repository's own style (`git log --oneline -15`).
If nothing is pending, say so and stop.

## Split first

Group by concept, not by directory or file type: a feature and its test are one
commit; a dependency bump and the refactor it enables are two. A subject that
needs "and" is two commits. Order when it matters: tooling and deps, refactors,
features and fixes, docs.

## Message

`type(scope): subject` — scope is the area touched (`api`, `ui`, `db`, a
component name), omitted when the change is spread across areas.

| Type | For |
|---|---|
| `feat` | new capability |
| `fix` | wrong behaviour |
| `refactor` | same behaviour, different shape |
| `style` | formatting, names, whitespace |
| `chore` | deps, config, tooling |
| `docs` | documentation only |
| `remove` | deleting code or files |
| `hotfix` | urgent fix in production |
| `release` | release preparation |

Subject: English, imperative (`add`, not `added`), lowercase after the colon,
72 characters at most, no trailing period. Body only for the *why*, wrapped at
72. Footer for `Relates-to: TICKET` or `BREAKING CHANGE: what breaks`.

Never `wip`, "update", "changes", past tense, or another language.

## Stage each group

One index per commit, so the message always matches what is staged:

```bash
git restore --staged .
git add path/to/group
git status --short
git commit -m "$(cat <<'EOF'
type(scope): subject

Why this change is needed.
EOF
)"
```

`git add -p` only when one file holds two unrelated stories.

## Check

Type and scope match the change. Subject imperative and under 72. Body says why,
not what. The staged set matches the message. The tree is clean for that work
afterwards.
