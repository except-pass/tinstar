# Entity Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users rename, re-icon, and control the count (1–3) of their hierarchy levels per space, replacing the hardcoded Initiative/Epic/Task labels.

**Architecture:** Add `labelConfig` to the `Space` record; derive `dimensions[]` and display labels from it at runtime via a `useDimensionMeta()` hook. The Settings dialog gets an "Entity Labels" tab. `GroupingControls` is deleted; its job moves to Settings.

**Tech Stack:** React + TypeScript, Vite, Tailwind. No unit test runner — use `npx tsc --noEmit` for type safety and the running dev server for smoke tests. Playwright e2e at the end.

**Spec:** `docs/superpowers/specs/2026-03-20-entity-labels-design.md`

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `src/domain/types.ts` | Modify | Add `LevelLabel`, `SpaceLabelConfig`, extend `Space` |
| `src/domain/dimension-meta.ts` | Modify | Export `DEFAULT_LEVELS`; keep static functions for non-hook contexts |
| `src/hooks/useDimensionMeta.ts` | **Create** | Hook + `autoPlural` util |
| `src/server/api/routes.ts` | Modify | Validate `labelConfig` in `PATCH /api/spaces/:id` |
| `src/components/WorkspaceShell.tsx` | Modify | Derive `dimensions` from space; localStorage migration; remove GroupingControls |
| `src/components/GroupingControls.tsx` | **Delete** | Replaced by Settings tab |
| `src/components/HierarchySidebar.tsx` | Modify | `getDimensionIcon` → `useDimensionMeta()` |
| `src/components/CreateEntityDialog.tsx` | Modify | `getDimensionLabel` → `useDimensionMeta()` |
| `src/widgets/taskGroup/TaskGroupWidget.tsx` | Modify | `getDimensionIcon` → `useDimensionMeta()` |
| `src/components/SettingsDialog.tsx` | Modify | Add Entity Labels tab |

---

## Task 1: Extend types

**Files:**
- Modify: `src/domain/types.ts:42-46`
- Modify: `src/domain/dimension-meta.ts`

- [ ] **Step 1: Add types to `src/domain/types.ts`**

After the existing `Space` interface (line 42), add:

```ts
export interface LevelLabel {
  icon: string
  label: string
  plural?: string
}

export interface SpaceLabelConfig {
  levels: LevelLabel[]  // length 1–3, top-to-bottom
}
```

Extend `Space`:
```ts
export interface Space {
  id: string
  name: string
  createdAt: string
  labelConfig?: SpaceLabelConfig
}
```

- [ ] **Step 2: Export DEFAULT_LEVELS from `src/domain/dimension-meta.ts`**

Add above the `DIMENSION_REGISTRY` export:
```ts
import type { LevelLabel } from './types'

export const DEFAULT_LEVELS: LevelLabel[] = [
  { icon: '🚀', label: 'Initiative' },
  { icon: '🏔️', label: 'Epic' },
  { icon: '🗂️', label: 'Task' },
]
```

- [ ] **Step 3: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**
```bash
git add src/domain/types.ts src/domain/dimension-meta.ts
git commit -m "feat: add LevelLabel, SpaceLabelConfig types and DEFAULT_LEVELS"
```

---

## Task 2: Create `useDimensionMeta` hook

**Files:**
- Create: `src/hooks/useDimensionMeta.ts`

- [ ] **Step 1: Create the file**

