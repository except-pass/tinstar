# CLAUDE.md — Tinstar

## Repository

- **Main branch:** `main` — use this for PRs, not `master`

## UI Philosophy

The UI must be snappy and responsive. It should feel like playing a video game — fun, juicy, and blazing fast. Every interaction should have immediate visual feedback. No loading spinners where optimistic updates will do. Animations should be short and purposeful (never blocking). If something feels sluggish, that's a bug.

## Project Structure

- **Frontend**: React + Tailwind, served by Vite
- **Backend**: Vite plugin server (`src/server/`) — event bus, document store, SSE, session management
- **Sessions**: `src/server/sessions/` — Docker/tmux backends, config at `~/.config/tinstar/`
- **E2E tests**: Playwright (`e2e/`), run with `TINSTAR_FAST_SIM=1 npx playwright test`

## Key Commands

- `npm run dev` — start dev server (clean UI, no mock data)
- `TINSTAR_FAST_SIM=1 npm run dev` — start with mock data (for testing)
- `npx tsc --noEmit` — type check
- `npx playwright test` — E2E tests (needs `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:<port>`)

## Task Activity & Commit Tracking

Tinstar's **Task Activity** panel tracks commits by extracting task tags from commit messages using the regex `#([A-Za-z0-9_-]+)`. A commit tagged `#my-task-name` will appear under that task in the panel.

The `tinstar-commit` skill (`~/.claude/commands/tinstar-commit.md`) handles this correctly: it looks up the current task name from the tinstar API, derives a tag, commits with it, and immediately notifies the server via `POST /api/git/commit-hook`.

**Installation requirement**: `tinstar-commit` must be installed as a procedure on your root initiative so it is available in every session. After installing tinstar on a new machine:

1. Copy `tinstar-commit.md` to `~/.claude/commands/tinstar-commit.md`
2. Open Tinstar, navigate to your root initiative, open the skill picker, and star `tinstar-commit`

Without step 2, commits from agent sessions will not appear in Task Activity until the next server restart triggers reconciliation.

## Conventions

- All server-side config lives under `~/.config/tinstar/` — no other locations
- Frontend uses only localStorage for widget layouts (`tinstar-layouts-v3` key)
- Session state changes emit to the event bus as `managed_session.*` events
- Simulator only auto-starts when `TINSTAR_FAST_SIM=1` is set
