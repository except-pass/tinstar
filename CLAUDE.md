# CLAUDE.md — Tinstar

## Repository

- **Main branch:** `main` — the primary development branch. Branch off it, ship one feature per PR, squash-merge back. Full flow in **[docs/contributing.md](docs/contributing.md)**.

## UI Philosophy

The UI must be snappy and responsive. It should feel like playing a video game — fun, juicy, and blazing fast. Every interaction should have immediate visual feedback. No loading spinners where optimistic updates will do. Animations should be short and purposeful (never blocking). If something feels sluggish, that's a bug.

## Project Structure

- **Frontend**: React + Tailwind, served by Vite
- **Backend**: standalone HTTP server at `src/server/standalone.ts`; cockpit fleet read, message and terminal routes at `src/server/fleet/cockpit.ts`
- **Workers**: First Mate owns worker creation, dispatch, supervision and lifecycle; Tin Star only reads its fleet snapshot and opens terminal views that link, never own, worker windows (`src/server/firstmate/views.ts`). Config lives under `getConfigRoot()` (default `~/.config/tinstar/`)
- **Second mate display**: a persistent second mate is shown working or idle from the live snapshot, never done because a child outcome said done (`src/server/fleet/workerState.ts`).
- **Documented solutions**: `docs/solutions/` — solutions to past problems (bugs, gotchas, workflow practices), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in a documented area.
- **Shared vocabulary**: `CONCEPTS.md` (repo root) — current cockpit terms and pointers to their code.

## Key Commands

- `npm run dev` — start dev server
- Type check + unit tests: see [docs/testing.md](docs/testing.md). The headline trap: `npx tsc --noEmit` against the root tsconfig is a no-op; use `-p tsconfig.app.json`. Vitest needs `--exclude='e2e/**'`.
- Cockpit regression runs with `npx playwright test --config playwright.cockpit.config.ts`; it starts its own private tmux server and First Mate test home.

## Conventions

Cross-cutting rules live in **[docs/conventions.md](docs/conventions.md)** — go there when you're about to touch anything load-bearing (server config paths, response envelopes, frontend HTTP, layering, etc.). It's short and grouped by area.

The two highest-leverage rules, restated here because they're rarely-violated-but-expensive-when-they-are:

- Server-side config paths go through `getConfigRoot()` — not `homedir()`. Honors `TINSTAR_CONFIG_HOME` so a second backend doesn't stomp the primary.
- Frontend HTTP goes through `apiFetch` / `apiUrl` from `src/apiClient.ts` — bare `fetch` 404s in Tauri.

## Releasing

Cutting a release (tag `main` → npm) is documented step-by-step in **[docs/releasing.md](docs/releasing.md)**. The V5 plugin host is gone; `@tinstar/plugin-api` remains a separate published package with no host in 6.0.0. Its npm deprecation requires a separate explicit publish decision.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