```ts
// src/hooks/useDimensionMeta.ts
import { useMemo } from 'react'
import type { LevelLabel } from '../domain/types'
import { DEFAULT_LEVELS } from '../domain/dimension-meta'
import { useBackendState } from './useBackendState'

export interface LevelMeta {
  internalType: 'initiative' | 'epic' | 'task'
  label: string
  plural: string
  icon: string
  index: number
}

const INTERNAL_TYPES: ('initiative' | 'epic' | 'task')[] = ['initiative', 'epic', 'task']

export function autoPlural(word: string): string {
  if (!word) return ''
  if (word.match(/[sxz]$/i) || word.match(/[cs]h$/i)) return word + 'es'
  if (word.match(/[^aeiou]y$/i)) return word.slice(0, -1) + 'ies'
  return word + 's'
}

function resolveLevels(levels: LevelLabel[]): LevelMeta[] {
  // levels.length 1–3; always maps to bottom N of ['initiative','epic','task']
  const offset = INTERNAL_TYPES.length - levels.length
  return levels.map((lvl, i) => ({
    internalType: INTERNAL_TYPES[offset + i]!,
    label: lvl.label,
    plural: lvl.plural?.trim() || autoPlural(lvl.label),
    icon: lvl.icon,
    index: i,
  }))
}

export function useDimensionMeta(): LevelMeta[] {
  const { spaces, activeSpaceId } = useBackendState()
  return useMemo(() => {
    const space = spaces.find(s => s.id === activeSpaceId)
    const levels = space?.labelConfig?.levels
    if (!levels || levels.length === 0) return resolveLevels(DEFAULT_LEVELS)
    return resolveLevels(levels)
  }, [spaces, activeSpaceId])
}

/** Non-hook version for components that receive LevelMeta[] as a prop */
export function resolveStaticMeta(levels?: LevelLabel[]): LevelMeta[] {
  return resolveLevels(levels && levels.length > 0 ? levels : DEFAULT_LEVELS)
}
```

- [ ] **Step 2: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**
```bash
git add src/hooks/useDimensionMeta.ts
git commit -m "feat: add useDimensionMeta hook with autoPlural"
```

---

## Task 3: Backend validation for `PATCH /api/spaces/:id`

**Files:**
- Modify: `src/server/api/routes.ts:323-334`

- [ ] **Step 1: Add validation helper and update the handler**

Replace the existing PATCH handler (lines 323–334) with:

```ts
// PATCH /api/spaces/:id
if (method === 'PATCH' && url.startsWith('/api/spaces/') && !url.includes('/activate')) {
  const id = url.slice('/api/spaces/'.length)
  readBody(req).then(body => {
    const existing = ctx.docStore.getSpace(id)
    if (!existing) return json(res, { error: 'not found' }, 404)
    const patch = JSON.parse(body)

    // Validate labelConfig if present
    if (patch.labelConfig !== undefined) {
      const levels = patch.labelConfig?.levels
      if (!Array.isArray(levels) || levels.length < 1 || levels.length > 3) {
        return json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'labelConfig.levels must be an array of length 1–3' } }, 400)
      }
      for (const lvl of levels) {
        if (typeof lvl.label !== 'string' || !lvl.label.trim()) {
          return json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'Each level must have a non-empty label' } }, 400)
        }
        if (typeof lvl.icon !== 'string' || !lvl.icon.trim()) {
          return json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'Each level must have a non-empty icon' } }, 400)
        }
      }
    }

    ctx.docStore.upsertSpace(id, { ...existing, ...patch })
    json(res, { ok: true, data: ctx.docStore.getSpace(id) })
  })
  return true
}
```

- [ ] **Step 2: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Smoke test the validation**

Start dev server if not running: `npm run dev`

```bash
# Should fail with 400
curl -s http://localhost:5273/api/spaces/$(curl -s http://localhost:5273/api/spaces | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])") \
  -X PATCH -H "Content-Type: application/json" \
  -d '{"labelConfig":{"levels":[]}}' | python3 -m json.tool

# Should succeed
curl -s http://localhost:5273/api/spaces/$(curl -s http://localhost:5273/api/spaces | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])") \
  -X PATCH -H "Content-Type: application/json" \
  -d '{"labelConfig":{"levels":[{"icon":"🚀","label":"Initiative"},{"icon":"🏔️","label":"Epic"},{"icon":"🗂️","label":"Task"}]}}' | python3 -m json.tool
```

Expected: first returns `400` with error message; second returns `{ ok: true, data: { ... labelConfig: { levels: [...] } } }`

- [ ] **Step 4: Commit**
```bash
git add src/server/api/routes.ts
git commit -m "feat: validate labelConfig in PATCH /api/spaces/:id"
```

---

## Task 4: WorkspaceShell — derive dimensions from labelConfig + localStorage migration

**Files:**
- Modify: `src/components/WorkspaceShell.tsx`

