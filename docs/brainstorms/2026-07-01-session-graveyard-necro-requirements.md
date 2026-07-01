---
date: 2026-07-01
topic: session-graveyard-necro
---

# The Graveyard — necro dead sessions to ask them questions

## Summary

A durable, searchable index of past Tinstar-managed sessions — the **Graveyard** — that records what each session covered and lets you (or an agent) dig one back up on demand to ask it questions. Deleting a session becomes the everyday declutter gesture: it leaves the canvas, but instead of vanishing it drops into the Graveyard, still findable and still revivable via the real agent. Death stops being loss.

## Problem Frame

Today a session that is no longer on the canvas is effectively gone: there is no stored record of what it worked on, and no way to ask it anything. The only workaround is to keep a session *alive* on the canvas indefinitely so it stays reachable — the user kept an "askviktor" session running for hours purely to preserve the ability to ask it one more question. That cost is paid in canvas clutter and slots held open against a maybe-future question.

The sharper edge is discoverability across time. When you (or an agent) are working on something today, nothing tells you that a relevant session worked the same ground yesterday. If you happen to remember it exists you might dig it up by hand; if you don't, its knowledge is simply unavailable. The missing capability is *knowing a relevant dead session exists* and being able to reach it cheaply.

## Key Decisions

- **Scope is Tinstar-managed sessions only.** The Graveyard indexes sessions Tinstar launched — running, stopped, or deleted — where task, persona, and worktree metadata are rich. Bare `claude` sessions run outside Tinstar are out of scope; `/ce-sessions` already searches that graveyard.
- **Delete is the retire gesture, and it is non-destructive to recall.** Deleting removes the session from the canvas and removes its worktree, but preserves a lightweight tombstone in the Graveyard (summary + conversation pointer + metadata) instead of hard-purging. This replaces any "auto-retire on stop" behavior — the user wants an explicit control, not automatic canvas changes.
- **The covers-summary is the durable asset; revive is best-effort.** The one thing the Graveyard always owns is a short summary of what the session covered. Revive depends on Claude Code's own retained transcript and works when that transcript survives; it is never guaranteed by anything Tinstar controls.
- **Revive is a true revive, not an impersonation.** Digging up a session relaunches the real agent through the existing `--resume` path — not a fresh agent reading the transcript. The user is fine with revive cost because it is on demand, not held open.
- **No transcript snapshotting in v1.** Tinstar relies on Claude Code's session-retention policy rather than copying transcripts into its own store. Accepted consequence: revive of old sessions can fail once Claude Code prunes the log.
- **A true purge exists and is separate.** Because delete now preserves a record, a distinct "forget forever" action removes the tombstone (and its recall) for good.

## Actors

- A1. **The user** — deletes sessions to keep the canvas clean, later searches the Graveyard and revives a session to ask it something.
- A2. **A working agent** — mid-task, queries the Graveyard for prior sessions covering the same ground, and can revive-and-ask without human involvement.
- A3. **A dying session** — on delete, contributes its covers-summary and conversation pointer to the Graveyard before its worktree is removed.

## Requirements

### Graveyard index and retention

- R1. The Graveyard indexes Tinstar-managed sessions across their lifecycle: live, stopped, and deleted-tombstone.
- R2. Deleting a session removes it from the canvas and removes its worktree, but writes a tombstone to the Graveyard rather than purging the record.
- R3. Each Graveyard entry stores: session name, a covers-summary, a pointer to the Claude Code conversation (its convId), and core metadata (task/epic/initiative, workspace path, model, created/last-active timestamps).
- R4. A distinct purge action permanently removes a Graveyard entry and its recall; ordinary delete never does this.

### Covers-summary

- R5. A session's covers-summary is generated from its transcript when the session dies (on stop or on delete) and stored in the index.
- R6. When transcript summarization is unavailable, the covers-summary falls back to derived signals already stored (task/epic/initiative names, recap entries, persona prompt).
- R7. A covers-summary can be regenerated on demand.

### Recall and search

- R8. An agent-callable recall tool answers "which past sessions cover X?" and returns matches with their covers-summaries and a revive-and-ask affordance.
- R9. A human-facing search surface on the canvas queries the same index and offers the same revive affordance.

### Revive and ask

- R10. Reviving a session relaunches the real agent via the existing `--resume` machinery and brings it back as a live card on the canvas for the duration of the exchange.
- R11. After the exchange, the user can delete the revived session again, returning it to the Graveyard.
- R12. Revive is best-effort: when the underlying Claude Code transcript is gone, revive is unavailable and the entry still surfaces its covers-summary.

## Key Flows

