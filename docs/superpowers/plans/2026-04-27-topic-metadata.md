# Topic Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, subject-keyed metadata (name + description + kind + provenance) for NATS subjects so the Saloon panel renders friendly names instead of raw subject strings, with the raw subject + extra metadata available on tooltip hover.

**Architecture:** New `TopicMetadata` entity in the docStore (single-file persistence, SSE deltas auto-propagate via the existing docStore→SSE bridge in `sse.ts:14-39`). Records are written explicitly at three points (session-create, breakout-create, user PATCH). Participants are derived live from sessions' `nats.subscriptions` arrays — never stored. Frontend reads via a new selector hook; the Saloon's existing `SubscriptionsList` and `StreamView` look up the friendly name from the hook.

**Tech Stack:** TypeScript + Vite plugin server, React + Tailwind, Vitest (unit), Playwright (e2e). Reuses existing docStore CRUD + SSE patterns.

**Spec:** `docs/superpowers/specs/2026-04-27-topic-metadata-design.md`

---

## File structure

**Modify:**
- `src/domain/types.ts` — add `TopicMetadata` interface
- `src/server/stores/document-store.ts` — add CRUD + snapshot + load/save for `topicMetadata` Map
- `src/server/api/routes.ts` — GET/PATCH/refresh routes; bootstrap calls at session-create and breakout-create
- `src/hooks/useBackendState.ts` — new state slice + delta handler
- `src/components/RunWorkspaceWidget/saloon/SubscriptionsList.tsx` — friendly name, tooltip, inline rename
- `src/components/RunWorkspaceWidget/saloon/StreamView.tsx` — friendly name, filter matches name

**Create:**
- `src/server/topic-metadata.ts` — `topicParticipants(subject, sessions)` helper + `bootstrapHierarchicalTopicMetadata(...)` for session-create
- `src/server/__tests__/topicMetadata.test.ts` — unit tests for helpers + docStore CRUD
- `src/components/RunWorkspaceWidget/saloon/useTopicMetadata.ts` — frontend selector hook
- `src/components/RunWorkspaceWidget/saloon/__tests__/useTopicMetadata.test.tsx`
- `e2e/topic-metadata.spec.ts`

---

## Task 1: `TopicMetadata` type + docStore CRUD

**Files:**
- Modify: `src/domain/types.ts`, `src/server/stores/document-store.ts`
- Test: `src/server/stores/__tests__/document-store-topicMetadata.test.ts`

Mirrors the existing `NatsTrafficWidget` CRUD pattern (`document-store.ts:348-365`).

- [ ] **Step 1: Add the `TopicMetadata` type**

In `src/domain/types.ts`, alongside other entity exports, add:

```ts
export interface TopicMetadata {
  subject: string
  name?: string
  description?: string
  kind: 'broadcast' | 'dm' | 'breakout' | 'custom'
  createdAt: string
  createdBy?: string
}
```

- [ ] **Step 2: Write the failing CRUD test**

Create `src/server/stores/__tests__/document-store-topicMetadata.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentStore } from '../document-store'

const sample = {
  subject: 'tinstar.work-space.x.y.z',
  name: 'Task Room',
  kind: 'broadcast' as const,
  createdAt: '2026-04-27T00:00:00Z',
  createdBy: 'natsViz',
}

describe('DocumentStore.topicMetadata', () => {
  let store: DocumentStore
  beforeEach(() => { store = new DocumentStore() })

  it('upsert + get round-trips', () => {
    store.upsertTopicMetadata(sample.subject, sample)
    expect(store.getTopicMetadata(sample.subject)).toEqual(sample)
  })

  it('getAllTopicMetadata returns all records', () => {
    store.upsertTopicMetadata('a', { ...sample, subject: 'a' })
    store.upsertTopicMetadata('b', { ...sample, subject: 'b' })
    expect(store.getAllTopicMetadata().map(m => m.subject).sort()).toEqual(['a', 'b'])
  })

  it('delete removes the record and emits change', () => {
    let lastChange: unknown = null
    store.changes.on('change', c => { lastChange = c })
    store.upsertTopicMetadata('a', { ...sample, subject: 'a' })
    store.deleteTopicMetadata('a')
    expect(store.getTopicMetadata('a')).toBeUndefined()
    expect(lastChange).toMatchObject({ entity: 'topicMetadata', id: 'a', data: null })
  })

  it('snapshot includes topicMetadata', () => {
    store.upsertTopicMetadata('a', { ...sample, subject: 'a' })
    expect(store.snapshot()).toMatchObject({ topicMetadata: [{ subject: 'a' }] })
  })
})
```

- [ ] **Step 3: Run the test — expect FAIL**

```bash
cd /home/ubuntu/repo/tinstar && npx vitest run src/server/stores/__tests__/document-store-topicMetadata.test.ts
```
Expected: FAIL — methods don't exist.

- [ ] **Step 4: Add CRUD to the docStore**

In `src/server/stores/document-store.ts`:

a. Add the type to imports (top of file):
```ts
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget, NatsTrafficWidget, TopicMetadata } from '../../domain/types'
```