This task removes the `tinstar-dimensions` localStorage handling, derives `dimensions` from the active space's `labelConfig`, performs the one-time migration, and removes `GroupingControls`.

- [ ] **Step 1: Update imports at top of WorkspaceShell.tsx**

Remove:
```ts
import { GroupingControls } from './GroupingControls'
```

Add:
```ts
import { useDimensionMeta } from '../hooks/useDimensionMeta'
import type { LevelLabel } from '../domain/types'
import { DEFAULT_LEVELS } from '../domain/dimension-meta'
```

- [ ] **Step 2: Replace the `dimensions` state and migration logic**

Remove the entire existing `dimensions` useState block (lines 55–62):
```ts
// REMOVE THIS:
const [dimensions, setDimensions] = useState<GroupingDimension[]>(...)
```

Replace with a derived value after `useBackendState()`:
```ts
const levelMeta = useDimensionMeta()
const dimensions = useMemo(
  () => levelMeta.map(m => m.internalType),
  [levelMeta],
)
```

- [ ] **Step 3: Add localStorage migration effect**

Add this `useEffect` after the `dimensions` derivation:

```ts
// One-time migration: promote tinstar-dimensions localStorage → space.labelConfig
useEffect(() => {
  if (!activeSpaceId) return
  const activeSpace = spaces.find(s => s.id === activeSpaceId)
  if (!activeSpace || activeSpace.labelConfig) return  // already migrated

  const stored = localStorage.getItem('tinstar-dimensions')
  let count = 3
  try {
    const parsed = JSON.parse(stored ?? '[]') as string[]
    if (parsed.length >= 1 && parsed.length <= 3) count = parsed.length
  } catch { /* ignore */ }

  // Use bottom-N defaults matching the stored count
  const levels: LevelLabel[] = DEFAULT_LEVELS.slice(DEFAULT_LEVELS.length - count)

  fetch(`/api/spaces/${activeSpaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelConfig: { levels } }),
  }).then(r => {
    if (r.ok) localStorage.removeItem('tinstar-dimensions')
    else console.warn('[tinstar] labelConfig migration failed; will retry on next load')
  }).catch(() => {
    console.warn('[tinstar] labelConfig migration failed; will retry on next load')
  })
}, [activeSpaceId, spaces])
```

- [ ] **Step 4: Remove `handleDimensionsChange` and its localStorage.setItem call**

Remove:
```ts
const handleDimensionsChange = useCallback((dims: GroupingDimension[]) => {
  setDimensions(dims)
  localStorage.setItem('tinstar-dimensions', JSON.stringify(dims))
}, [])
```

- [ ] **Step 5: Remove GroupingControls from JSX**

In the top bar JSX, remove the entire `<GroupingControls ... />` block and `onDimensionsChange` prop.

- [ ] **Step 6: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors (there may be unused variable warnings if `handleDimensionsChange` was referenced elsewhere — clean those up)

- [ ] **Step 7: Commit**
```bash
git add src/components/WorkspaceShell.tsx
git commit -m "feat: derive dimensions from space.labelConfig, remove GroupingControls, localStorage migration"
```

---

## Task 5: Delete GroupingControls

**Files:**
- Delete: `src/components/GroupingControls.tsx`

- [ ] **Step 1: Delete the file**
```bash
rm src/components/GroupingControls.tsx
```

- [ ] **Step 2: Check nothing else imports it**
```bash
grep -r "GroupingControls" src/
```
Expected: no results

- [ ] **Step 3: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**
```bash
git commit -m "feat: delete GroupingControls (replaced by Settings Entity Labels tab)"
```

---

## Task 6: Update call sites — HierarchySidebar, CreateEntityDialog, TaskGroupWidget

**Files:**
- Modify: `src/components/HierarchySidebar.tsx`
- Modify: `src/components/CreateEntityDialog.tsx`
- Modify: `src/widgets/taskGroup/TaskGroupWidget.tsx`

### HierarchySidebar

- [ ] **Step 1: Add `useDimensionMeta` to HierarchySidebar**

Add import:
```ts
import { useDimensionMeta } from '../hooks/useDimensionMeta'
```

In the `HierarchySidebar` component (the outer/main one), call the hook and build a lookup map:
```ts
const levelMeta = useDimensionMeta()
const dimensionIconMap = useMemo(
  () => Object.fromEntries(levelMeta.map(m => [m.internalType, m.icon])),
  [levelMeta],
)
```

Pass `dimensionIconMap` down as a prop to `SidebarNode` (or pass `levelMeta` and build the map inside). Then in `SidebarNode`, replace:
```ts
// BEFORE:
getDimensionIcon(node.type)

