---
title: "feat: Star / Hide / Reorder Projects"
date: 2026-07-07
type: feat
origin: docs/superpowers/specs/2026-07-07-project-star-hide-reorder-design.md
branch: feat/project-star-hide-reorder
status: ready
---

# feat: Star / Hide / Reorder Projects

## Summary

The project list has outgrown a flat, insertion-ordered map. This plan adds three
controls — **star**, **hide/unhide**, and **drag-to-reorder** — all living in
**Settings > Projects**. The New Session and Entity Settings pickers (native
`<select>`s) consume the new state: hidden projects are filtered out, the rest are
sorted by an explicit `order`, and starred projects surface in a `★ Favorites`
`<optgroup>` on top.

The enabling change is a data-model migration: `projects.json` values move from a
bare path `string` to an object `{ path, starred, hidden, order }`, with a
read-time normalizer that keeps legacy string files working until first write.

Origin design doc (approved): `docs/superpowers/specs/2026-07-07-project-star-hide-reorder-design.md`.

---

## Problem Frame

Projects appear in four surfaces — Settings, the New Session modal picker, the
Entity Settings picker, and onboarding — and every surface renders the raw
`projects.json` map with no way to prioritize, remove-without-deleting, or order
entries. As the list grows the pickers become unusable. There is currently no
star, hidden, or order field anywhere on a project (confirmed: value type is
`Record<string, string>` in `src/server/sessions/workspace.ts:98`).

---

## Requirements

- **R1** — A project can be starred/unstarred; starred projects surface first
  (a `★ Favorites` group) in the New Session and Entity pickers.
- **R2** — A project can be hidden/unhidden; hidden projects are excluded from
  both pickers and from onboarding, but remain visible (dimmed) in Settings.
- **R3** — Projects can be drag-reordered in Settings; the order persists and is
  honored by the pickers (within each of the Favorites / non-Favorites groups).
- **R4** — All three controls live in Settings only. Pickers stay native
  `<select>` (no per-row controls in the modal).
- **R5** — Legacy `projects.json` files (string values) keep working; a
  mixed old/new file reads correctly; first write upgrades to the object form.
- **R6** — Session-creation callers that read a project path are unaffected
  (`getProject` still returns the path string).

---

## Key Technical Decisions

- **KTD1 — Evolve the value type, no parallel store.** `projects.json` value
  becomes `{ path, starred, hidden, order }` rather than a sibling
  `project-meta.json`. Single source of truth; matches the project's
  "all config in one store" rule. Cost: a read-time normalizer shim. *(see
  origin)*
- **KTD2 — Explicit integer `order`.** Ordering is stored as an `order` field,
  not implied by JSON key order, so it survives object-key reshuffling and JSON
  round-trips.
- **KTD3 — `getProject` stays path-returning.** Internal reads of `.path` keep
  the session-creation call sites untouched (R6).
- **KTD4 — `GET /api/projects` keeps the `name → value` map shape**, with richer
  values. Consumers change field *access* (`d.data[name].path`), not their
  iteration (`Object.entries`), minimizing client churn.
- **KTD5 — Native HTML5 drag-and-drop** for the Settings reorder list
  (`draggable` + `onDragStart`/`onDragOver`/`onDrop`). No new dependency.
- **KTD6 — Optimistic client updates.** Star/hide flip local state immediately
  then `PATCH`; drop reorders locally then `PUT`s; revert on non-2xx. Matches
  the snappy-UI rule.
- **KTD7 — Reorder rejects unknown names, appends omitted ones.** `PUT
  /api/projects/order` returns `400` if the array names a project absent from
  `projects.json` (catches drift); a known project omitted from the array is
  appended after the listed ones in prior relative order (defensive).

---

## High-Level Technical Design

Data shape and flow across the layers:

