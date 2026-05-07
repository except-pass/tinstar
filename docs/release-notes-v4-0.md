# Tinstar v4.0 — feature reference

Single-source reference for every feature shipped in v4.0. Organized by subsystem. Points at the relevant code and existing timeless docs.

> **Why this doc exists:** v4.0 landed the desktop app, multi-agent observability, and a wave of NATS-driven panels. The fine-grained design specs that drove each feature (`docs/superpowers/plans/`, `docs/superpowers/specs/`) have been retired now that the code is the authoritative source of behavior. This file captures the design decisions worth keeping, as a pointer map to the living code. Same pattern as `release-notes-v3-7.md`.

---

## Desktop app (Tauri)

See **`docs/desktop-app.md`** for install + setup. The shipped architecture lives there; what follows is the *why*.

**Same binary, two modes.** Mode (local-managed vs remote) is a runtime config setting, not a build variant — the same Tauri binary ships on every platform. Frontend stops assuming same-origin with the backend; everything routes through `src/apiClient.ts` which reads `window.__TINSTAR_API_BASE__`. The Tauri shell injects that base via `Window::eval()` *before* the bundle's `<script type="module">` runs (`index.html` carries an empty placeholder `<script>` so the inline assignment is a no-op when the value is already set).

**CORS allowlist, not wildcard.** Backend now reads `TINSTAR_CORS_ORIGINS` (comma-separated) and short-circuits unknown origins. Tauri's webview origin is `tauri://localhost` (macOS/Linux) or `https://tauri.localhost` (Windows); both must be in the allowlist when `manageBackend=true`.

**Config isolation for spawned local backends.** `TINSTAR_CONFIG_HOME` lets a Tauri-spawned local backend live at a different config dir than the user's `:5273` instance — without it the second backend's startup kills the first one's ttyd processes. (See `feedback_config_isolation` memory.)

**Unsigned binaries.** macOS/Windows users see Gatekeeper / SmartScreen warnings on first launch; the `desktop-app.md` table documents the bypass per platform. Signing is intentional follow-up work.

**Dev-version suffix.** Dev branches bump to `<next>-dev.0` (e.g. `4.1.0-dev.0`) rather than plain `<next>`, to keep accidental `npm publish` from putting a half-baked build on `latest`.

Code: `src-tauri/`, `src/apiClient.ts`, `bin/tinstar.js --no-setup`.

---

## Telemetry HUD — agent quadrant

See `docs/feature-catalog.md` for what the HUD looks like; what follows is the *why* behind the quadrant added to it in v4.0.

