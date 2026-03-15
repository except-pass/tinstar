---
name: teardown
description: Commit worktree work, kill associated tinstar agents, merge back into repo, and remove the worktree
---

Tear down a git worktree: commit any outstanding work, kill any tinstar agents running inside it, merge back into the parent repo, and clean up. Ask the user about anything that would block removal.

## Steps

### 1. Identify the worktree

```bash
git worktree list
pwd
git rev-parse --abbrev-ref HEAD
```

Note the current worktree path and branch name.

### 2. Commit outstanding work

Check for uncommitted changes:

```bash
git status
git diff --stat
```

If there are staged or unstaged changes, commit them now using the `/tinstar-commit` skill (or a plain `git commit` if the task context isn't needed). If the user has changes they don't want to commit, ask:

> "You have uncommitted changes. Should I: (a) commit them, (b) stash them, or (c) discard them before removing the worktree?"

Wait for the user's answer before proceeding.

### 3. Kill tinstar agents on this worktree

Find and stop any tinstar sessions associated with this worktree before merging. Use the tinstar API:

```bash
TINSTAR_URL=${TINSTAR_URL:-http://localhost:5273}

# List all sessions and find ones whose workspace path matches this worktree
curl -s "$TINSTAR_URL/api/sessions" | python3 -c "
import json, sys
data = json.load(sys.stdin)
worktree_path = '$(pwd)'
for s in data.get('sessions', []):
    ws = s.get('workspace', {}) or {}
    if ws.get('path') == worktree_path or ws.get('worktreePath') == worktree_path:
        print(s['name'])
"
```

For each matching session, delete it:

```bash
curl -s -X DELETE "$TINSTAR_URL/api/sessions/<session-name>"
```

If sessions fail to delete (e.g. still running), ask the user:

> "Session `<name>` is still running in this worktree. Should I force-stop it, or do you want to stop it manually first?"

### 4. Identify the merge target

Ask the user (or infer from context):

> "Which branch should I merge **`<worktree-branch>`** into? (default: `master` / `main`)"

Check the merge target exists and the worktree branch is up to date with it:

```bash
git log <target>..<worktree-branch> --oneline        # commits to merge
git log <worktree-branch>..<target> --oneline        # commits worktree is behind
```

If the worktree branch is behind the target, warn the user and ask how to proceed.

### 5. Merge back into the parent repo

Switch to the parent repo (main worktree), then merge:

```bash
# From the MAIN worktree (not the one being torn down):
git checkout <target-branch>
git merge --no-ff <worktree-branch> -m "Merge <worktree-branch> into <target-branch>"
```

If there are merge conflicts, stop and report them clearly. Do not proceed to removal until the merge is clean.

### 6. Remove the worktree

```bash
git worktree remove <worktree-path>
```

Common blockers — if `git worktree remove` fails, diagnose and ask:

- **Untracked/modified files remain**: "The worktree still has untracked files at `<path>`. Should I force-remove it (`git worktree remove --force`) or do you want to review them first?"
- **Worktree is the current directory**: Must be run from outside the worktree. Switch to main repo first.
- **Lock file present**: Run `git worktree unlock <path>` first, then retry.

### 7. Optionally delete the branch

Ask: "Should I also delete the branch `<worktree-branch>` now that it's merged? (`git branch -d <worktree-branch>`)"

Only delete if the user confirms.

### 8. Confirm

Report success:

```
✓ Committed all changes on <worktree-branch>
✓ Stopped <N> tinstar agent(s)
✓ Merged <worktree-branch> → <target-branch>
✓ Worktree removed: <worktree-path>
[✓ Branch <worktree-branch> deleted]
```

## Notes

- Never force-remove the worktree or force-stop agents without explicit user confirmation.
- If the user is currently inside the worktree directory, remind them to `cd` to the main repo before the remove step.
- If anything is ambiguous (which branch to merge into, whether to delete the branch, conflicting changes), ask — don't guess.