```
projects.json (on disk)
  legacy:  { "tinstar": "/repo/tinstar" }
  new:     { "tinstar": { path, starred, hidden, order } }
        │
        ▼  readJsonFile → normalizeProjects()  (legacy string → object, order by file position)
  workspace.ts  ── listProjects() : Record<name, ProjectMeta>
                ── getProject()   : string (path)      ← callers unchanged
                ── setProjectFlag(name,{starred?,hidden?})
                ── reorderProjects(names[])
        │
        ▼  routes.ts
  GET   /api/projects              → Record<name, ProjectMeta>
  PATCH /api/projects/:name        {starred?,hidden?}   → broadcast projects_changed
  PUT   /api/projects/order        {order: string[]}    → broadcast projects_changed
        │
        ▼  clients (consume; SettingsDialog also mutates)
  CreateSessionDialog / EntitySettingsDialog / onboarding:
        filter !hidden → sort by order → ★ Favorites optgroup + Projects optgroup
  SettingsDialog:
        drag-reorder list · ★/☆ star · 👁/🕶 hide (dimmed inline) · × delete
```

The `ProjectMeta` type (`{ path: string; starred: boolean; hidden: boolean; order: number }`)
is the shared contract. Directional guidance, not a literal signature.

---

## Implementation Units

### U1. Data model: `ProjectMeta` type, normalizer, and flag/reorder mutators

**Goal:** Evolve the project registry from `Record<string,string>` to a
normalized object model with back-compat reads and new mutators. Foundation for
everything else.

**Requirements:** R1, R2, R3, R5, R6.

**Dependencies:** none.

**Files:**
- `src/server/sessions/workspace.ts` — modify (types, normalizer, mutators)
- `src/server/sessions/__tests__/workspace.projects.test.ts` — create (unit tests)

**Approach:**
- Define `ProjectMeta = { path: string; starred: boolean; hidden: boolean; order: number }`.
- Change the on-disk read type to `Record<string, string | Partial<ProjectMeta> & { path: string }>`.
  Add `normalizeProjects(raw): Record<string, ProjectMeta>`: for each entry, if
  the value is a `string`, expand to `{ path: value, starred: false, hidden:
  false, order: <index in Object.keys> }`; if an object, fill missing
  `starred`/`hidden` with `false` and missing `order` with its file position.
- `listProjects` returns the normalized map. `getProject` returns `.path`
  (string) or `null` — signature unchanged (KTD3, R6).
- `registerProject(file, name, path)`: preserve existing flags/order if the name
  already exists (only update `path`); for a new name, append with
  `order = max(existing order) + 1`, `starred:false`, `hidden:false`. Writes the
  full normalized map (upgrades legacy files on first write, R5).
- `unregisterProject` unchanged in behavior (delete key), but operates on the
  normalized map.
- Add `setProjectFlag(file, name, flags: { starred?: boolean; hidden?: boolean }): ProjectMeta | null`
  — normalize, return `null` if name absent, else apply provided flags, write,
  return updated meta.
- Add `reorderProjects(file, names: string[]): { ok: true } | { ok: false; unknown: string[] }`
  — normalize; if any name in `names` is absent from the map, return
  `{ ok:false, unknown }` (KTD7); else assign `order` by array index, then
  append any map names omitted from `names` after the listed ones preserving
  their prior relative order, write, return `{ ok:true }`.
- `writeJsonFile` type widens to the object map.

**Patterns to follow:** existing `readJsonFile`/`writeJsonFile`/`registerProject`
structure in `src/server/sessions/workspace.ts:96-132`. Test file structure of
`src/server/api/__tests__/workspaceFile.test.ts`.

**Test scenarios** (`src/server/sessions/__tests__/workspace.projects.test.ts`):
- Legacy all-string file → `listProjects` returns objects with `order` matching
  file position, `starred:false`, `hidden:false`. (Covers R5.)
- Mixed old-string + new-object file reads correctly; missing fields defaulted.
- New-object file round-trips unchanged.
- `getProject` returns the path string for both legacy and new forms; `null` for
  unknown name. (Covers R6.)
