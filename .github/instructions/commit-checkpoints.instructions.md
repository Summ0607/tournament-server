---
description: "Use when making changes in this workspace to monitor change diversity and recommend commit checkpoints."
applyTo: "**"
---

# Commit checkpoints

- During active work, check accumulated staged, unstaged, and untracked changes at task boundaries and before expanding scope.
- Judge diversity by independent purposes and behavior changes, not just file or line counts. Related implementation, tests, and documentation belong together.
- Proactively suggest a commit when a coherent, validated unit is ready, especially before starting unrelated work or when independent concerns are accumulating.
- Keep suggestions brief: explain the checkpoint, identify its scope, suggest a commit message, and state validation status or remaining checks.
- If changes are mixed, suggest logical commit groups. Distinguish existing user changes from changes made during the task and preserve unrelated work.
- Avoid repeating alerts for an unchanged checkpoint. Do not stage or commit without explicit authorization.
- This preference applies only to this workspace. Monitoring occurs during active work, not in the background between requests.
