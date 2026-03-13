# CLAUDE.md — Tinstar

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

## Conventions

- All server-side config lives under `~/.config/tinstar/` — no other locations
- Frontend uses only localStorage for widget layouts (`tinstar-layouts-v3` key)
- Session state changes emit to the event bus as `managed_session.*` events
- Simulator only auto-starts when `TINSTAR_FAST_SIM=1` is set