- F1. Human necro
  - **Trigger:** The user remembers (or searches and finds) a dead session relevant to what they're doing now.
  - **Actors:** A1
  - **Steps:** User searches the Graveyard → matches show covers-summaries → user picks one and revives → the real agent returns as a live card → user asks questions → user deletes it back to the Graveyard.
  - **Covered by:** R8, R9, R10, R11

- F2. Agent recall mid-task
  - **Trigger:** An agent working a task wants to know whether prior work covered the same ground.
  - **Actors:** A2
  - **Steps:** Agent calls the recall tool with the topic → receives matching sessions + covers-summaries → optionally revives one and asks it directly → acts on the answer.
  - **Covered by:** R8, R10, R12

- F3. Retire on delete
  - **Trigger:** The user deletes a session to declutter the canvas.
  - **Actors:** A1, A3
  - **Steps:** Covers-summary is generated → tombstone (summary + convId + metadata) is written to the Graveyard → worktree is removed → the card leaves the canvas.
  - **Covered by:** R2, R3, R5

## Acceptance Examples

- AE1. Worktree deleted, transcript intact
  - **Covers R10, R12.**
  - **Given** a deleted session whose worktree is gone but whose Claude Code transcript still exists,
  - **When** the user revives it,
  - **Then** the agent returns and answers questions from its conversation memory, but the code it worked on is no longer present — so questions answerable from the conversation succeed while requests to re-inspect or modify the old files do not.

- AE2. Transcript pruned by Claude Code
  - **Covers R12, R6.**
  - **Given** a Graveyard entry whose Claude Code transcript has been pruned,
  - **When** the user or an agent tries to revive it,
  - **Then** revive is unavailable and the entry still surfaces its stored covers-summary.

- AE3. Delete vs purge
  - **Covers R2, R4.**
  - **Given** a session in the Graveyard,
  - **When** the user deletes it, it remains searchable and (best-effort) revivable; **when** the user purges it, it is gone from search and recall entirely.

## Scope Boundaries

### Deferred for later

- Proactive surfacing — the system automatically noticing that current work overlaps a dead session and offering to revive it. Layers on top of the recall index once it exists.
- Transcript snapshotting into Tinstar's own store to make revive bulletproof and unlock reliable revive of very old / fully-purged sessions.
- Reconstructing a runnable session record from a convId alone (needed only if revive must survive Claude Code's own transcript pruning).

### Outside this scope

- Indexing or reviving non-Tinstar `claude` sessions run in a bare terminal — that overlaps `/ce-sessions`.

## Dependencies / Assumptions

- Revive relies on the existing start/resume path (`POST /api/sessions/:name/start` → `claude --resume <conversation.id>`) and on stopped/deleted sessions retaining their convId.
- Revive durability is bounded by Claude Code's session-retention policy, which Tinstar does not control; old sessions may become non-revivable over time. This is an accepted limitation.
- A covers-summary requires a transcript readable at death; the derived-signals fallback covers the case where summarization can't run.

## Outstanding Questions

### Deferred to planning

- Where the Graveyard index physically lives and how a tombstone is represented so it survives worktree/dir removal (today `DELETE` removes the whole session dir).
- Whether search is keyword-only for v1 or includes semantic matching over covers-summaries.
- The recall tool's surface (MCP tool vs skill vs both) and how a revive-and-ask is expressed to an agent.
- Whether stopped-but-not-deleted sessions appear in the same search surface as deleted tombstones, and how the two are visually distinguished.

## Sources / Research

- `src/server/sessions/session.ts` — on-disk `Session` model; `conversation.id` minted at create (~`:183`), `session.json` layout, CRUD, `claude-state/`.
- `src/server/sessions/reconcile.ts` — tmux-liveness death detection; `running|idle|needs_attention → stopped`. No `dead`/`archived` status exists (`src/domain/types.ts:10`).
- `src/server/sessions/backends/tmux.ts` — `buildAgentCommand` resume path appends `--resume <conversation.id>`; `startTmuxSession` / `reattachTmuxSession`.
- `src/server/sessions/resume.ts` — `ensureResumeReady`, `detectConversationId` recovery from `claude-state/`.
- `src/server/api/routes.ts` — `POST /api/sessions/:name/start` (revive path); `DELETE /api/sessions/:name` (purges the whole dir; emits `managed_session.deleted`).
- `src/server/sessions/transcript-parser.ts` — transcript path is *derived* from workspace path + convId; `findTranscriptByConvId` scans `~/.claude/projects/*/` for `<convId>.jsonl` (~`:295`).
- No stored per-session title/summary/topic exists today — "what it covers" is implicit in task hierarchy + recap entries (`src/server/stores/document-store.ts`).
- Prior art: the "rehydrate from history" experiment (feed a dead session's transcript to a fresh agent and ask a context-dependent question) — the ephemeral alternative deliberately not chosen here in favor of true revive.