**Two honest axes, not one.** The status field (`running` / `idle` / `creating` / `needs_attention`) is a tmux process-tree heuristic — useful but not the whole truth. Token rate from telemetry is also half the truth. Rather than collapse them into one unreliable "working" flag, the HUD exposes both as orthogonal axes: **BUSY** (tinstar reports `status === 'running'`) × **LLM** (non-zero token rate in last ~30s). `BUSY ∧ ¬LLM` (waiting on a long bash) and `LLM ∧ ¬BUSY` (parent waiting on a Task-tool subagent that shares the parent's `session_id`) are both common and honest.

**READY = anything not BUSY.** Matches `READY_STATUSES` in `src/server/sessions/ReadyQueue.ts` — same population reachable via the `ctrl+[` ready-queue navigation. `needs_attention` is an alert condition, not an activity state, so it lives on the READY side too. Using the codebase's own vocabulary keeps the UI mental model aligned.

**Avatars are client-side, deterministic, cached.** DiceBear `bottts-neutral` SVGs are generated from `(run.id, run.color)` — both already on every Run. Module-level `Map<string,string>` cache keyed by `${runId}:${color}`; subsequent reads are a hashmap lookup. No server-side generation, no persisted SVG, no run-doc bloat. Dynamic-import bundle split keeps first paint unblocked.

**Burning-sessions translation.** Server adds a cheap (~0.7ms) `burningSessions()` Prometheus query that returns Claude-Code conversation UUIDs, then translates them back to tinstar run IDs and attaches `burningRunIds` to `HudSnapshot`. Stub also lives in `fast-sim.ts` so the FAST_SIM dev mode renders.

**HUD toggle parity with minimap.** Visible ✕ on hover, plus the `T` hotkey, plus a small icon button when hidden — same UX as the minimap's `M`. State persisted in `tinstar-hud-visible` localStorage.

Code: `src/components/CanvasHud/AgentQuadrant.tsx`, `src/components/agentAvatarCache.ts`, `src/server/observability/query.ts`.

---

## Claude Code quota HUD + statusline session-state store

**Two pivots in one feature.** The HUD card was first built to *poll* `/api/oauth/usage` (the undocumented endpoint behind CC's `/usage` TUI). It worked, but Anthropic rate-limited that endpoint hard — observed `Retry-After: 3418s`. Same-day pivot: the same `rate_limits` data is piggybacked on every CC inference response and exposed via CC's **statusline hook**, which invokes a shell command on every render and pipes its full session-state JSON on stdin. The push path is strictly better: zero rate-limit risk, fresh on every prompt, no OAuth beta headers. The only tradeoff is staleness during quiet periods; that was acceptable. **No pull fallback.**

**The shim posts everything; we keep all of it.** `scripts/cc-quota-statusline.sh` (installed per-machine via `~/.claude/settings.json` `statusLine` key) POSTs CC's full session-state to `POST /api/cc-quota/ingest`. The first cut extracted only `rate_limits.{five_hour,seven_day}` and threw the rest away. The session-state expansion turned that single snapshot into a `Map<sessionId, SessionState>` keyed store, fed by the same ingest. Per-session context-window utilization, cost, model, `fast_mode`, `output_style`, `exceeds_200k_tokens`, optional `agent` + `worktree` metadata are all addressable by `session_id`. Stale sessions evicted on TTL.

**Telemetry is not replaced.** `claude_code_*` Prometheus metrics stay the source of truth for historical dashboards. The in-memory store is a low-latency cache for live widgets only.

**No gas-pump chip.** Extra-usage state isn't in the statusline payload, so the per-model weekly chip + extra-usage chip from the API-poll design were both removed. (See `reference_cc_statusline_hook` memory.)

Code: `src/server/cc-quota/`, `scripts/cc-quota-statusline.sh`, `src/components/CanvasHud/CcQuotaCard.tsx`.

---

## The Saloon — session-scoped NATS monitor

**Replaces the Procedures panel.** Procedures occupied a 160px vertical slot above Telemetry in the run-workspace right panel and never produced the workflow its author wanted. The slot is more valuable as live visibility into the agent's NATS activity. Procedures code, types, routes, and modal UI all deleted.

**Reads existing SSOT, computes nothing new.** Subscriptions come from `session.nats.subscriptions` (already mutated at session-start and on breakout-room join in `src/server/api/routes.ts`). Broker health = `session.nats.enabled && !natsControlOrphanedAt`. Message stream is the existing `tinstar:nats_traffic` window event the legacy NatsTrafficWidget already drinks from. Only plumbing additions: `natsControlOrphanedAt` surfaced on `RunData`, and per-session registration with `NatsTrafficBridge` so it mirrors each session's subject list.

**Mute is cosmetic.** Clicking a subscription row dims it and hides those messages from the in-widget stream. The agent still receives and acts on them — this is a viewer-side noise filter, not a runtime subscription change. State is component-local `Set<string>`; resets on reload.

**One honest broker dot.** Green when the control socket is alive, red when orphaned or disabled. The `NATS_SOCKET_ORPHANED` recovery path documented in `release-notes-v3-7.md` is what populates this signal.

Code: `src/components/RunWorkspaceWidget/saloon/`, `src/server/nats-traffic.ts`.

---

## Topic metadata — friendly NATS subject names

**Why an explicit store.** NATS subjects are identifiers, not names. Hierarchical subjects (`…tinstar-improvement`) are mostly readable; breakout rooms (`tinstar.room.a2a46f1d`) are opaque hex. The Saloon needed a way to render "Task Room for Tinstar Improvement" while keeping the raw subject available on hover.

**Doesn't duplicate subscription truth.** The store records human-authored or once-bootstrapped facts about subjects: `name`, `description`, `kind` (`broadcast` / `dm` / `breakout` / `custom`), `createdAt`, `createdBy`. **Participants are derived live** from sessions' `nats.subscriptions` arrays — never stored. Cheap (~tens of items × tens of subscriptions) and always reflects truth.

**Names are computed once at write time.** Bootstrapped at session-create (broadcast + DM-inbox subjects) and breakout-create. If a task is later renamed, the metadata stays as it was written until somebody refreshes or edits — the alternative (live derivation from the entity tree) means a rename silently rewrites the historical chatter context.

**SSE for free.** Lives in the docStore; the existing docStore→SSE bridge propagates deltas to all clients automatically. No new push channel.

Code: `src/server/topic-metadata.ts`, `src/server/stores/document-store.ts`, `src/components/RunWorkspaceWidget/saloon/useTopicMetadata.ts`.

---

## Slash command autocomplete (prompt composer)

**Filesystem-driven discovery.** A server-side singleton walks `~/.claude/{commands,skills}`, project-local `.claude/`, and plugin caches. `mtime`-keyed cache invalidated by `fs.watch`; entries are merged with a small JSON usage-tracking file at `~/.config/tinstar/slash-usage.json`. Plugin entries are namespaced (`superpowers:brainstorming`); user/project commands keep their bare name.

**The composer never blocks on the network.** Module-scoped client cache serves matches synchronously. First fetch happens on composer mount; refetches on expand are cheap (server cache returns immediately if unchanged). The matcher reads from in-memory state — typing latency stays in the UI thread.

**Trigger rule.** A `/` enters slash mode only when it is the first character of the textarea OR the character immediately before it is whitespace. `path/to/foo` does NOT trigger; `please /foo` does. The "slash token" is the contiguous non-whitespace run starting at the `/`.

**No discovery of claude-code built-ins.** `/help`, `/clear`, etc. have no on-disk representation. Typing `/cle` and getting no suggestion falls through harmlessly to claude-code's own handler when sent — the menu is a hint, not the truth.

Code: `src/lib/slashMatching.ts`, `src/server/sessions/slashCommandRegistry.ts`, `src/hooks/useSlashCommands.ts`, `src/components/RunWorkspaceWidget/SlashChips.tsx`.

---

## Agent-skill: `/all-hands`

Skill ships in-repo at `agent-skills/skills/all-hands/`; the `SKILL.md` there is the SSOT for the workflow. What follows is the *why*.

**Single accountable implementer.** The agent that ran `/all-hands` does the bootstrap and writes the code. When hands disagree, the implementer makes the final call and writes a `decisions.md` capturing what was addressed, deferred, or overridden. There is no separate foreman — splitting accountability between a coordinator and an implementer was a worse-of-both-worlds shape in early sketches.

**Three phases: explode → contract → re-explode.** Phase 1 brief (each hand owns its own `hands/<name>/` mini-wiki, no write collisions), Phase 2 implementation (one agent writes code, hands lurk in the breakout room as on-call consultants), Phase 3 review (each hand grades against the **review-checklist locked in during Phase 1** — prevents goalpost drift).

**One shared NATS breakout room.** Transcript is the audit trail. Standing watches let hands self-trigger (e.g. "ping me on any change under `auth/`") rather than the implementer round-robining through reviewers.

**When NOT to use.** Independent parallel tracks (different shape needed), already-decided designs (just implement), small fixes (overhead isn't worth it).

Skill location: `agent-skills/skills/all-hands/SKILL.md` (+ `assets/`, `references/`).

---

## Retired design docs

`docs/superpowers/plans/` and `docs/superpowers/specs/` were retired with the v4.0 merge — same pattern v3.7 used, captured in `release-notes-v3-7.md`. The rationale above covers the load-bearing design decisions; individual specs live on in git history (`git log --all --oneline -- docs/superpowers/specs/<file>`).

`docs/nats-e2e-test-plan.md` was retired alongside — the four capabilities it specified (basic comms, broadcast, entity-move re-subscription, breakout rooms) all shipped in v3.7+; the timeless reference is `docs/nats-agent-channels.md`, and the `nats-poc/` directory the plan referenced no longer exists.
