---
name: ship
description: Commit, push, and create/update a PR in one shot. Use when the user says "commit", "push", "ship it", or any combination.
---

Stage all relevant changed files, commit with a descriptive message, push the current branch, then create or update a PR against main.

Steps:
1. Run `git status` and `git diff` to understand what changed
2. Stage relevant files (avoid secrets, .env, large binaries)
3. Commit with a conventional commit message and Co-Authored-By trailer
4. Push the branch with `-u origin`
5. Check if a PR already exists for this branch (`gh pr list --head <branch>`)
   - If yes: report its URL (the push already updated it)
   - If no: create one with `gh pr create --base main`

Do all steps without pausing for confirmation between them. If any step fails, stop and report.