// AFTER:
dimensionIconMap[node.type as GroupingDimension] ?? getDimensionIcon(node.type)
```

Do this for both call sites in HierarchySidebar (the node row icon and the drag ghost icon at line 743).

Remove the `getDimensionIcon` import if no longer used directly.

### CreateEntityDialog

- [ ] **Step 2: Update CreateEntityDialog**

Add import:
```ts
import { useDimensionMeta } from '../hooks/useDimensionMeta'
```

Replace:
```ts
// BEFORE:
const label = getDimensionLabel(dialog.childType)

// AFTER:
const levelMeta = useDimensionMeta()
const label = levelMeta.find(m => m.internalType === dialog.childType)?.label
  ?? dialog.childType
```

Remove the `getDimensionLabel` import.

### TaskGroupWidget

- [ ] **Step 3: Update TaskGroupWidget**

Add import:
```ts
import { useDimensionMeta } from '../../hooks/useDimensionMeta'
```

Replace:
```ts
// BEFORE:
const icon = getDimensionIcon(node.type as GroupingDimension)

// AFTER:
const levelMeta = useDimensionMeta()
const icon = levelMeta.find(m => m.internalType === node.type)?.icon
  ?? getDimensionIcon(node.type as GroupingDimension)
```

Keep the `getDimensionIcon` import as a fallback for worktree/run types not in levelMeta.

- [ ] **Step 4: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 5: Smoke test**

With dev server running, verify:
- Sidebar shows initiative/epic/task icons as before
- Canvas container headers show correct icons
- "New Initiative" dialog title still reads "New Initiative"

- [ ] **Step 6: Commit**
```bash
git add src/components/HierarchySidebar.tsx src/components/CreateEntityDialog.tsx src/widgets/taskGroup/TaskGroupWidget.tsx
git commit -m "feat: replace getDimensionIcon/Label with useDimensionMeta at all call sites"
```

---

## Task 7: Entity Labels tab in SettingsDialog

**Files:**
- Modify: `src/components/SettingsDialog.tsx`

This is the main UI task. Add an "Entity Labels" tab with the level editor.

- [ ] **Step 1: Add tab type and state to SettingsDialog**

At the top of `SettingsDialog`, change the `Section` type:
```ts
type Section = 'projects' | 'docker' | 'editor' | 'labels'
```

Add state and imports:
```ts
import { useDimensionMeta, autoPlural } from '../hooks/useDimensionMeta'
import { useBackendState } from '../hooks/useBackendState'
import type { LevelLabel } from '../domain/types'

// Inside SettingsDialog component:
const { activeSpaceId, spaces } = useBackendState()
const activeSpace = spaces.find(s => s.id === activeSpaceId)
const currentMeta = useDimensionMeta()