b. Add the storage Map alongside the existing private Maps (search for `private natsTrafficWidgets`):
```ts
  private topicMetadata = new Map<string, TopicMetadata>()
```

c. Add load/save persistence. In the `enablePersistence()` method find the `if (data.natsTrafficWidgets)` block (~line 56) and add immediately after:
```ts
      if (data.topicMetadata) for (const m of data.topicMetadata) this.topicMetadata.set(m.subject, m)
```

In the same file find where `natsTrafficWidgets` is serialized (the persistence-write side — search for `natsTrafficWidgets:` inside the persist function) and add `topicMetadata: [...this.topicMetadata.values()]` to the same object.

d. Add the CRUD methods immediately after the `getAllNatsTrafficWidgets` block:

```ts
  // --- TopicMetadata ---

  upsertTopicMetadata(subject: string, data: TopicMetadata): void {
    this.topicMetadata.set(subject, data)
    this.changes.emit('change', { entity: 'topicMetadata', id: subject, data })
  }

  deleteTopicMetadata(subject: string): void {
    this.topicMetadata.delete(subject)
    this.changes.emit('change', { entity: 'topicMetadata', id: subject, data: null })
  }

  getTopicMetadata(subject: string): TopicMetadata | undefined {
    return this.topicMetadata.get(subject)
  }

  getAllTopicMetadata(): TopicMetadata[] {
    return [...this.topicMetadata.values()]
  }
```

e. Add to `snapshot()` and to the unfiltered snapshot variant (search both `natsTrafficWidgets:` lines around 380 and 400):
```ts
      topicMetadata: this.getAllTopicMetadata(),
```
Topic metadata is space-agnostic — include in both filtered and unfiltered snapshots without `inSpace` filtering.

- [ ] **Step 5: Run test — expect PASS**

```bash
npx vitest run src/server/stores/__tests__/document-store-topicMetadata.test.ts
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): add TopicMetadata entity to docStore

Subject-keyed metadata for friendly topic names. CRUD mirrors the
existing NatsTrafficWidget pattern; included in snapshot for SSE
hydration. No bootstrap or routes yet — that's next (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Participants helper + topic API routes

**Files:**
- Create: `src/server/topic-metadata.ts` (helpers)
- Modify: `src/server/api/routes.ts` (routes)
- Test: `src/server/__tests__/topicMetadata.test.ts`

- [ ] **Step 1: Write the failing helper test**

Create `src/server/__tests__/topicMetadata.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { topicParticipants, joinParticipants } from '../topic-metadata'
import type { Session } from '../sessions/session'

const sess = (name: string, subs: string[] | null): Session => ({
  name, backend: 'tmux', state: 'running', project: null,
  workspace: { path: null, worktree: false, branch: null, basePath: null },
  conversation: { id: null }, profile: null, oneshot: false,
  skipPermissions: false, cliTemplate: null, adapter: null,
  nats: subs ? { enabled: true, subscriptions: subs } : null,
  port: null, ttydPid: null, natsControlOrphanedAt: null,
  created: '2026-04-27T00:00:00Z', lastActive: '2026-04-27T00:00:00Z',
})

describe('topicParticipants', () => {
  it('returns session names that subscribe to the subject', () => {
    const sessions = [
      sess('alpha', ['tinstar.x', 'tinstar.y']),
      sess('beta',  ['tinstar.x']),
      sess('gamma', ['tinstar.z']),
      sess('delta', null),
    ]
    expect(topicParticipants('tinstar.x', sessions).sort()).toEqual(['alpha', 'beta'])
    expect(topicParticipants('tinstar.y', sessions)).toEqual(['alpha'])
    expect(topicParticipants('tinstar.unknown', sessions)).toEqual([])
  })
})

