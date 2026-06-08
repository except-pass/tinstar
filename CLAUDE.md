# CLAUDE.md — Tinstar

## Repository

- **Main branch:** `main` — use this for PRs, not `master`

## UI Philosophy

The UI must be snappy and responsive. It should feel like playing a video game — fun, juicy, and blazing fast. Every interaction should have immediate visual feedback. No loading spinners where optimistic updates will do. Animations should be short and purposeful (never blocking). If something feels sluggish, that's a bug.

## Project Structure

- **Frontend**: React + Tailwind, served by Vite
- **Backend**: Vite plugin server (`src/server/`) — event bus, document store, SSE, session management
- **Sessions**: `src/server/sessions/` — tmux backend, config at `~/.config/tinstar/`
- **E2E tests**: Playwright (`e2e/`), run with `TINSTAR_FAST_SIM=1 npx playwright test`

## Key Commands

- `npm run dev` — start dev server (clean UI, no mock data)
- `TINSTAR_FAST_SIM=1 npm run dev` — start with mock data (for testing)
- Type check + unit tests: see [docs/testing.md](docs/testing.md). The headline trap: `npx tsc --noEmit` against the root tsconfig is a no-op; use `-p tsconfig.app.json`. Vitest needs `--exclude='e2e/**'`.
- `npx playwright test` — E2E tests (needs `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:<port>`)

## Multi-Agent / NATS

Agents communicate via NATS pub/sub. Subject scheme: `tinstar.<space>.<init>.<epic>.<task>.<agent>`

- Each agent auto-subscribes to task broadcast (`*`) and ancestor wildcards (`>`)
- Use `reply` MCP tool to publish messages
- See **[docs/nats-agent-channels.md](docs/nats-agent-channels.md)** for full details

## Agent skills (`tinstar`, `tinstar-hand`, `tinstar-tmux`, `tinstar-wrangler`)

The skills that teach agents how to spawn, steer, and coordinate Tinstar hands live under `agent-skills/` in this repo (skills only — no separate slash commands). They're symlinked into any harness dir with `skills/` + `commands/` subdirectories (Claude Code's `~/.claude`, project-local `.claude`, `.agents`, etc.):

```bash
tinstar install-skills                     # default: ~/.claude
tinstar install-skills --dest ./.claude    # project-local
tinstar install-skills --force             # replace existing (moves to .bak)
tinstar install-skills --copy              # copy instead of symlink
```

Edits to files under `agent-skills/` go live immediately for any machine that installed via symlink — edit in-repo, commit, done.

## Conventions

Cross-cutting rules live in **[docs/conventions.md](docs/conventions.md)** — go there when you're about to touch anything load-bearing (server config paths, NATS subjects, docstore mutators, frontend HTTP, localStorage, plugin boundaries, etc.). It's short and grouped by area.

The four highest-leverage rules, restated here because they're rarely-violated-but-expensive-when-they-are:

- Server-side config paths go through `getConfigRoot()` — not `homedir()`. Honors `TINSTAR_CONFIG_HOME` so a second backend doesn't stomp the primary.
- Frontend HTTP goes through `apiFetch` / `apiUrl` from `src/apiClient.ts` — bare `fetch` 404s in Tauri.
- UI prefs go through `src/lib/uiPrefs.ts` — only `tinstar-layouts-v3` (widget layouts cache) is a documented localStorage exception.
- Simulator only auto-starts when `TINSTAR_FAST_SIM=1` is set.

Session state changes emit to the event bus as `managed_session.*` events (see [docs/conventions.md](docs/conventions.md) for the "adding a BusEvent" recipe).