const [labelLevels, setLabelLevels] = useState<LevelLabel[]>(() =>
  currentMeta.map(m => ({ icon: m.icon, label: m.label, plural: '' }))
)
const [labelsDirty, setLabelsDirty] = useState(false)
const [labelsSaving, setLabelsSaving] = useState(false)
```

- [ ] **Step 2: Add the save handler**

```ts
const handleSaveLabels = useCallback(async () => {
  if (!activeSpaceId) return
  setLabelsSaving(true)
  try {
    const res = await fetch(`/api/spaces/${activeSpaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelConfig: { levels: labelLevels } }),
    })
    if (res.ok) setLabelsDirty(false)
  } finally {
    setLabelsSaving(false)
  }
}, [activeSpaceId, labelLevels])

const handleResetLabels = useCallback(() => {
  setLabelLevels([
    { icon: '🚀', label: 'Initiative' },
    { icon: '🏔️', label: 'Epic' },
    { icon: '🗂️', label: 'Task' },
  ])
  setLabelsDirty(true)
}, [])
```

- [ ] **Step 3: Add the "Entity Labels" tab button to the sidebar nav**

Find where the existing section nav buttons are rendered (the Projects / Docker / Editor section links). Add:
```tsx
<button
  className={`text-left px-3 py-1.5 rounded text-sm ${activeSection === 'labels' ? 'bg-primary/20 text-primary' : 'text-slate-400 hover:text-slate-200'}`}
  onClick={() => scrollTo('labels')}
>
  Entity Labels
</button>
```

- [ ] **Step 4: Add the Entity Labels section content**

Add a `labelsRef` and wire up `scrollTo('labels')`. Then in the main scroll area, add the section:

```tsx
{/* Entity Labels section */}
<div ref={labelsRef} className="mb-8">
  <div className="flex items-center justify-between mb-4">
    <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">Entity Labels</h3>
    {activeSpace && (
      <span className="text-xs text-slate-500 bg-surface-raised border border-white/7 rounded px-2 py-0.5">
        {activeSpace.name}
      </span>
    )}
  </div>

  {/* Column headers */}
  <div className="flex items-center gap-2 px-3 mb-1 text-2xs text-slate-600 uppercase tracking-wide">
    <span style={{minWidth:44}}>Level</span>
    <span style={{width:30}}>Icon</span>
    <span className="flex-1">Singular</span>
    <span style={{width:96}}>Plural</span>
    <span style={{width:20}}></span>
  </div>

  {/* Level rows */}
  <div className="flex flex-col gap-1.5">
    {labelLevels.map((lvl, i) => {
      const isLeaf = i === labelLevels.length - 1
      return (
        <div key={i} className="flex items-center gap-2 px-3 py-2 bg-surface-raised border border-white/7 rounded-md">
          <span className="text-2xs text-slate-500 font-mono" style={{minWidth:44}}>
            Level {i + 1}{isLeaf && <span className="text-green-500 ml-1">●</span>}
          </span>
          {/* Icon picker — simple emoji input */}
          <input
            className="w-8 h-7 text-center bg-surface-panel border border-white/10 rounded text-base cursor-pointer"
            value={lvl.icon}
            maxLength={2}
            onChange={e => {
              const next = [...labelLevels]
              next[i] = { ...next[i]!, icon: e.target.value }
              setLabelLevels(next)
              setLabelsDirty(true)
            }}
            title="Click to change icon (paste any emoji)"
          />
          {/* Singular */}
          <input
            className="flex-1 bg-surface-panel border border-white/10 rounded px-2 py-1 text-xs text-slate-200 focus:border-primary/50 outline-none"
            value={lvl.label}
            placeholder="Label"
            onChange={e => {
              const next = [...labelLevels]
              next[i] = { ...next[i]!, label: e.target.value }
              setLabelLevels(next)
              setLabelsDirty(true)
            }}
          />
          {/* Plural */}
          <input
            className="bg-surface-panel border border-white/10 rounded px-2 py-1 text-xs text-slate-400 focus:border-primary/50 outline-none"
            style={{width:96}}
            value={lvl.plural ?? ''}
            placeholder={autoPlural(lvl.label) || 'auto'}
            onChange={e => {
              const next = [...labelLevels]
              next[i] = { ...next[i]!, plural: e.target.value }
              setLabelLevels(next)
              setLabelsDirty(true)
            }}
          />
          {/* Remove button — only non-leaf */}
          <button
            className={`text-xs w-5 h-5 flex items-center justify-center rounded transition-colors ${!isLeaf && labelLevels.length > 1 ? 'text-slate-500 hover:text-red-400 hover:bg-red-400/10' : 'opacity-0 pointer-events-none'}`}
            onClick={() => {
              if (isLeaf || labelLevels.length <= 1) return
              setLabelLevels(labelLevels.filter((_, j) => j !== i))
              setLabelsDirty(true)
            }}
            aria-label="Remove level"
          >✕</button>
        </div>
      )
    })}
  </div>

  {/* Add level button */}
  {labelLevels.length < 3 && (
    <button
      className="mt-2 w-full py-2 text-xs text-slate-500 border border-dashed border-white/10 rounded-md hover:text-slate-300 hover:border-white/20 transition-colors"
      onClick={() => {
        setLabelLevels([{ icon: '📦', label: 'Group', plural: '' }, ...labelLevels])
        setLabelsDirty(true)
      }}
    >
      + Add level above leaf
    </button>
  )}

  <p className="text-2xs text-slate-600 mt-3">
    Labels apply to this space only. Plural is auto-computed if left blank. No data migration needed.
  </p>

  {/* Footer actions */}
  <div className="flex items-center justify-between mt-4">
    <button
      className="text-2xs text-slate-600 underline decoration-slate-700 hover:text-slate-400"
      onClick={handleResetLabels}
    >
      Reset to defaults
    </button>
    <button
      className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/35 rounded hover:bg-primary/30 disabled:opacity-40 disabled:cursor-default transition-colors"
      disabled={!labelsDirty || labelsSaving}
      onClick={handleSaveLabels}
    >
      {labelsSaving ? 'Saving…' : 'Save'}
    </button>
  </div>
</div>
```

- [ ] **Step 5: Type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Smoke test the UI**

With dev server running:
1. Click the gear icon → Settings dialog opens
2. Click "Entity Labels" tab
3. Change "Initiative" to "Client" → Save
4. Close dialog — sidebar should now show "CLIENT" section header and 🚀 Client nodes
5. Re-open Settings → label shows "Client"
6. Reset to defaults → "Initiative" restored after Save

- [ ] **Step 7: Commit**
```bash
git add src/components/SettingsDialog.tsx
git commit -m "feat: Entity Labels tab in SettingsDialog with add/remove/rename per-space levels"
```

---

## Task 8: E2E test

**Files:**
- Create: `e2e/entity-labels.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// e2e/entity-labels.spec.ts
import { test, expect } from '@playwright/test'

test('can rename a hierarchy level and see it in the sidebar', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('sidebar-slot')).toBeVisible()

  // Open settings
  await page.getByTestId('settings-btn').click()

  // Navigate to Entity Labels tab
  await page.getByRole('button', { name: 'Entity Labels' }).click()

  // Change "Initiative" to "Client"
  const singularInputs = page.locator('input[placeholder="Label"]')
  await singularInputs.first().fill('Client')

  // Save
  await page.getByRole('button', { name: 'Save' }).click()
  await page.keyboard.press('Escape')

  // Sidebar should reflect new label
  await expect(page.locator('[data-testid="sidebar-slot"]')).toContainText('Client')
})

test('can remove a level and tree re-groups', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('settings-btn').click()
  await page.getByRole('button', { name: 'Entity Labels' }).click()

  // Remove Level 1 (✕ on first non-leaf row)
  const removeBtns = page.locator('button[aria-label="Remove level"]')
  await removeBtns.first().click()

  // Now only 2 levels shown — Save
  await page.getByRole('button', { name: 'Save' }).click()
  await page.keyboard.press('Escape')

  // Sidebar should NOT contain initiative-level grouping
  await expect(page.locator('[data-testid="sidebar-slot"]')).not.toContainText('Initiatives')
})
```

- [ ] **Step 2: Run the tests**
```bash
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test e2e/entity-labels.spec.ts
```
Expected: both tests pass

- [ ] **Step 3: Commit**
```bash
git add e2e/entity-labels.spec.ts
git commit -m "test: e2e tests for entity labels rename and level removal"
```

---

## Task 9: Final type check, build, and PR

- [ ] **Step 1: Full type check**
```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 2: Production build**
```bash
npm run build:all
```
Expected: completes without errors

- [ ] **Step 3: Final smoke test**

Verify end-to-end in the browser:
- Space A: rename to Client/Project/Ticket, set 3 levels → labels appear everywhere
- Space B: 2 levels → sidebar shows only 2 grouping levels
- `tinstar-dimensions` localStorage key is gone after first load per space

- [ ] **Step 4: Commit package.json if version was bumped, then push and PR**
```bash
git push origin HEAD
gh pr create --title "feat: configurable entity labels per space" \
  --body "Closes the entity labels feature. Users can rename, re-icon, and set 1–3 hierarchy levels per space from Settings → Entity Labels." \
  --base main
```
