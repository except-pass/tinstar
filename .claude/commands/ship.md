---
name: ship
description: Commit, push, and create/update a PR in one shot. Use when the user says "commit", "push", "ship it", or any combination.
---

Stage all relevant changed files, commit with a descriptive message, push the current branch, then create or update a PR against main.

Steps:
1. Run `git status` and `git diff` to understand what changed
2. Stage relevant files (avoid secrets, .env, large binaries)
3. Commit with a conventional commit message and Co-Authored-By trailer
4. **Preflight — run CI's gates locally BEFORE pushing; if any fail, STOP and report (do not push):**
   - `npm run typecheck` (this is CI's exact gate — `tsc` against tsconfig.app/e2e/test) — must be zero errors.
   - `npm run lint` — must be clean.
   - **Committed-vs-local trap (this is how CI goes red while local is green):** the checks above run against your *dirty working tree*, but CI checks out only *committed* files. So a committed file that imports a module you never committed (an untracked/uncommitted dependency) passes locally and fails in CI with `TS2307: Cannot find module`. Guard against it:
     - `git ls-files --others --exclude-standard -- 'src/**/*.ts' 'src/**/*.tsx'` — if this lists anything, committed code may resolve to it locally but break in CI. Either commit it (if it belongs) or verify the committed tree typechecks (e.g. `git stash push -- <unrelated dirty files>` → `npm run typecheck` → `git stash pop`).
     - If your push includes a NEW import, confirm the imported file is `git add`ed (tracked), not just present locally.
5. Push the branch with `-u origin`
6. Check if a PR already exists for this branch (`gh pr list --head <branch>`)
   - If yes: report its URL (the push already updated it)
   - If no: create one with `gh pr create --base main`

Do all steps without pausing for confirmation between them. If the preflight (step 4) fails, STOP — do not push — and report the errors; for any other step failure, stop and report.