- `setProjectFlag` sets starred on/off and hidden on/off independently; unknown
  name → `null`; partial flags leave the other flag untouched.
- `reorderProjects` reassigns `order` to match array index.
- `reorderProjects` with a name not in the file → `{ ok:false, unknown:[...] }`,
  file unchanged. (Covers KTD7.)
- `reorderProjects` with a known name omitted from the array → omitted name
  appended after listed ones, stable relative order.
- `registerProject` on an existing name preserves its flags/order, updates path
  only; on a new name appends with `order = max+1`.
- Any mutator writing a legacy file upgrades all entries to object form on disk.

**Verification:** unit suite passes; a legacy `projects.json` read then written
back is fully object-form and preserves paths.

---

### U2. Server routes: `PATCH /api/projects/:name`, `PUT /api/projects/order`, richer `GET`

**Goal:** Expose the new mutators over HTTP and enrich `GET` to return
`ProjectMeta`.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U1.

**Files:**
- `src/server/api/routes.ts` — modify (projects route block ~4357-4408)
- `src/server/api/__tests__/projectRoutes.test.ts` — create (if route-level
  tests are feasible in-harness; otherwise rely on U1 unit coverage + U6 e2e)

**Approach:**
- `GET /api/projects` now returns `listProjects()` (already the normalized map —
  no code change beyond the type flowing through). (KTD4)
- Add `PUT /api/projects/order` **before** the generic `/api/projects/:name`
  handlers. Parse body `{ order: string[] }`; `400` if not an array; call
  `reorderProjects`; on `{ ok:false }` → `400` with the unknown names; on success
  broadcast `projects_changed` (`{ action: 'reorder' }`) and `ok(res, null)`.
- Add `PATCH /api/projects/:name`. Parse body `{ starred?, hidden? }`; `400` if
  neither key present; decode `:name`; call `setProjectFlag`; `null` → `404`;
  else broadcast `projects_changed` (`{ action: 'update', name }`) and return the
  updated meta.
- Reuse the existing `readBody`/`withBody`, `ok`, `fail` helpers and the
  `projects_changed` SSE broadcast already used by POST/DELETE.
- Guard route ordering so `PUT /api/projects/order` isn't captured by a
  `:name`-style matcher (distinct method from PATCH/DELETE, but keep `order`
  matched explicitly).

**Patterns to follow:** existing POST/DELETE project handlers
`src/server/api/routes.ts:4365-4408` (body parsing, `broadcastEvent('projects_changed', …)`, `ok`/`fail`).

**Test scenarios:**
- `PATCH` with `{starred:true}` on a known project → `200`, returns meta with
  `starred:true`, emits `projects_changed`.
- `PATCH` with empty body → `400`.
- `PATCH` on unknown name → `404`.
- `PUT /order` with valid full array → `200`, order applied.
- `PUT /order` with a non-array body → `400`.
- `PUT /order` naming an unknown project → `400`.

  *If the route harness can't exercise these directly, mark this file
  `Test expectation: covered by U1 unit tests + U6 e2e` and rely on those.*

**Verification:** `curl`/e2e round-trip flips a flag and reorders; other clients
see the change via SSE.

---

### U3. New Session picker: filter hidden, sort by order, Favorites optgroup

**Goal:** The New Session modal `<select>` reflects hidden/order/starred.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U2 (needs `GET` returning `ProjectMeta`).

**Files:**
- `src/components/CreateSessionDialog.tsx` — modify (project state shape + option build, ~lines 65, 87-96, 253-274)

**Approach:**
- Update the fetched project state type to carry `{ name, path, starred, hidden, order }`
  (read from `d.data[name]`).
- Build options: drop `hidden`, sort by `order` ascending, partition into starred
  vs not. Render starred inside `<optgroup label="★ Favorites">` and the rest
  inside `<optgroup label="Projects">`. Preserve the existing "None" and
  "+ Add project" (`__add__`) options and the inline-add handler.
- No star/hide controls here (R4).