describe('joinParticipants', () => {
  it('attaches a participants array to the metadata record', () => {
    const md = { subject: 's', kind: 'broadcast' as const, createdAt: '' }
    const sessions = [sess('a', ['s']), sess('b', ['s'])]
    expect(joinParticipants(md, sessions)).toMatchObject({
      subject: 's', participants: ['a', 'b'],
    })
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run src/server/__tests__/topicMetadata.test.ts
```

- [ ] **Step 3: Implement the helpers**

Create `src/server/topic-metadata.ts`:

```ts
import type { TopicMetadata } from '../domain/types'
import type { Session } from './sessions/session'

export function topicParticipants(subject: string, sessions: Session[]): string[] {
  return sessions
    .filter(s => s.nats?.subscriptions?.includes(subject))
    .map(s => s.name)
    .sort()
}

export interface TopicMetadataWithParticipants extends TopicMetadata {
  participants: string[]
}

export function joinParticipants(
  md: TopicMetadata,
  sessions: Session[],
): TopicMetadataWithParticipants {
  return { ...md, participants: topicParticipants(md.subject, sessions) }
}
```

- [ ] **Step 4: Test passes**

```bash
npx vitest run src/server/__tests__/topicMetadata.test.ts
```

- [ ] **Step 5: Add API routes**

In `src/server/api/routes.ts`:

a. Add imports (near other `./` imports):
```ts
import { topicParticipants, joinParticipants } from '../topic-metadata'
import { listSessions, getSession as getSessionRecord } from '../sessions'
```
(verify `listSessions` exists by grepping `src/server/sessions/index.ts`; if it doesn't, replace with the readdirSync pattern already used at `index.ts:171-176`).

b. Add the routes alongside other entity GET/PATCH groups (e.g. just after the `/api/worktrees/` PATCH at line 1063). Use a small helper to load all sessions in scope:

```ts
function listAllSessions(ctx: RouteContext): Session[] {
  if (!ctx.sessionsDir) return []
  return readdirSync(ctx.sessionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => getSessionRecord(ctx.sessionsDir!, e.name))
    .filter((s): s is Session => Boolean(s))
}
```

(`ctx.sessionsDir` may be a string; verify by grepping the `RouteContext` shape and use whatever field already holds `sessionConfig.dirs.sessions`. If none, thread one through — check how `natsHealth` was added in the Saloon plan for the pattern.)

Then the routes:

```ts
  // GET /api/topics — all metadata records, with participants joined in
  if (method === 'GET' && url === '/api/topics') {
    const sessions = listAllSessions(ctx)
    const data = ctx.docStore.getAllTopicMetadata().map(m => joinParticipants(m, sessions))
    json(res, { ok: true, data })
    return true
  }

  // GET /api/topics/:subject — single record
  if (method === 'GET' && url.startsWith('/api/topics/') && !url.endsWith('/refresh')) {
    const subject = decodeURIComponent(url.slice('/api/topics/'.length))
    const md = ctx.docStore.getTopicMetadata(subject)
    if (!md) return json(res, { error: 'not found' }, 404)
    json(res, { ok: true, data: joinParticipants(md, listAllSessions(ctx)) })
    return true
  }

  // PATCH /api/topics/:subject — rename / re-describe (anyone may write)
  if (method === 'PATCH' && url.startsWith('/api/topics/') && !url.endsWith('/refresh')) {
    const subject = decodeURIComponent(url.slice('/api/topics/'.length))
    readBody(req).then(body => {
      const existing = ctx.docStore.getTopicMetadata(subject)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body) as { name?: string; description?: string }
      const merged = { ...existing, ...patch }
      ctx.docStore.upsertTopicMetadata(subject, merged)
      json(res, { ok: true, data: joinParticipants(merged, listAllSessions(ctx)) })
    })
    return true
  }

  // POST /api/topics/:subject/refresh — re-bootstrap a hierarchical name from
  // the entity tree's CURRENT values. No-op for breakout / custom kinds.
  if (method === 'POST' && url.startsWith('/api/topics/') && url.endsWith('/refresh')) {
    const subject = decodeURIComponent(url.slice('/api/topics/'.length, -('/refresh'.length)))
    const existing = ctx.docStore.getTopicMetadata(subject)
    if (!existing) return json(res, { error: 'not found' }, 404)
    if (existing.kind !== 'broadcast' && existing.kind !== 'dm') {
      return json(res, { ok: true, data: joinParticipants(existing, listAllSessions(ctx)) })
    }
    // Re-derive the name from the current entity tree — see Task 3 for the
    // helper that does this (deriveHierarchicalName).
    const refreshedName = deriveHierarchicalName(subject, ctx.docStore, existing.kind)
    if (refreshedName) {
      const merged = { ...existing, name: refreshedName }
      ctx.docStore.upsertTopicMetadata(subject, merged)
      return json(res, { ok: true, data: joinParticipants(merged, listAllSessions(ctx)) })
    }
    json(res, { ok: true, data: joinParticipants(existing, listAllSessions(ctx)) })
    return true
  }
```

`deriveHierarchicalName` is defined in Task 3. Stub it as `function deriveHierarchicalName(_s: string, _ds: any, _k: string): string | null { return null }` for this task — Task 3 fills it in.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): topic-metadata routes + participants derivation

GET / GET-single / PATCH / refresh routes for TopicMetadata.
Participants are derived live from per-session subscription lists at
each request — never stored, so they can't drift. PATCH allows any
caller to rename (convenience feature, no auth gate). The refresh
endpoint is a stub for now; Task 3 fills in deriveHierarchicalName
(#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Bootstrap metadata at session-create

**Files:**
- Modify: `src/server/topic-metadata.ts` (add `bootstrapHierarchicalTopicMetadata` + `deriveHierarchicalName`)
- Modify: `src/server/api/routes.ts` (call at session-create sites)
- Test: extend `src/server/__tests__/topicMetadata.test.ts`

- [ ] **Step 1: Write the failing test for `deriveHierarchicalName`**

Append to `src/server/__tests__/topicMetadata.test.ts`:

```ts
import { deriveHierarchicalName } from '../topic-metadata'
import { DocumentStore } from '../stores/document-store'

describe('deriveHierarchicalName', () => {
  it('returns "Task: <name>" for a broadcast subject ending in a real task', () => {
    const ds = new DocumentStore()
    ds.upsertSpace('s1', { id: 's1', name: 'Work Space', createdAt: '' })
    ds.activeSpaceId = 's1'
    ds.upsertInitiative('i1', { id: 'i1', name: 'Init', spaceId: 's1', createdAt: '' })
    ds.upsertEpic('e1', { id: 'e1', name: 'Epic', initiativeId: 'i1', spaceId: 's1', createdAt: '' })
    ds.upsertTask('t1', { id: 't1', name: 'Tinstar Improvement', epicId: 'e1', initiativeId: 'i1', spaceId: 's1', createdAt: '' })
    expect(deriveHierarchicalName('tinstar.work-space.init.epic.tinstar-improvement', ds, 'broadcast'))
      .toBe('Task: Tinstar Improvement')
  })

  it('returns "DM → <session>" for a DM subject', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.work-space.init.epic.task.natsviz', ds, 'dm'))
      .toBe('DM → natsviz')
  })

  it('returns null for an unrecognized shape', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.weird', ds, 'broadcast')).toBe(null)
  })
})
```

(Verify the docStore method names — `upsertInitiative`, `upsertEpic`, `upsertTask` — by grepping document-store.ts. The expected fields on each entity may vary; copy the shape from any existing test that constructs them.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `deriveHierarchicalName` and `bootstrapHierarchicalTopicMetadata`**

In `src/server/topic-metadata.ts`, add:

```ts
import type { DocumentStore } from './stores/document-store'

export function deriveHierarchicalName(
  subject: string,
  docStore: DocumentStore,
  kind: 'broadcast' | 'dm',
): string | null {
  if (!subject.startsWith('tinstar.')) return null
  const parts = subject.split('.')
  // Expected: tinstar.<space>.<init>.<epic>.<task>[.<session>]
  if (kind === 'dm') {
    const session = parts[parts.length - 1]
    return session ? `DM → ${session}` : null
  }
  // broadcast: last segment is the task token (sanitized name).
  // Look up tasks under the active space and find one whose sanitized name matches.
  const taskToken = parts[parts.length - 1]
  if (!taskToken) return null
  const tasks = docStore.getAllTasks().filter(t => sanitize(t.name) === taskToken)
  const task = tasks[0]
  if (!task) return `Task: ${taskToken}` // fallback if no entity match
  return `Task: ${task.name}`
}

function sanitize(s: string): string {
  return s.replace(/\s+/g, '-').replace(/[.>*]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

export function bootstrapHierarchicalTopicMetadata(
  subjects: string[],
  sessionName: string,
  docStore: DocumentStore,
): void {
  if (subjects.length === 0) return
  // Two-tier subscription model: [broadcast, dm]
  const [broadcast, dm] = subjects
  const now = new Date().toISOString()
  if (broadcast && !docStore.getTopicMetadata(broadcast)) {
    docStore.upsertTopicMetadata(broadcast, {
      subject: broadcast,
      name: deriveHierarchicalName(broadcast, docStore, 'broadcast') ?? undefined,
      kind: 'broadcast',
      createdAt: now,
      createdBy: sessionName,
    })
  }
  if (dm && dm !== broadcast && !docStore.getTopicMetadata(dm)) {
    docStore.upsertTopicMetadata(dm, {
      subject: dm,
      name: deriveHierarchicalName(dm, docStore, 'dm') ?? undefined,
      kind: 'dm',
      createdAt: now,
      createdBy: sessionName,
    })
  }
}
```

(Cross-check `sanitize` against `sanitizeSubjectToken` in `src/server/sessions/nats-subscriptions.ts:113`. If they're identical, import that function instead of re-implementing.)

Remove the stub `deriveHierarchicalName` from routes.ts — replace with an import:
```ts
import { deriveHierarchicalName, bootstrapHierarchicalTopicMetadata } from '../topic-metadata'
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Wire into session-create sites**

In `src/server/api/routes.ts`, find each site that calls `registerSaloonSubs(...)` for a NEW session (the same 3 sites from the Saloon plan: ~line 512 `createSessionInternal`, ~line 2227 POST `/api/sessions`, ~line 2727 spawn-hand). At each site, immediately after `registerSaloonSubs`, add:

```ts
bootstrapHierarchicalTopicMetadata(resolvedNats?.subscriptions ?? [], name, ctx.docStore)
```

(Use the local variable name in scope — `name`, `childName`, etc. — for the second argument.)

- [ ] **Step 6: Typecheck + tests**

```bash
npx tsc --noEmit && npx vitest run src/server/
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): bootstrap topic metadata at session create

Every NATS-enabled session-create now writes TopicMetadata records
for its broadcast subject and DM inbox. Names are derived ONCE at
write time from the entity tree's current state — never re-derived
on read. The refresh endpoint added in Task 2 now has its
deriveHierarchicalName helper wired in (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Bootstrap metadata at breakout-room create

**Files:**
- Modify: `src/server/api/routes.ts` (around `breakoutRoom = ...` at ~line 2557)

- [ ] **Step 1: Locate the breakout-creation site**

```bash
grep -n "tinstar.room\|breakoutRoom = natsConfig" src/server/api/routes.ts
```

Expected: one hit around line 2557 where `breakoutRoom = natsConfig?.enabled ? \`tinstar.room.${randomUUID().slice(0, 8)}\` : null`.

- [ ] **Step 2: Add the bootstrap call**

After the breakout room is committed to the parent's session record (find where `natsConfig.subscriptions.push(breakoutRoom)` happens — same Task-3-Saloon-plan site at line 2683), add:

```ts
ctx.docStore.upsertTopicMetadata(breakoutRoom, {
  subject: breakoutRoom,
  name: `${hand} with ${parentName}`,
  kind: 'breakout',
  createdAt: new Date().toISOString(),
  createdBy: parentName,
})
```

- `hand` is the hand-type string from the spawn request (already in scope at this site — verify with a quick grep).
- `parentName` is the parent session's name (also already in scope as `parentName`).

- [ ] **Step 3: Test it manually**

```bash
TINSTAR_FAST_SIM=1 npm run dev
```

In another terminal:
```bash
curl -X POST http://localhost:5280/api/sessions/<some-session>/spawn \
  -H 'Content-Type: application/json' \
  -d '{"hand":"rubberduck","prompt":"hi"}' | jq .data.breakoutRoom
# copy the returned subject, then:
curl http://localhost:5280/api/topics/<urlencoded-subject> | jq .
# expect: { ok: true, data: { subject, name: 'rubberduck with ...', kind: 'breakout', participants: [parent, child] } }
```

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): record breakout-room metadata at spawn time

Every breakout room minted by /spawn now gets a TopicMetadata record
with kind='breakout', a friendly name like 'rubberduck with natsViz',
and createdAt/createdBy. Replaces the opaque hex hash in the Saloon
panel with something a human can recognize (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Frontend state slice + delta handling

**Files:**
- Modify: `src/hooks/useBackendState.ts`, `src/hooks/useServerEvents.ts`

- [ ] **Step 1: Add the state slice**

In `src/hooks/useBackendState.ts`, find where `natsTrafficWidgets` lives (~line 18, 33). Mirror the pattern:

```ts
// in the BackendState type:
  topicMetadata: TopicMetadata[]

// in the initial state:
  topicMetadata: [],

// also import the type at the top:
import type { TopicMetadata } from '../domain/types'
```

In the snapshot-application path of the same file (look for `state.natsTrafficWidgets = snapshot.natsTrafficWidgets` or similar — likely around the snapshot-event handler), add a parallel line:

```ts
  state.topicMetadata = snapshot.topicMetadata ?? []
```

- [ ] **Step 2: Handle the SSE delta**

In `src/hooks/useServerEvents.ts`, find the existing `if (delta.entity === '<x>')` chain (e.g. line 211 for `editorWidget`). Add a new branch right after the natsTrafficWidget branch:

```ts
  if (delta.entity === 'topicMetadata') {
    setState(prev => {
      if (delta.data === null) {
        return { ...prev, topicMetadata: prev.topicMetadata.filter(m => m.subject !== delta.id) }
      }
      const incoming = delta.data as TopicMetadata
      const others = prev.topicMetadata.filter(m => m.subject !== incoming.subject)
      return { ...prev, topicMetadata: [...others, incoming] }
    })
    return
  }
```

(Match the file's existing setState/dispatch convention — copy the shape from the `natsTrafficWidget` branch, don't invent a new pattern.)

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): wire topicMetadata into frontend state + SSE deltas

Mirrors the existing natsTrafficWidget plumbing — snapshot ingest at
connect, delta handling on every change. UI consumers can now read
topic metadata from useBackendState (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `useTopicMetadata` selector hook

**Files:**
- Create: `src/components/RunWorkspaceWidget/saloon/useTopicMetadata.ts`
- Test: `src/components/RunWorkspaceWidget/saloon/__tests__/useTopicMetadata.test.tsx`

- [ ] **Step 1: Write the failing test**

Create the test file:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTopicMetadata } from '../useTopicMetadata'
import type { TopicMetadata } from '../../../../domain/types'

vi.mock('../../../../hooks/useBackendState', () => ({
  useBackendState: () => ({
    topicMetadata: [
      { subject: 'tinstar.x', name: 'Renamed X', kind: 'broadcast', createdAt: '' } as TopicMetadata,
    ],
  }),
}))

describe('useTopicMetadata', () => {
  it('returns the metadata record for a known subject', () => {
    const { result } = renderHook(() => useTopicMetadata('tinstar.x'))
    expect(result.current?.name).toBe('Renamed X')
  })

  it('returns undefined for an unknown subject', () => {
    const { result } = renderHook(() => useTopicMetadata('tinstar.unknown'))
    expect(result.current).toBeUndefined()
  })
})
```

Verify the import path of `useBackendState` against the actual location (`src/hooks/useBackendState.ts`). Adjust the relative path if the spec test directory differs.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement the hook**

Create `src/components/RunWorkspaceWidget/saloon/useTopicMetadata.ts`:

```ts
import { useBackendState } from '../../../hooks/useBackendState'
import type { TopicMetadata } from '../../../domain/types'

export function useTopicMetadata(subject: string): TopicMetadata | undefined {
  const { topicMetadata } = useBackendState()
  return topicMetadata.find(m => m.subject === subject)
}
```

(If `useBackendState` is named differently — e.g. `useDocStore`, `useTinstarState` — substitute. Verify by `grep export src/hooks/useBackendState.ts`.)

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): add useTopicMetadata selector hook

Returns the TopicMetadata record for a given subject from the live
backend state. Reactive — re-renders when SSE deltas update the
record (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: SubscriptionsList — friendly name + tooltip + inline rename

**Files:**
- Modify: `src/components/RunWorkspaceWidget/saloon/SubscriptionsList.tsx`
- Modify: `src/components/RunWorkspaceWidget/saloon/__tests__/SubscriptionsList.test.tsx`

- [ ] **Step 1: Update tests for the new behavior**

Open `src/components/RunWorkspaceWidget/saloon/__tests__/SubscriptionsList.test.tsx`. Add a `vi.mock('../useTopicMetadata', ...)` block at the top so test rows have predictable metadata. Then add:

```tsx
import { vi } from 'vitest'
vi.mock('../useTopicMetadata', () => ({
  useTopicMetadata: (subject: string) => {
    if (subject === 'tinstar.a.b.c') return { subject, name: 'Friendly Broadcast', kind: 'broadcast', createdAt: '' }
    if (subject === 'tinstar.room.r1')  return { subject, name: 'Rubberduck Room',  kind: 'breakout', createdAt: '' }
    return undefined
  },
}))

it('renders metadata.name when present, raw shortSubject otherwise', () => {
  const { container } = render(
    <SubscriptionsList
      sessionName="natsViz"
      subscriptions={['tinstar.a.b.c', 'tinstar.room.r1', 'tinstar.no.metadata']}
      mutedSet={new Set()}
      onToggleMute={() => {}}
    />,
  )
  expect(container.textContent).toContain('Friendly Broadcast')
  expect(container.textContent).toContain('Rubberduck Room')
  // Falls back to short-subject form for the unknown one
  expect(container.textContent).toMatch(/no\.metadata|…\.metadata/)
})

it('clicking the pencil icon switches to inline rename input', () => {
  const { container } = render(
    <SubscriptionsList
      sessionName="natsViz"
      subscriptions={['tinstar.a.b.c']}
      mutedSet={new Set()}
      onToggleMute={() => {}}
    />,
  )
  const editBtn = container.querySelector('[data-testid="saloon-rename"]')
  expect(editBtn).toBeTruthy()
  fireEvent.click(editBtn!)
  const input = container.querySelector('input[data-testid="saloon-rename-input"]') as HTMLInputElement
  expect(input).toBeTruthy()
  expect(input.value).toBe('Friendly Broadcast')
})
```

- [ ] **Step 2: Run — expect failure on the new cases**

```bash
npx vitest run src/components/RunWorkspaceWidget/saloon/__tests__/SubscriptionsList.test.tsx
```

- [ ] **Step 3: Update the component**

In `src/components/RunWorkspaceWidget/saloon/SubscriptionsList.tsx`, replace the existing implementation with:

```tsx
import { useState } from 'react'
import { classifySubject, type SubjectRole } from './subjectRole'
import { useTopicMetadata } from './useTopicMetadata'

interface Props {
  sessionName: string
  subscriptions: string[]
  mutedSet: Set<string>
  onToggleMute: (subject: string) => void
}

const ROLE_COLOR: Record<SubjectRole, string> = {
  broadcast: 'text-cyan-400 border-cyan-400/40',
  dm: 'text-amber-400 border-amber-400/40',
  breakout: 'text-violet-400 border-violet-400/40',
}

export function SubscriptionsList({ sessionName, subscriptions, mutedSet, onToggleMute }: Props) {
  if (subscriptions.length === 0) {
    return (
      <div className="px-2 py-3 text-2xs font-mono text-slate-700 text-center">
        No subscriptions yet
      </div>
    )
  }
  return (
    <div>
      {subscriptions.map(subject => (
        <SubscriptionRow
          key={subject}
          subject={subject}
          sessionName={sessionName}
          muted={mutedSet.has(subject)}
          onToggleMute={onToggleMute}
        />
      ))}
    </div>
  )
}

interface RowProps {
  subject: string
  sessionName: string
  muted: boolean
  onToggleMute: (s: string) => void
}

function SubscriptionRow({ subject, sessionName, muted, onToggleMute }: RowProps) {
  const role = classifySubject(subject, sessionName)
  const md = useTopicMetadata(subject)
  const display = md?.name ?? shortSubject(subject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(display)

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(md?.name ?? '')
    setEditing(true)
  }
  const submit = async () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (!trimmed || trimmed === md?.name) return
    try {
      await fetch(`/api/topics/${encodeURIComponent(subject)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
    } catch { /* SSE will reconcile */ }
  }
  const cancel = () => { setEditing(false); setDraft(md?.name ?? '') }

  const tooltip = [
    `Subject: ${subject}`,
    `Role: ${role}`,
    md?.description ? `${md.description}` : null,
    md?.createdAt ? `Created: ${md.createdAt}` : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      data-testid="saloon-topic"
      data-role={role}
      data-muted={muted ? 'true' : 'false'}
      title={tooltip}
      onClick={() => !editing && onToggleMute(subject)}
      className={`group flex items-center gap-1 px-2 py-1 text-2xs font-mono truncate border-l-2 cursor-pointer hover:bg-primary/5 transition-opacity ${ROLE_COLOR[role]} ${muted ? 'opacity-40' : ''}`}
    >
      {editing ? (
        <input
          data-testid="saloon-rename-input"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') cancel()
          }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-surface-base text-slate-200 outline-none px-1 rounded"
        />
      ) : (
        <span className="flex-1 truncate">{display}</span>
      )}
      {!editing && (
        <button
          data-testid="saloon-rename"
          onClick={startRename}
          className="opacity-0 group-hover:opacity-100 transition-opacity material-symbols-outlined text-xs"
          title="Rename"
        >edit</button>
      )}
      {muted && (
        <span className="material-symbols-outlined text-xs">visibility_off</span>
      )}
    </div>
  )
}

function shortSubject(s: string): string {
  const parts = s.split('.')
  if (parts.length <= 3) return s
  return '…' + parts.slice(-2).join('.')
}
```

- [ ] **Step 4: Run tests — expect PASS for both old and new cases**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): friendly names + inline rename in SubscriptionsList

Topic rows now show metadata.name when present (with raw subject in
the tooltip). Hovering reveals an edit pencil; clicking it swaps to
an inline input that PATCHes the rename on Enter/blur. SSE
reconciles all clients (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: StreamView — friendly name in subject column + filter matches name

**Files:**
- Modify: `src/components/RunWorkspaceWidget/saloon/StreamView.tsx`
- Modify: `src/components/RunWorkspaceWidget/saloon/__tests__/StreamView.test.tsx`

- [ ] **Step 1: Update tests**

In the existing `StreamView.test.tsx`, mock `useTopicMetadata` the same way as Task 7 did:

```tsx
vi.mock('../useTopicMetadata', () => ({
  useTopicMetadata: (subject: string) =>
    subject === 'tinstar.a.b.c'
      ? { subject, name: 'Renamed Broadcast', kind: 'broadcast', createdAt: '' }
      : undefined,
}))
```

Add a new test:

```tsx
it('renders metadata.name in the subject column when present', () => {
  const { container } = render(
    <StreamView sessionName="natsViz" events={events} mutedSet={new Set()} onUnmuteAll={() => {}} />,
  )
  expect(container.textContent).toContain('Renamed Broadcast')
})

it('filter matches against name as well as subject and body', () => {
  const { container, getByPlaceholderText } = render(
    <StreamView sessionName="natsViz" events={events} mutedSet={new Set()} onUnmuteAll={() => {}} />,
  )
  fireEvent.change(getByPlaceholderText(/filter/i), { target: { value: 'renamed' } })
  const rows = container.querySelectorAll('[data-testid="saloon-msg"]')
  // exactly the events whose subject is 'tinstar.a.b.c'
  expect(rows.length).toBe(events.filter(e => e.subject === 'tinstar.a.b.c').length)
})
```

- [ ] **Step 2: Update the implementation**

In `StreamView.tsx`:

a. Import the hook at the top:
```ts
import { useTopicMetadata } from './useTopicMetadata'
```

b. Inside the component, the events-list rendering currently calls `classifySubject(e.subject, sessionName)` and `shortSubject(e.subject)` per row. Refactor the per-row render into a small inner component `StreamRow` so it can call the hook (hooks can't run inside `.map` conditionally):

```tsx
function StreamRow({ event, sessionName, needle }: { event: SaloonEvent; sessionName: string; needle: string }) {
  const role = classifySubject(event.subject, sessionName)
  const md = useTopicMetadata(event.subject)
  const display = md?.name ?? shortSubject(event.subject)
  return (
    <div
      data-testid="saloon-msg"
      className={`px-2 py-1 border-b border-white/5 border-l-2 ${ROLE_BORDER[role]} text-2xs font-mono`}
    >
      <div className="flex gap-1 items-baseline">
        <span className="text-[9px] text-slate-600 shrink-0">{formatTime(event.timestamp)}</span>
        <span className="flex-1 min-w-0 truncate text-slate-400" title={event.subject}>
          {highlight(display, needle)}
        </span>
      </div>
      <div className="truncate text-slate-500" title={event.data}>
        {highlight(event.data, needle)}
      </div>
    </div>
  )
}
```

Replace the inline map body with `<StreamRow key={i} event={e} sessionName={sessionName} needle={needle} />`.

c. The filter `visible` computation must also match the metadata name. Hooks can't be called per-iteration inside `useMemo`, so do the lookup eagerly: pass `topicMetadata` from the top-level state into the StreamView's filter via a new `useBackendState()` call, and adjust the filter:

```ts
import { useBackendState } from '../../../hooks/useBackendState'

// ... inside StreamView:
const { topicMetadata } = useBackendState()
const nameByEvent = useMemo(() => {
  const map = new Map<string, string | undefined>()
  for (const m of topicMetadata) map.set(m.subject, m.name)
  return map
}, [topicMetadata])

const visible = useMemo(() => {
  return events.filter(e => {
    if (mutedSet.has(e.subject)) return false
    if (!needle) return true
    const subjectLower = e.subject.toLowerCase()
    const dataLower = e.data.toLowerCase()
    const nameLower = (nameByEvent.get(e.subject) ?? '').toLowerCase()
    return subjectLower.includes(needle) || dataLower.includes(needle) || nameLower.includes(needle)
  })
}, [events, mutedSet, needle, nameByEvent])
```

- [ ] **Step 3: Run tests — expect PASS**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(saloon): friendly names in StreamView + filter matches name

Stream rows render metadata.name in the subject column when present.
Filter input now matches against subject OR body OR name, so renamed
breakouts are searchable by their new name (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: E2E smoke test

**Files:**
- Create: `e2e/topic-metadata.spec.ts`

- [ ] **Step 1: Write the test**

Create `e2e/topic-metadata.spec.ts`:

```ts
import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Topic metadata', () => {
  test.beforeEach(async ({ page }) => {
    await resetAndWaitForData(page)
  })

  test('PATCHing a topic name surfaces it in the Saloon panel', async ({ page, request, baseURL }) => {
    // 1. Find a session with NATS-enabled subscriptions in the e2e harness.
    //    Pick the first run; assume it has at least one subscription.
    await page.locator('[data-testid^="canvas-widget-run-"]').first().click()

    // 2. Read its first subscription subject from the Saloon DOM.
    const firstTopic = page.getByTestId('saloon-topic').first()
    await expect(firstTopic).toBeVisible()
    const subject = await firstTopic.getAttribute('title') // tooltip starts with "Subject: ..."
    expect(subject).toContain('Subject:')

    // 3. PATCH the topic with a friendly name via the API.
    const realSubject = subject!.split('\n')[0].replace('Subject: ', '').trim()
    const r = await request.patch(`/api/topics/${encodeURIComponent(realSubject)}`, {
      data: { name: 'E2E renamed topic' },
    })
    expect(r.ok()).toBe(true)

    // 4. The Saloon row should pick it up via SSE within a few seconds.
    await expect(firstTopic).toContainText('E2E renamed topic', { timeout: 5000 })
  })

  test('inline rename via UI propagates and persists', async ({ page }) => {
    await page.locator('[data-testid^="canvas-widget-run-"]').first().click()
    const firstTopic = page.getByTestId('saloon-topic').first()
    await firstTopic.hover()
    await page.getByTestId('saloon-rename').first().click()
    const input = page.getByTestId('saloon-rename-input')
    await input.fill('inline-renamed')
    await input.press('Enter')
    await expect(firstTopic).toContainText('inline-renamed', { timeout: 5000 })
  })
})
```

If the e2e harness's runs don't have NATS enabled (the Saloon spec called out `TINSTAR_NO_SESSIONS=1`), this test may need `test.skip()` for the rename cases — or create a session via the API first. The first task on encountering an empty Saloon should be to skip and document, not silently pass.

- [ ] **Step 2: Verify the spec lists**

```bash
npx playwright test --list e2e/topic-metadata.spec.ts
```

Expected: 2 tests discovered.

- [ ] **Step 3: Run the suite**

```bash
npx playwright test e2e/topic-metadata.spec.ts 2>&1 | tail -20
```

If both pass, great. If they fail because the harness doesn't surface NATS subscriptions, mark `test.skip()` with a reference to the Saloon-plan note about needing simulator-emitted subs, and document.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(saloon): e2e smoke for topic metadata rename

Verifies that PATCH /api/topics/<subject> surfaces in the Saloon row
within ~5s via SSE, and that the inline-rename UI flow PATCHes
correctly and propagates back. If the harness lacks NATS-enabled
subscriptions today, tests are skipped with a note (#topic-metadata).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review summary

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| `TopicMetadata` data model | Task 1 |
| Storage in docStore + persistence | Task 1 |
| `topicParticipants` (derived) | Task 2 |
| GET / GET-single / PATCH / refresh routes | Task 2, refresh stub filled in by Task 3 |
| Bootstrap on session-create | Task 3 |
| Bootstrap on breakout-create | Task 4 |
| Frontend state slice + delta handling | Task 5 |
| `useTopicMetadata` hook | Task 6 |
| SubscriptionsList rendering + inline rename | Task 7 |
| StreamView rendering + filter matches name | Task 8 |
| SSE-broadcast renames | Tasks 1+2 (docStore changes auto-flow via `sse.ts:14-39`) + Task 5 (frontend ingest) |
| E2E smoke | Task 9 |

**Type consistency:** `TopicMetadata` shape (subject/name/description/kind/createdAt/createdBy) matches across server type, route handlers, frontend type, and component props. `topicParticipants` and `joinParticipants` signatures match between Task 2 implementation and Task 2 routes. `kind` literal union matches in every place (`'broadcast' | 'dm' | 'breakout' | 'custom'`).

**Placeholder scan:** No TBDs / TODOs. Every code step shows the actual code. Verification commands include their expected output. Two places explicitly call out grep-then-mirror (Task 2 sessionsDir field name, Task 3 sanitize re-use) — those are deliberate "verify before assuming" guards, not placeholders.
