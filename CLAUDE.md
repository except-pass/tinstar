# CLAUDE.md — Tinstar

## Repository

- **Main branch:** `main` — the primary development branch. Branch off it, ship one feature per PR, squash-merge back. Full flow in **[docs/contributing.md](docs/contributing.md)**.

## UI Philosophy

The UI must be snappy and responsive. It should feel like playing a video game — fun, juicy, and blazing fast. Every interaction should have immediate visual feedback. No loading spinners where optimistic updates will do. Animations should be short and purposeful (never blocking). If something feels sluggish, that's a bug.

## Project Structure

- **Frontend**: React + Tailwind, served by Vite
- **Backend**: standalone HTTP server at `src/server/standalone.ts`; cockpit fleet read, message and terminal routes at `src/server/fleet/cockpit.ts`
- **Workers**: First Mate owns worker creation, dispatch, supervision and lifecycle; Tin Star only reads its fleet snapshot and opens terminal views that link, never own, worker windows (`src/server/firstmate/views.ts`). Config lives under `getConfigRoot()` (default `~/.config/tinstar/`)
- **Documented solutions**: `docs/solutions/` — solutions to past problems (bugs, gotchas, workflow practices), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in a documented area.
- **Shared vocabulary**: `CONCEPTS.md` (repo root) — domain terms (entities, named processes, status concepts) with project-specific meaning. Relevant when orienting to the codebase or discussing domain concepts.

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

Cutting a release (tag `main` → npm) is documented step-by-step in **[docs/releasing.md](docs/releasing.md)** — releases are now cut directly from `main` (the dev branch), not from an accumulating release branch. The trap worth restating: **`@tinstar/plugin-api` is a separate npm publish, gated on `git diff vPREV vN.N.0 -- packages/plugin-api/src/index.ts`** — publish it only when that shipped surface actually changed, and run the diff rather than deciding from memory.
