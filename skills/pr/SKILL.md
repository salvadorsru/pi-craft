---
name: pr
description: Draft or open a pull request with a context-first body — why, what changed, how to test, what to watch — built from the real branch diff. Use when the user asks to create, draft, or improve a PR description, PR body, or pull request.
---

# Pull requests

Write for a reviewer with zero context. One purpose per PR. Every claim comes
from the branch, not from memory.

## Gather

```bash
git log origin/main..HEAD --oneline
git diff --stat origin/main...HEAD
```

## Body

```markdown
## Summary

One paragraph: what this PR does.

## Context

Why it exists now: the problem, its impact, and what made it worth doing today.

## Changes

- ...
- ...

## How to test

1. Step a reviewer can run.
2. What they should see.

## Screenshots

Before / after, when the UI changed. Drop the section otherwise.

## Checklist

- [ ] Tested locally
- [ ] No new type or lint errors
- [ ] Docs updated when behaviour changed

## Deployment notes

Migrations, env vars, breaking changes. Drop the section when there are none.
```

Never a body without *why*, steps a reviewer cannot reproduce, or a PR that
mixes a refactor with a feature.

## Open it

If `gh` exists, `gh pr create --title "<subject>" --body-file -` with that body
on stdin. Otherwise print the body and stop.
