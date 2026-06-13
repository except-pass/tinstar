# Note Replies — Design

**Status:** Approved (2026-06-13) · **Branch:** `noteReplies` · **Builds on:** [2026-06-11-widget-pins-design.md](./2026-06-11-widget-pins-design.md)

## Summary

The widget-pins feature lets a user drop a note anywhere on a canvas widget, write a
message, and send it to the widget's backing agent. Today that flow is **one-directional**:
the comment travels `note → POST /api/sessions/:id/enter-prompt → tmux sendPrompt → agent`,
and the agent answers in its own terminal. There is no path for the agent's answer to land
back on the note.

This design adds a **return path** so notes become **threads** — the Figma/Jira/Slack model:
a user pins a note, the agent replies in-thread, the user can reply again, the agent replies
again, unbounded, until the user resolves the note.

The framing that keeps this small: the return path is **a new route on the API that already
owns pins** (`/api/pins/...`), and the agent posts its reply by running an exact `curl` that
the note's Send button bakes into the prompt. No new MCP surface, no session-addressing
changes, no terminal scraping. The reply lands in the per-space `pinSet` document, bumps its
revision, and rides the existing SSE channel back to every open canvas.

## Goals

- A note is a **thread**: originating comment + unbounded back-and-forth between user and agent.
- The agent's reply lands **on the specific note**, live, via SSE.
- The user can reply in-thread; each user reply re-prompts the agent with the thread so far.
- A note can be **resolved** (soft — thread stays readable and reopenable).
- Reuse the existing pins storage, sync, send, and session-resolution machinery wholesale.

## Non-Goals

- New MCP tool. (Explicitly rejected: MCPs are admin overhead; the agent is *prompted* to
  reply with exact instructions, not acting autonomously, so a plain API is point-and-go.)
- Capturing/scraping the agent's terminal output as the reply (no clean message boundary).
- Cross-widget thread inbox / note list / jump-to-note navigation (still deferred from pins design).
- Changing session addressing — reuses `resolveBackingSession` → `enter-prompt` → tmux unchanged.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Thread model | Full back-and-forth, unbounded | Matches the cited Figma/Jira/Slack precedent |
| Return path | New REST route on the existing pins API | API already exists for this feature; no MCP admin; agent is prompted, not autonomous |
| Reply storage | Co-located `replies[]` on `Pin` | Delete-pin disposes the thread for free; one SSE entity; no second store to GC/rev-gate |
| Replies authority | Server-owned via the new route only | Avoids whole-doc PUT clobbering a freshly-arrived agent reply |
| Resolve | Soft (greyed, reopenable) | Non-destructive; threads stay readable |

## Data Model

`src/domain/pinSet.ts` — extend `Pin`; add `Reply`:

```ts
export interface Reply {
  id: string                    // "reply-<ts>-<rand>"
  author: 'user' | 'agent'
  text: string
  createdAt: number
}

export interface Pin {
  // ...existing: id, nodeId, nx, ny, comment, createdAt, sentAt?, context?
  replies?: Reply[]             // thread beneath the originating comment
  resolvedAt?: number           // set when the user resolves the note
}
```

