# Multi-agent, fast Slate — requirements

Created: 2026-07-22
Status: brainstorm complete → ready for /ce-plan

## Problem

Every Slate surface interaction (refresh, compose, explain, re-author) delivers a prompt to ONE session — the run's main agent — so N surface changes run **serially through a single-threaded agent**. Interacting with the Slate is slow, and all upkeep bottlenecks through the main agent. Goal: get surface authoring **off the main agent's critical path** so the Slate feels fast (per the repo's video-game UI philosophy — snappy, juicy, no blocking).

## Who benefits

The operator driving multiple runs and living in the Slate. Success is a **felt** one: refreshing/authoring surfaces does not block the main agent or the user, and multi-surface actions happen in parallel.

## Core insight (already resolved this session)

The file-in authoring model already decouples **who writes** a surface file from the projection — the watcher doesn't care who wrote `.tinstar/slate/*.json`. So multi-agent authoring is mostly swapping *"prompt the main agent"* for *"dispatch a dedicated author,"* render path unchanged. Fresh parallel authors are **cheaper per surface** than the main agent (which drags its whole accumulated session context every turn); fresh authors travel light and re-derive from source.

## Key decisions

1. **The `refresh` recipe is the surface's authoring contract.** It graduates from optional convenience to the *self-contained spec a context-free agent reads to (re)build the surface from source.* Quality bar: a recipe names its **source** (a PR, files, a query), its **derivation** (describe blind, compare A/B), and its **output** (rewrite these columns). "Regenerate this surface" is not a valid recipe — it assumes context the author won't have.

2. **The "vacuum test" classifies every surface.** *Can the recipe, in a vacuum (no session context), produce a sensible refresh?*
   - **Passes** (names an external source) → **source-derived**.
   - **Fails** (the only "source" is the main agent's session) → **session-derived**.
   A well-formed *living* surface is defined as one whose recipe passes the vacuum test.

3. **Source-derived refresh is deterministic and code-driven — the main agent is never involved.** Because the recipe is self-contained, the code can spawn a fresh background author (recipe as its task) directly, off the main agent's path. Desired felt behavior: **"you never even know it refreshed."** The author writes the file → watcher projects → `amendedAt` advances → the existing bounded refresh spinner clears itself.

4. **Session-derived refresh stays with the main agent** (the named exception). The recipe can't point at an external source, so the main agent authors it (or packs a compact context digest for an author). Minority of surfaces; includes "Explain the session."

5. **Store-live surfaces need no author.** Points the user *typed* are persisted; the client already renders them live — "refreshing" them is a no-op. So "open points" split three ways (store-live / session-derived / n/a), and the slow, valuable surfaces (PR blind-eval, dataflow) are precisely the ones that pass the vacuum test cleanly. The speedup lands on the pain.

6. **Authors are right-sized, separate models** — mechanical authoring on a fast/cheap model; analysis-heavy authors (PR blind-eval) on an appropriately capable model. Never the main agent's fat context.

7. **The main agent becomes editor/orchestrator, not the author of every panel** — it owns narrative coherence across the run's Slate; authors own individual surfaces (maps to the tinstar-wrangler model).

8. **Recipes are captured at create-time.** The composer/catalog treats *"how does this stay fresh?"* as a first-class part of creating a surface, so surfaces are born handoff-able. Catalog templates already carry recipes; custom/freeform surfaces must fill one in — or be explicitly marked static (no recipe = not a living surface).

9. **The Slate skill must teach this expectation** — recipe quality (self-contained; source/derivation/output), the vacuum test, and the dispatch behavior — so every run's agent inherits it, not just the current session.

## Success criteria (feel, not just correctness)

- Refreshing a source-derived surface consumes **no main-agent turn** and does not block the user.
- "Explain the session" and "Refresh all" populate surfaces **in parallel**, not serially.
- Main-agent involvement in surface upkeep trends toward **zero** for source-derived surfaces.
- **No regression** to the shipped Slate: projection, SSE, per-surface refresh spinner, freshness/`amendedAt` signal, and the zero-change short-circuit all stay coherent when authors write async.

## Scope — in

- Refresh recipe as authoring contract + the source/derivation/output quality bar.
- Vacuum-test classification (source-derived vs session-derived).
- Deterministic, code-spawned **background author** for source-derived refresh (fork B on this path) — main agent uninvolved.
- Right-sized author models (fast/cheap for mechanical; capable for analysis).
- Create-time recipe capture in the composer/catalog.
- Slate skill update teaching the expectation.
- Parallel fan-out for Explain / Refresh-all.

## Scope — out / later

- **Fork C** — per-surface self-tending daemons that watch their source and re-author on change, unprompted.
- A formal **live-query surface type** that refreshes with *no agent at all* (pure data/query) — desirable, can follow.
- Reworking the recipe schema to separate a "dispatch flag" from the "authoring instruction" — v1 can carry dispatch as a recipe convention; clean separation later.
- A migration pass to backfill recipes onto existing recipe-less surfaces.

## Concurrency / coherence constraints

- Parallel authors writing **different** files in one `.tinstar/slate/` dir is safe.
- The zero-change short-circuit + `amendedAt` freshness signal + bounded spinner must stay coherent when authors write async.
- The "serialize the fan-out" hack was a **single-session artifact**; separate authors dissolve it — verify it can be removed for the dispatched path rather than carried forward.

## Outstanding questions (for planning)

- **A-interim vs B-direct:** ship "main agent fire-and-forget dispatches a subagent" (fork A — behavioral, near-zero build) as an interim, or go straight to deterministic code-spawned authors (fork B)? User leans B ("deterministic in code") as the target; A may be a cheap first step.
- **What spawns the author** for the code-driven path — a Tinstar hand, a headless one-shot agent, or a plain script for pure-query recipes? (HOW — ce-plan.)
- **Session-derived digest:** how does a session-derived surface get its context — main agent injects a digest at dispatch, vs the author reads the session transcript?
- **Recipe-less backlog:** existing surfaces without recipes — fall back to main-agent authoring, mark static, or backfill?