**Patterns to follow:** existing option-mapping and `__add__` handling in
`src/components/CreateSessionDialog.tsx:253-304`.

**Test scenarios:** covered by U6 e2e (star→appears under Favorites; hide→absent;
reorder→order reflected). `Test expectation: none at unit level -- presentation
wiring, exercised by U6.`

**Verification:** in `TINSTAR_FAST_SIM=1` dev, starred projects show under
Favorites, hidden ones are gone, order matches Settings.

---

### U4. Entity Settings picker: same filter/sort/optgroup treatment

**Goal:** Keep the second project picker consistent with the New Session picker.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U2.

**Files:**
- `src/components/EntitySettingsDialog.tsx` — modify (project state + `<select>`, ~lines 74, 90-96, 262)

**Approach:** mirror U3 — update the fetched shape, filter hidden, sort by order,
emit the same two optgroups. No controls added.

**Patterns to follow:** U3; existing select at `src/components/EntitySettingsDialog.tsx:262`.

**Test scenarios:** `Test expectation: none at unit level -- presentation wiring
mirroring U3; spot-checked manually and via U6 where the entity picker is
reachable.`

**Verification:** the entity picker shows the same filtered, ordered, grouped
list as the New Session picker.

---

### U5. Settings > Projects: drag-reorder list with star + hide controls

**Goal:** The management surface — reorder by drag, star toggle, hide toggle
(dimmed inline), delete retained; optimistic updates.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U2.

**Files:**
- `src/components/SettingsDialog.tsx` — modify (projects section, list render
  ~293-330, add form ~333, fetch ~96-113)

**Approach:**
- Update `interface Project` (line 15) to `{ name, path, starred, hidden, order }`;
  `fetchProjects` reads the richer map.
- Sort the rendered list by `order`. Each row: drag handle (☰), star toggle
  (★/☆), name, path, hide toggle (👁 shown / 🕶 hidden), delete (×). Hidden rows
  render dimmed (reduced opacity / muted) but stay in position and remain
  draggable.
- Drag-reorder via native HTML5 events (`draggable`, `onDragStart`,
  `onDragOver` preventDefault, `onDrop`): compute the new name order, optimistically
  set local state, `PUT /api/projects/order`; revert on failure. (KTD5, KTD6)
- Star/hide: optimistic local flip → `PATCH /api/projects/:name` with the changed
  flag; revert on failure. (KTD6)
- Retain add-project form and delete handler; after add/delete, refetch or apply
  the SSE `projects_changed` update already wired via `windowEvents`.
- Use theme palette classes only (avoid phantom Tailwind classes;
  `npm run lint` guards this).

**Patterns to follow:** existing projects list + `handleDelete`/`handleAdd` in
`src/components/SettingsDialog.tsx:131-330`; optimistic-update + error-inline
style already used for add/delete.

**Test scenarios:** interaction-heavy; primary coverage via U6 e2e. At unit level:
`Test expectation: none -- DnD + optimistic UI, covered by U6 e2e.` (If a small
pure helper is extracted for "compute new order after drop", add a unit test for
it: dropping index i onto j yields the expected name sequence, including no-op
drops and edge indices.)

**Verification:** drag reorders and persists across reload; star moves a project
into Favorites in the picker; hide dims it here and removes it from the picker.

---

### U6. Onboarding parity + Playwright e2e

**Goal:** Onboarding uses the new shape and the same filter/sort; end-to-end
coverage of the three behaviors.

**Requirements:** R1, R2, R3, R5.

**Dependencies:** U3, U4, U5.

**Files:**
- `src/components/onboarding/FirstSessionStep.tsx` — modify (field access `.path`, filter hidden, sort by order)
- `src/hooks/useOnboardingState.ts` — modify (project shape access, ~lines 45-63)
- `e2e/project-star-hide-reorder.spec.ts` — create (Playwright)

**Approach:**
- Onboarding: read `.path` from the object shape; apply hidden-filter + order-sort
  so onboarding shows the same list. No new controls.
