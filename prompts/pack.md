---
description: Stage all changes and pack them into semantic commits grouped by concept
argument-hint: "[extra instructions]"
---
Pack every pending change into clean commits.

1. Stage everything: `git add -A`, then `git status --porcelain`. If nothing is
   pending, say so and stop.
2. Read the `new-commit` skill and follow it.
3. Group by concept, never by file type or directory: each commit tells one
   story and can be reverted on its own.
4. Prefer several focused commits. Before each, unstage all and stage only that
   group's paths, so the index matches the message.
5. One imperative subject per commit; a body only when it explains why.

$@