- `comment` remains **message 0**, authored by the user (the note's subject). It is NOT
  duplicated into `replies[]`.
- `replies[]` is the back-and-forth that follows. It is **append-only** and written
  exclusively through the new reply route (see Reconciliation).

Pure mutators to add (mirroring the existing `addPin`/`updatePin` style):

```ts
addReply(set: PinSet, pinId: string, reply: Reply): PinSet
resolvePin(set: PinSet, pinId: string, at: number): PinSet
reopenPin(set: PinSet, pinId: string): PinSet
```

## Return-Path Endpoint

`src/server/api/routes.ts` — new route, the single authority for thread content:

```
POST /api/pins/:spaceId/notes/:noteId/replies
  body: { text: string, author?: 'user' | 'agent' }   // defaults to 'agent'
  200 → { ok: true, data: { replyId } }
  400 → { error: "missing 'text' in request body" }
  404 → { error: "no note found with id '<noteId>' in space '<spaceId>'" }
```

Server behavior:
1. Load the `PinSet` for `spaceId` (`getPinSet`).
2. Find the pin by `noteId`; 404 with the message above if absent.
3. Append `{ id, author, text, createdAt }` to `pin.replies`, bump `pinSet.rev`, persist via
   `upsertPinSet`, which emits the `pinSet` SSE entity.
4. Return `{ ok: true, data: { replyId } }`.

Error messages are deliberately specific because the agent reads them in its terminal and
self-corrects (the user named "good error messages" as the contract).

**Both** the agent's reply and the user's in-thread follow-up POST to this same route,
differing only by `author`.

### Reconciliation (whole-doc PUT vs server-side append)

Introducing a server-side writer (the agent) creates a clobber risk: the client's existing
whole-document `PUT /api/pins/:spaceId` (used for geometry/comment/sentAt edits) could
overwrite a reply that arrived server-side after the client's last SSE sync.

**Rule:** on `PUT /api/pins/:spaceId`, the server **preserves the existing `replies[]` per pin
id** and ignores any `replies` in the client payload. Net effect:

- `nx/ny`, `comment`, `sentAt`, `resolvedAt`, pin add/remove → flow through PUT as today.
- `replies[]` → owned exclusively by the new reply route.

This decouples thread content from the geometry write path entirely; no merge races. Pin
deletion via PUT still drops the pin (and its replies) as today.

## Send / Prompt Flow

Reuses `resolveBackingSession(nodeId)` → `POST /api/sessions/:id/enter-prompt` → tmux
`sendPrompt`. Only the prompt body changes.

**Initial send** (existing Send button) — `enter-prompt`, then set `sentAt`:

```
📍 New note on <label> — <where>:
"<comment>"

Reply to this note by running exactly:
curl -s -X POST '<origin>/api/pins/<spaceId>/notes/<noteId>/replies' \
  -H 'Content-Type: application/json' \
  -d '{"text":"YOUR REPLY"}'
Your reply appears in the thread on the note. Keep it concise.
```

- `<origin>` = `window.location.origin` (the agent runs on the same host and reaches the
  same server).
- `<where>` = existing `describePinSpot` / browser `describeLocation` output.

**Agent reply** → the curl above → reply route → SSE → bubble updates live.

**User follow-up** (new in-thread input):
1. POST to the reply route with `author:'user'`.
2. `enter-prompt` again to wake the agent, with the **thread-so-far** context plus the same
   curl line:

```
📍 Follow-up on note <label> — <where>:

Thread so far:
[user] <comment>
[agent] <reply 1>
[user] <follow-up>

Reply with the same curl:
curl -s -X POST '<origin>/api/pins/<spaceId>/notes/<noteId>/replies' ...
```

Thread context is sent in full (notes are short); revisit only if length becomes a problem.

## UI

Thread rendering lives in the shared `src/pins/PinBubble.tsx`, so both the shell renderer
(`PinLayer`) and the browser self-renderer (`BrowserPinLayer`) inherit it. Host-specific
wiring (which session, building the curl URL, calling `enter-prompt`) stays in
`InfiniteCanvas.tsx` (shell pins) and `BrowserPrimitive.tsx` (browser pins) and is passed in
as callbacks.

```
┌─────────────────────────────┐
│ 📍 on "Send button"       ⋯ │   ⋯ menu → Resolve / Delete
├─────────────────────────────┤
│ you · 2m                    │
│  Why is this disabled?      │
│ agent · just now            │
│  It's gated on canSubmit…   │
├─────────────────────────────┤
│ [ Reply…             ] [↩]  │   reply input + send — shown only after sentAt
└─────────────────────────────┘
```

Marker states (`src/pins/PinMarker.tsx`):

| State | Marker |
|---|---|
| Unsent | number (1, 2, 3…) — unchanged |
| Sent, awaiting agent | muted ✓ |
| Has unread agent reply | ✓ with accent dot (clears when bubble opened) |
| Resolved | greyed ✓ |

"Unread" is **client-local ephemeral state**, not persisted on the `Pin`: the renderer
compares the latest agent reply's `createdAt` against the bubble's last-opened time held in
component state. It is intentionally not synced — read state is per-viewer, not a property of
the note.

An "agent is replying…" shimmer shows in the thread between a user send and the next agent
reply (i.e., when the last message is user-authored and the note is unresolved).

## Testing

- **Unit** (`src/domain/pinSet.test.ts`): `addReply` / `resolvePin` / `reopenPin` mutators.
- **Server** (routes test): reply route 200/400/404 and `rev` bump; PUT preserves existing
  `replies[]` against a stale client payload.
- **E2E** (`TINSTAR_FAST_SIM=1 npx playwright test`): drop note → send → simulate the agent
  curl → assert the reply renders in the thread → user follow-up re-prompts the session.

## Migration

None. New optional fields (`replies?`, `resolvedAt?`) default to absent; existing pins render
as single-comment notes until a reply arrives. The `BrowserWidget.notes[] → PinSet` migration
from the pins design is unchanged.