- e2e (`TINSTAR_FAST_SIM=1`): drive Settings to star, hide, and reorder, then
  assert the New Session picker and reload persistence.

**Patterns to follow:** existing specs under `e2e/`; onboarding project usage in
`src/components/onboarding/FirstSessionStep.tsx` and `src/hooks/useOnboardingState.ts`.

**Test scenarios** (`e2e/project-star-hide-reorder.spec.ts`):
- Star a project in Settings → it appears under the `★ Favorites` optgroup in the
  New Session picker. (Covers R1.)
- Hide a project → absent from the New Session picker; rendered dimmed in
  Settings; unhide restores it in both. (Covers R2.)
- Drag-reorder two projects in Settings → new order persists after reload and is
  reflected in the picker order. (Covers R3.)
- (If feasible) a seeded legacy string-form project still loads and is
  star/hide/reorder-able. (Covers R5.)

**Verification:** `TINSTAR_FAST_SIM=1 npx playwright test project-star-hide-reorder`
passes; onboarding still lists projects correctly.

---

## Scope Boundaries

**In scope:** star, hide/unhide, drag-reorder; data-model migration; the four
consuming surfaces (Settings, New Session picker, Entity picker, onboarding).

**Out of scope / non-goals:**
- Custom popover dropdown with per-row star buttons in the New Session modal
  (pickers stay native `<select>`; explicitly decided in origin).
- Per-user / multi-profile project state (`projects.json` stays machine-global).

### Deferred to Follow-Up Work
- If the Settings reorder DnD proves fiddly across browsers, extracting a shared
  reorderable-list component (used elsewhere in the app) could follow — not
  required here.

---

## System-Wide Impact

- **Data migration is forward-only and lazy:** legacy files keep working on read;
  the first write upgrades them. No separate migration step or downtime. A user
  who downgrades after an upgrade would find object-form values — acceptable
  since the old reader did `JSON.parse` and used the string directly; note this
  is a one-way upgrade.
- **SSE `projects_changed`** already fans out to all clients; the two new
  mutations reuse it, so open Settings dialogs and pickers refresh live.
- Four client surfaces read the project shape; all are updated in U3–U6 to avoid
  a half-migrated read (`d.data[name]` is now an object, so any missed consumer
  would render `[object Object]` — the review must confirm all four are covered).

---

## Risks & Dependencies

- **R-risk1 — Missed consumer of the old string shape.** Any un-updated reader of
  `GET /api/projects` breaks (object where a string was expected). *Mitigation:*
  U3–U6 enumerate all four known consumers; code review greps for
  `/api/projects` and `d.data` project reads.
- **R-risk2 — Native HTML5 DnD quirks** (drag image, `onDragOver` preventDefault
  required to allow drop). *Mitigation:* follow standard pattern; U6 e2e asserts
  reorder persistence; keyboard-accessible fallback is out of scope but noted.
- **R-risk3 — Route ordering** for `PUT /api/projects/order` vs `:name` matching.
  *Mitigation:* distinct HTTP methods; match `order` explicitly first.
- **Dependency:** all client units depend on U2's enriched `GET`.

---

## Sources & Research

- Origin design doc: `docs/superpowers/specs/2026-07-07-project-star-hide-reorder-design.md`.
- Current registry: `src/server/sessions/workspace.ts:96-132`.
- Current routes: `src/server/api/routes.ts:4357-4408`.
- Consumers: `src/components/SettingsDialog.tsx`, `src/components/CreateSessionDialog.tsx`,
  `src/components/EntitySettingsDialog.tsx`, `src/components/onboarding/FirstSessionStep.tsx`,
  `src/hooks/useOnboardingState.ts`.
- Testing/lint gotchas (from `CLAUDE.md` / project memory): type-check with
  `tsc -p tsconfig.app.json`; Vitest with `--exclude='e2e/**'`; `npm run lint`
  catches phantom Tailwind classes; frontend changes need a `vite build` +
  hard-reload to see on the standalone :5273.
