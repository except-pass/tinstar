# Topic Metadata — friendly names for NATS subjects

**Status:** Design approved, ready for implementation plan.
**Augments:** [The Saloon](2026-04-24-saloon-design.md) — same UI, richer rendering.

## Problem

NATS subjects are identifiers, not names. The Saloon panel currently shows
the raw subject string (truncated). For hierarchical subjects this is
mostly readable (`…tinstar-improvement` makes some sense), but for breakout
rooms it's an opaque hex hash (`tinstar.room.a2a46f1d`). Users can't tell
which breakout is which without context they don't have.

We need a way to display **friendly names** for subjects in the Saloon,
with the raw subject available on hover.

## Goal

Add a small **explicit** metadata store keyed by subject that the Saloon
reads to show:

- A friendly **name** (e.g. *"Task Room for Tinstar Improvement"* instead of
  `tinstar.work-space._._.tinstar-improvement`)
- A free-form **description**
- The **kind** of topic (`broadcast` / `dm` / `breakout` / `custom`)
- Provenance (**createdAt**, **createdBy**)
- A **participants** list (derived live, not stored — see below)

Anyone can rename via the UI. Changes propagate via SSE so all clients see
renames instantly.

## Non-goals

- Read-time derivation of names from subject shape. Explicit values only.
  (Bootstrap-from-shape happens *once*, at write time, not on every read.)
- Storing live system state on the metadata record (e.g. who's currently
  subscribed). That's tracked elsewhere already (per-session
  `nats.subscriptions`) and would drift if duplicated.
- Per-user metadata. Names are global — everyone sees the same name for the
  same subject.
- Versioning / rename history. Last write wins.
- Validation rules on names beyond non-emptiness.

## SSOT and storage

| Concern | Source | Storage |
|---|---|---|
| Subscriptions (per session) | `Session.nats.subscriptions` | `~/.config/tinstar/sessions/<name>/session.json` (existing — unchanged) |
| Topic name / description / kind / createdAt / createdBy | New `TopicMetadata` entity | DocStore, persisted to `~/.config/tinstar/docstore.json` |
| Participants for a subject | Derived at read-time from sessions' subscription lists | Not stored |

The new store does not duplicate the subscription truth. It only adds
human-authored or once-bootstrapped facts about subjects.

## Data model

```ts
interface TopicMetadata {
  subject: string                 // primary key
  name?: string                   // friendly display name
  description?: string            // optional free-form
  kind: 'broadcast' | 'dm' | 'breakout' | 'custom'
  createdAt: string               // ISO timestamp
  createdBy?: string              // session that minted it (parent for breakouts)
}
```

`participants` is **not** a field on this record. It's derived per-request:

```ts
function topicParticipants(subject: string, sessions: Session[]): string[] {
  return sessions
    .filter(s => s.nats?.subscriptions?.includes(subject))
    .map(s => s.name)
}
```

Cheap (~tens of items × tens of subscriptions). Always reflects truth.

## Population

Metadata is written **explicitly** at three points:

1. **Session create** — for every new session with NATS enabled, write
   metadata for the broadcast subject and the DM-inbox subject:

   ```ts
   {
     subject: '<broadcast subject>',
     name: 'Task: <task.name>',
     kind: 'broadcast',
     createdAt: now,
     createdBy: '<session.name>',
   }
   {
     subject: '<dm subject>',
     name: 'DM → <session.name>',
     kind: 'dm',
     createdAt: now,
     createdBy: '<session.name>',
   }
   ```

   Names are computed **once at write time** from the entity-tree's
   current values. If the task is later renamed, the metadata stays as it
   was written until somebody explicitly refreshes or edits it.

2. **Breakout-room create** (`src/server/api/routes.ts:2551` area) — when the
   spawn flow creates `tinstar.room.<uuid>`, write:

   ```ts
   {
     subject: 'tinstar.room.<uuid>',
     name: '<hand-type> with <parent.name>',     // e.g. 'rubberduck with natsViz'
     kind: 'breakout',
     createdAt: now,
     createdBy: '<parent.name>',
   }
   ```

3. **User edit via PATCH** — `PATCH /api/topics/:subject` updates `name`
   and/or `description`. Last write wins. No auth gate (the deployment is
   trusted; this is convenience).

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/topics` | — | All `TopicMetadata` records (with derived `participants` joined in) |
| `GET` | `/api/topics/:subject` | — | One record + participants |
| `PATCH` | `/api/topics/:subject` | `{ name?, description? }` | Updated record + participants |
| (internal) | — | — | `POST /api/topics/:subject/refresh` re-bootstraps name from current entity-tree state for hierarchical subjects (handy if a task gets renamed) |

`:subject` is URL-encoded.

## SSE

DocStore changes already broadcast via SSE. Add `topic_metadata` events
so the UI updates without polling. Event shape:

```ts
{ type: 'topic_metadata', subject: string, metadata: TopicMetadata | null }
```

`metadata: null` indicates deletion (rare — only via internal cleanup).

The Saloon's `useTopicMetadata(subject)` hook subscribes to the event bus
and re-renders when changes arrive.

## UI

### SubscriptionsList (top half of Saloon)

- Row label: `metadata.name ?? shortSubject(subject)`
- Tooltip: subject + role + description + createdAt + participants list +
  "Click ✎ to rename" hint
- Hover state reveals a small `edit` (pencil) icon. Click → inline input
  field. Enter to save (`PATCH /api/topics/:subject`). Esc to cancel.
- Optimistic update — write to local state immediately, reconcile with
  SSE confirmation.

### StreamView (bottom half of Saloon)

- Row's subject column shows `metadata.name ?? shortSubject(subject)`
- Tooltip: full subject + description
- Filter input still matches against raw subject AND body AND name (so
  searching for "rubberduck" finds renamed breakout rooms).

## Testing

- **Unit (server):** docStore CRUD for `TopicMetadata`. PATCH partial-update
  semantics. `topicParticipants` correctness for several subscription
  configurations.
- **Unit (frontend):** `useTopicMetadata` hook subscribes to SSE,
  re-renders on update. SubscriptionsList renders friendly name when
  metadata exists, raw `shortSubject` when it doesn't.
- **Integration:** create a session → expect 2 metadata records in
  docstore.json. Spawn a breakout → expect 1 more. PATCH name → SSE event
  observed → UI updates.
- **E2E:** rename a topic in the Saloon, verify the new name renders.

## Out of scope (later)

- Refreshing hierarchical metadata when a task/epic is renamed in the
  taxonomy. v1 leaves the bootstrap-time name in place; a manual
  `/api/topics/:subject/refresh` exists for the rare case.
- Per-user metadata.
- Validation / moderation of names.
- Tagging / coloring beyond what role-based coloring already provides.
