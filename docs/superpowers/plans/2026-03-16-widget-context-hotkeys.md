# Widget Contract + Contextual Hotkeys + Sidebar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WidgetDefinition contract, a focus-path-based context router for chord hotkeys, a per-widget action dispatch system, CSS flourish animations, and a resizable/hideable hotkeys sidebar showing context-aware bindings.

**Architecture:** New `FocusPathContext` (separate from `SelectionProvider`) tracks `canvas → widget → sub-element` navigation depth. A global keydown listener routes keypresses through tier-1 (reserved), tier-2 (widget-scoped), and tier-3 (canvas-root) bindings declared in `widgetRegistry`. The existing `useGlobalHotkeys` and `useCanvasHotkeys` are kept for their tier-1 reserved keys; `useWidgetHotkeys` is retired and its bindings migrate into a `run-workspace` WidgetDefinition dispatched via `actionHandlerRegistry`.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v3, Playwright (E2E)

**Spec:** `docs/superpowers/specs/2026-03-16-widget-context-hotkeys-design.md`

---

## File Map

**Create:**
- `src/hotkeys/widgetTypes.ts` — WidgetDefinition, WidgetContext, Binding interfaces
- `src/hotkeys/widgetRegistry.ts` — singleton type→WidgetDefinition map + registerWidget/getWidget
- `src/hotkeys/actionHandlerRegistry.ts` — widgetId→handler dispatch map
- `src/hotkeys/FocusPathContext.tsx` — FocusPathContext + FocusPathProvider + useFocusPath + useWidgetFocus + useHotkeyContext
- `src/hotkeys/contextRouter.ts` — pure resolveBindings + useContextRouter global listener hook
- `src/hotkeys/useFlourish.ts` — CSS animation helper hook
- `src/hotkeys/widgets/canvasWidget.ts` — canvas WidgetDefinition
- `src/hotkeys/widgets/runWorkspaceWidget.ts` — run-workspace WidgetDefinition
- `src/hotkeys/widgets/groupContainerWidget.ts` — group-container WidgetDefinition
- `src/components/HotkeysSidebar.tsx` — resizable/hideable right sidebar

**Modify:**
- `tailwind.config.ts` — add ignite + full-hit + scan-one-shot + ripple-ring keyframes/animations
- `src/components/WorkspaceShell.tsx` — add FocusPathProvider, useContextRouter, HotkeysSidebar; remove ActiveScopeProvider; sync selectedRunId with FocusPathContext
- `src/components/RunWorkspaceWidget/index.tsx` — register actionHandler, remove useWidgetHotkeys, add flourish
- `src/components/InfiniteCanvas.tsx` — flourish on widget select
- `src/components/HotkeyPalette.tsx` — switch from HOTKEYS/useActiveScope to widgetRegistry

**Delete (after migration):**
- `src/hotkeys/ActiveScopeContext.tsx`
- `src/hotkeys/registry.ts`
- `src/hotkeys/useWidgetHotkeys.ts`

---

## Chunk 1: Foundation — Types, Registries, FocusPathContext

### Task 1: Widget types interface

**Files:**
- Create: `src/hotkeys/widgetTypes.ts`

- [ ] **Step 1: Create widgetTypes.ts**

```typescript
// src/hotkeys/widgetTypes.ts

export interface Binding {
  /** e.code-based key string, e.g. 'KeyS', 'Backslash', 'Ctrl+Backslash' */
  key: string
  /** Human-readable label shown in sidebar, e.g. 'Enter terminal' */
  label: string
  /** Action identifier dispatched to the widget instance */
  action: string
  /** If true: only shown during chord state */
  chord?: boolean
}

export interface WidgetContext {
  /** e.code-based key that navigates into this context */
  key: string
  /** Human-readable label, e.g. 'Terminal', 'Files' */
  label: string
  /** Sub-widget type that becomes active */
  type: string
  /** If true: sets chordState instead of pushing focus path */
  transient?: boolean
}

export interface WidgetDefinition {
  /** e.g. 'run-workspace' | 'group-container' | 'canvas' */
  type: string
  /** Shown in sidebar header */
  displayName: string
  /** Navigable sub-elements this widget exposes */
  contexts: WidgetContext[]
  /** Direct actions when this widget is the active focus */
  bindings: Binding[]
}

/**
 * Focus zones within RunWorkspaceWidget — kept here so RunWorkspaceWidget
 * can import it after useWidgetHotkeys.ts is deleted.
 */
export type FocusZone = 'left-tab' | 'file-list' | 'center-tabs' | 'right-panel'
```

- [ ] **Step 2: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors (new file, no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/widgetTypes.ts
git commit -m "feat: add WidgetDefinition, WidgetContext, Binding types #widget-hotkeys"
```

---

### Task 2: Widget registry

**Files:**
- Create: `src/hotkeys/widgetRegistry.ts`

- [ ] **Step 1: Create widgetRegistry.ts**

```typescript
// src/hotkeys/widgetRegistry.ts
import type { WidgetDefinition } from './widgetTypes'

// Tier-1 reserved keys — exact e.code format strings (+ modifier prefix)
// Any WidgetDefinition binding/context key matching one of these throws at registration.
const RESERVED_KEYS = new Set([
  'Backquote',           // ` root key
  'BracketLeft',         // [ cycle prev
  'BracketRight',        // ] cycle next
  'Shift+BracketLeft',   // Shift+[ cycle all prev
  'Shift+BracketRight',  // Shift+] cycle all next
  '?',                   // open palette (e.key '?' fires as Shift+Slash but checked as '?')
  'Ctrl+Enter',          // new session
  'KeyS',                // quick session
  'Ctrl+KeyG',           // arrange grid
  'Ctrl+Shift+KeyG',     // arrange reset
  'Ctrl+Digit1', 'Ctrl+Digit2', 'Ctrl+Digit3', 'Ctrl+Digit4', 'Ctrl+Digit5',
  'Ctrl+Digit6', 'Ctrl+Digit7', 'Ctrl+Digit8', 'Ctrl+Digit9', 'Ctrl+Digit0',
  'Ctrl+Shift+Digit1', 'Ctrl+Shift+Digit2', 'Ctrl+Shift+Digit3', 'Ctrl+Shift+Digit4', 'Ctrl+Shift+Digit5',
  'Ctrl+Shift+Digit6', 'Ctrl+Shift+Digit7', 'Ctrl+Shift+Digit8', 'Ctrl+Shift+Digit9', 'Ctrl+Shift+Digit0',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
])

const registry = new Map<string, WidgetDefinition>()

export function registerWidget(def: WidgetDefinition): void {
  // 1. Duplicate type check
  if (registry.has(def.type)) {
    throw new Error(`[widgetRegistry] duplicate widget type: "${def.type}"`)
  }

  // 2. Reserved key check
  const allKeys = [
    ...def.bindings.map(b => b.key),
    ...def.contexts.map(c => c.key),
  ]
  for (const key of allKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[widgetRegistry] widget "${def.type}" claims reserved key "${key}"`
      )
    }
  }

  // 3. Intra-definition conflict check
  const bindingKeys = new Set(def.bindings.map(b => b.key))
  for (const ctx of def.contexts) {
    if (bindingKeys.has(ctx.key)) {
      throw new Error(
        `[widgetRegistry] widget "${def.type}" key "${ctx.key}" appears in both contexts and bindings`
      )
    }
  }

  registry.set(def.type, def)
}

export function getWidget(type: string): WidgetDefinition | undefined {
  return registry.get(type)
}

export function getAllWidgets(): WidgetDefinition[] {
  return [...registry.values()]
}

/** For testing only — clears the registry */
export function _clearRegistry(): void {
  registry.clear()
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/widgetRegistry.ts
git commit -m "feat: add widget registry with validation #widget-hotkeys"
```

---

### Task 3: Action handler registry

**Files:**
- Create: `src/hotkeys/actionHandlerRegistry.ts`

- [ ] **Step 1: Create actionHandlerRegistry.ts**

```typescript
// src/hotkeys/actionHandlerRegistry.ts

type ActionHandler = (action: string) => void

const handlers = new Map<string, ActionHandler>()

export function registerActionHandler(widgetId: string, fn: ActionHandler): void {
  handlers.set(widgetId, fn)
}

export function deregisterActionHandler(widgetId: string): void {
  handlers.delete(widgetId)
}

export function dispatchAction(widgetId: string, action: string): void {
  handlers.get(widgetId)?.(action)
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/actionHandlerRegistry.ts
git commit -m "feat: add action handler registry for widget action dispatch #widget-hotkeys"
```

---

### Task 4: FocusPathContext

**Files:**
- Create: `src/hotkeys/FocusPathContext.tsx`

- [ ] **Step 1: Create FocusPathContext.tsx**

```typescript
// src/hotkeys/FocusPathContext.tsx
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import { getWidget } from './widgetRegistry'
import type { WidgetDefinition } from './widgetTypes'

export interface FocusNode {
  id: string
  type: string
  label: string
}

interface FocusPathState {
  path: FocusNode[]
  chordState: { contextId: string } | null
}

interface FocusPathContextValue extends FocusPathState {
  pushFocus: (node: FocusNode) => void
  clearFocus: () => void
  setChord: (contextId: string) => void
  clearChord: () => void
}

const FocusPathContext = createContext<FocusPathContextValue>({
  path: [],
  chordState: null,
  pushFocus: () => {},
  clearFocus: () => {},
  setChord: () => {},
  clearChord: () => {},
})

export function FocusPathProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<FocusNode[]>([])
  const [chordState, setChordState] = useState<{ contextId: string } | null>(null)

  const pushFocus = useCallback((node: FocusNode) => {
    setPath(prev => [...prev, node])
  }, [])

  const clearFocus = useCallback(() => {
    setPath([])
    setChordState(null)
  }, [])

  const setChord = useCallback((contextId: string) => {
    setChordState({ contextId })
  }, [])

  const clearChord = useCallback(() => {
    setChordState(null)
  }, [])

  return (
    <FocusPathContext.Provider value={{ path, chordState, pushFocus, clearFocus, setChord, clearChord }}>
      {children}
    </FocusPathContext.Provider>
  )
}

export function useFocusPath() {
  return useContext(FocusPathContext)
}

/**
 * Per-widget hook: returns the active sub-context key for this widget instance,
 * or null if not focused or no sub-context active.
 * Usage: const { activeContextKey } = useWidgetFocus(run.id)
 */
export function useWidgetFocus(widgetId: string): { activeContextKey: string | null } {
  const { path } = useFocusPath()
  const activeContextKey = useMemo(() => {
    const myIdx = path.findIndex(n => n.id === widgetId)
    if (myIdx === -1) return null
    const subNode = path[myIdx + 1]
    return subNode?.type ?? null
  }, [path, widgetId])
  return { activeContextKey }
}

/**
 * Composite hook for HotkeysSidebar: returns focus path, chord state,
 * and the active WidgetDefinition (canvas def when path is empty).
 */
export function useHotkeyContext(): {
  path: FocusNode[]
  chordState: { contextId: string } | null
  activeDefinition: WidgetDefinition | null
} {
  const { path, chordState } = useFocusPath()
  const activeDefinition = useMemo(() => {
    if (path.length === 0) return getWidget('canvas') ?? null
    const tail = path[path.length - 1]!
    return getWidget(tail.type) ?? null
  }, [path])
  return { path, chordState, activeDefinition }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/FocusPathContext.tsx
git commit -m "feat: add FocusPathContext with push/clear/chord state and useWidgetFocus/useHotkeyContext hooks #widget-hotkeys"
```

---

## Chunk 2: Context Router + Flourish Animations

### Task 5: Context router

**Files:**
- Create: `src/hotkeys/contextRouter.ts`

The router is a global `window` keydown listener. It handles:
- Backtick root key (clears focus path)
- Tier-2/3 context navigation and binding dispatch
It does NOT re-handle tier-1 reserved keys — those stay in `useGlobalHotkeys` and `useCanvasHotkeys`.

- [ ] **Step 1: Create contextRouter.ts**

```typescript
// src/hotkeys/contextRouter.ts
import { useEffect, useRef } from 'react'
import { isEditable } from './isEditable'
import { getWidget } from './widgetRegistry'
import { dispatchAction } from './actionHandlerRegistry'
import type { FocusNode } from './FocusPathContext'

/** Normalise a KeyboardEvent to the canonical "Modifier+Code" string format */
export function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.code)
  return parts.join('+')
}

interface RouterHandlers {
  path: FocusNode[]
  chordState: { contextId: string } | null
  pushFocus: (node: FocusNode) => void
  clearFocus: () => void
  setChord: (contextId: string) => void
  clearChord: () => void
  /** Called when a context navigation or widget selection fires (triggers Hollywood Hit) */
  onNavigate?: (targetId: string) => void
  /** Called when a chord binding fires (triggers Scan Line) */
  onChordAction?: (targetId: string) => void
}

export function useContextRouter(handlers: RouterHandlers) {
  const ref = useRef(handlers)
  useEffect(() => { ref.current = handlers })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const h = ref.current
      const active = document.activeElement
      const key = normalizeKey(e)

      // --- Backtick: root key (tier-1 reserved, but handled here for focus path) ---
      if (e.code === 'Backquote' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (isEditable(active)) return
        e.preventDefault()
        h.clearFocus()
        return
      }

      // --- Chord state active ---
      if (h.chordState) {
        const chordDef = getWidget(h.chordState.contextId)
        if (chordDef) {
          const binding = chordDef.bindings.find(b => b.key === key && b.chord)
          if (binding) {
            e.preventDefault()
            const tailId = h.path[h.path.length - 1]?.id
            if (tailId) {
              h.onChordAction?.(tailId)
              dispatchAction(tailId, binding.action)
            }
            h.clearChord()
            return
          }
        }
        // No match in chord → ignore (don't fall through)
        return
      }

      // --- Tier-2: look up current focus tail ---
      const tail = h.path[h.path.length - 1]
      const def = tail ? getWidget(tail.type) : getWidget('canvas')
      if (!def) return

      // Check contexts (navigation)
      const ctx = def.contexts.find(c => c.key === key)
      if (ctx) {
        e.preventDefault()
        if (ctx.transient) {
          h.setChord(ctx.type)
        } else {
          const newNode: FocusNode = { id: tail?.id ?? 'canvas', type: ctx.type, label: ctx.label }
          h.pushFocus(newNode)
          h.onNavigate?.(tail?.id ?? 'canvas')
        }
        return
      }

      // Check direct bindings
      const binding = def.bindings.find(b => b.key === key && !b.chord)
      if (binding) {
        e.preventDefault()
        if (tail) {
          h.onChordAction?.(tail.id)
          dispatchAction(tail.id, binding.action)
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/contextRouter.ts
git commit -m "feat: add context router — backtick root key, tier-2/3 binding dispatch #widget-hotkeys"
```

---

### Task 6: Tailwind flourish keyframes

**Files:**
- Modify: `tailwind.config.ts`

- [ ] **Step 1: Add keyframes to tailwind.config.ts**

Replace the `keyframes` and `animation` sections (keep existing `pulse-glow`, `scan`, `shimmer` — add new ones):

```typescript
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'shimmer': {
          '0%': { opacity: '0.3' },
          '50%': { opacity: '0.8' },
          '100%': { opacity: '0.3' },
        },
        // --- Hotkey activation flourish ---
        'ignite': {
          '0%':   { borderColor: 'var(--ignite-base, #1e3a5f)', boxShadow: 'none', transform: 'scale(1)' },
          '8%':   { borderColor: '#00f0ff', boxShadow: '0 0 0 6px rgba(0,240,255,0.4), 0 0 30px rgba(0,240,255,0.3), inset 0 0 30px rgba(0,240,255,0.15)', transform: 'scale(1.02)' },
          '25%':  { borderColor: '#00f0ff', boxShadow: '0 0 0 3px rgba(0,240,255,0.2), inset 0 0 15px rgba(0,240,255,0.08)', transform: 'scale(1.01)' },
          '100%': { borderColor: 'var(--ignite-base, #1e3a5f)', boxShadow: 'none', transform: 'scale(1)' },
        },
        'scan-oneshot': {
          '0%':   { transform: 'translateX(-100%) skewX(-10deg)', opacity: '0' },
          '5%':   { opacity: '0.9' },
          '100%': { transform: 'translateX(120%) skewX(-10deg)', opacity: '0' },
        },
        'ripple-ring': {
          '0%':   { inset: '0px', borderColor: 'rgba(0,240,255,0.8)', opacity: '1' },
          '100%': { inset: '-20px', borderColor: 'rgba(0,240,255,0)', opacity: '0' },
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'scan': 'scan 8s linear infinite',
        'shimmer': 'shimmer 1.5s ease-in-out infinite',
        'ignite': 'ignite 500ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
        'scan-oneshot': 'scan-oneshot 350ms 20ms ease forwards',
        'ripple-ring': 'ripple-ring 500ms 20ms cubic-bezier(0.2, 0, 0.6, 1) forwards',
      },
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add tailwind.config.ts
git commit -m "feat: add ignite, scan-oneshot, ripple-ring flourish keyframes to Tailwind #widget-hotkeys"
```

---

### Task 7: useFlourish hook

**Files:**
- Create: `src/hotkeys/useFlourish.ts`

The hook applies CSS classes to trigger the animations and removes them when done.

- [ ] **Step 1: Create useFlourish.ts**

```typescript
// src/hotkeys/useFlourish.ts
import { useCallback, useRef, type RefObject } from 'react'

/**
 * Returns two triggers:
 * - triggerHollywoodHit: full bloom + scan + ripple (navigation/context change)
 * - triggerScanLine: scan only (chord action)
 *
 * Usage:
 *   const divRef = useRef<HTMLDivElement>(null)
 *   const { triggerHollywoodHit, triggerScanLine } = useFlourish(divRef)
 *
 * The target element needs:
 *   - overflow-hidden (for scan line)
 *   - position: relative (for ripple ring child)
 *   - a <div className="flourish-scan-line" /> child
 *   - a <div className="flourish-ripple-ring" /> child
 */
export function useFlourish(containerRef: RefObject<HTMLElement | null>) {
  // Track active cleanup to avoid double-add
  const cleanupRef = useRef<(() => void) | null>(null)

  const clear = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
  }, [])

  const triggerHollywoodHit = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    clear()

    const scan = el.querySelector('.flourish-scan-line') as HTMLElement | null
    const ripple = el.querySelector('.flourish-ripple-ring') as HTMLElement | null

    // Force reflow to allow re-triggering
    el.classList.remove('flourish-ignite')
    scan?.classList.remove('flourish-scan-active')
    ripple?.classList.remove('flourish-ripple-active')
    void el.offsetWidth

    el.classList.add('flourish-ignite')
    scan?.classList.add('flourish-scan-active')
    ripple?.classList.add('flourish-ripple-active')

    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== 'ignite') return
      el.classList.remove('flourish-ignite')
      scan?.classList.remove('flourish-scan-active')
      ripple?.classList.remove('flourish-ripple-active')
      el.removeEventListener('animationend', onEnd)
      cleanupRef.current = null
    }
    el.addEventListener('animationend', onEnd)
    cleanupRef.current = () => {
      el.removeEventListener('animationend', onEnd)
      el.classList.remove('flourish-ignite')
      scan?.classList.remove('flourish-scan-active')
      ripple?.classList.remove('flourish-ripple-active')
    }
  }, [containerRef, clear])

  const triggerScanLine = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const scan = el.querySelector('.flourish-scan-line') as HTMLElement | null
    if (!scan) return

    scan.classList.remove('flourish-scan-active')
    void scan.offsetWidth
    scan.classList.add('flourish-scan-active')

    const onEnd = () => {
      scan.classList.remove('flourish-scan-active')
      scan.removeEventListener('animationend', onEnd)
    }
    scan.addEventListener('animationend', onEnd)
  }, [containerRef])

  return { triggerHollywoodHit, triggerScanLine }
}
```

- [ ] **Step 2: Add flourish CSS classes to index.css or a global stylesheet**

Open `src/index.css` (or wherever global styles live — check with `ls src/*.css`) and append:

```css
/* Hotkey activation flourish */
.flourish-ignite {
  animation: ignite 500ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.flourish-scan-line {
  position: absolute;
  top: 0;
  left: 0;
  width: 40%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(0,240,255,0.25), rgba(0,240,255,0.08), transparent);
  pointer-events: none;
  display: none;
}
.flourish-scan-active {
  display: block !important;
  animation: scan-oneshot 350ms 20ms ease forwards;
}
.flourish-ripple-ring {
  position: absolute;
  inset: -4px;
  border: 2px solid rgba(0,240,255,0);
  border-radius: 10px;
  pointer-events: none;
}
.flourish-ripple-active {
  animation: ripple-ring 500ms 20ms cubic-bezier(0.2, 0, 0.6, 1) forwards;
}
```

- [ ] **Step 3: Find the global CSS file**

```bash
ls /home/ubuntu/repo/tinstar/src/*.css
```

Append the CSS block above to that file.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/hotkeys/useFlourish.ts src/*.css
git commit -m "feat: add useFlourish hook + flourish CSS classes #widget-hotkeys"
```

---

## Chunk 3: Widget Definitions + RunWorkspace Migration

### Task 8: Canvas WidgetDefinition

**Files:**
- Create: `src/hotkeys/widgets/canvasWidget.ts`

- [ ] **Step 1: Create canvasWidget.ts**

Canvas is the root context (tier 3). It has no direct bindings (those come from useGlobalHotkeys/useCanvasHotkeys) but serves as the activeDefinition fallback and can expose contexts to navigate into widgets.

```typescript
// src/hotkeys/widgets/canvasWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'canvas',
  displayName: 'Canvas',
  contexts: [],  // Canvas-level navigation into widgets is handled by SelectionProvider/[  ] keys, not context push
  bindings: [],  // Canvas bindings are tier-1 reserved (handled by useGlobalHotkeys + useCanvasHotkeys)
})
```

- [ ] **Step 2: Create groupContainerWidget.ts**

```typescript
// src/hotkeys/widgets/groupContainerWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'group-container',
  displayName: 'Group',
  contexts: [],
  bindings: [],
})
```

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/widgets/
git commit -m "feat: register canvas and group-container WidgetDefinitions #widget-hotkeys"
```

---

### Task 9: RunWorkspace WidgetDefinition + retire useWidgetHotkeys

**Files:**
- Create: `src/hotkeys/widgets/runWorkspaceWidget.ts`
- Modify: `src/components/RunWorkspaceWidget/index.tsx`

This is the most important migration. The `useWidgetHotkeys` bindings (Tab, Arrow keys, Enter, Ctrl+\) move into the WidgetDefinition and are dispatched via `actionHandlerRegistry`.

- [ ] **Step 1: Create runWorkspaceWidget.ts**

```typescript
// src/hotkeys/widgets/runWorkspaceWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'run-workspace',
  displayName: 'Agent Session',
  contexts: [],
  bindings: [
    { key: 'Tab',        label: 'Next panel',        action: 'focus-next' },
    { key: 'Shift+Tab',  label: 'Prev panel',        action: 'focus-prev' },
    { key: 'ArrowDown',  label: 'Down in file list', action: 'file-down' },
    { key: 'ArrowUp',    label: 'Up in file list',   action: 'file-up' },
    { key: 'ArrowRight', label: 'Next tab',          action: 'tab-next' },
    { key: 'ArrowLeft',  label: 'Prev tab',          action: 'tab-prev' },
    { key: 'Enter',      label: 'Activate',          action: 'activate' },
    { key: 'Ctrl+Backslash', label: 'Enter terminal', action: 'terminal-toggle' },
  ],
})
```

- [ ] **Step 2: Update RunWorkspaceWidget/index.tsx — remove useWidgetHotkeys, add action handler**

At the top of the file, replace the `useWidgetHotkeys` import with:

```typescript
import { useEffect, useRef, useCallback, useMemo } from 'react'
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { useFocusPath } from '../../hotkeys/FocusPathContext'
import { useFlourish } from '../../hotkeys/useFlourish'
import { type FocusZone } from '../../hotkeys/widgetTypes'  // FocusZone moved here from useWidgetHotkeys
import '../../hotkeys/widgets/runWorkspaceWidget'  // side-effect: registers WidgetDefinition
```

Remove the line: `import { useWidgetHotkeys, type FocusZone } from '../../hotkeys/useWidgetHotkeys'`

- [ ] **Step 3: Wire actionHandler in RunWorkspaceWidget body**

Find where `useWidgetHotkeys(rootRef, {...})` is called and replace the entire `useWidgetHotkeys` call with:

```typescript
  // Expose action dispatch so context router can trigger widget actions
  const { triggerHollywoodHit, triggerScanLine } = useFlourish(rootRef)

  useEffect(() => {
    registerActionHandler(run.id, (action) => {
      // All widget hotkeys suspended when terminal has focused
      if (terminalFocused) return
      switch (action) {
        case 'focus-next':    onFocusNext();                                    break
        case 'focus-prev':    onFocusPrev();                                    break
        case 'file-down':     setFileSelectionIndex(i => i + 1);               break
        case 'file-up':       setFileSelectionIndex(i => Math.max(i - 1, 0));  break
        case 'tab-next':      setCenterTabIndex(i => (i + 1) % 2);             break
        case 'tab-prev':      setCenterTabIndex(i => (i - 1 + 2) % 2);        break
        case 'activate':      /* no-op for now */                               break
        case 'terminal-toggle': triggerScanLine(); handleTerminalToggle();     break
      }
    })
    return () => deregisterActionHandler(run.id)
  })
```

Note: the `useEffect` has no dependency array — it re-registers on every render so the closure always has fresh values. This is intentional (same pattern as `handlersRef` in the old hook).

- [ ] **Step 4: Add flourish DOM structure to the widget root element**

In the `return (...)` of RunWorkspaceWidget, inside the root `<div ref={rootRef} ...>`, add as the first children:

```tsx
      {/* Flourish animation layers */}
      <div className="flourish-scan-line" />
      <div className="flourish-ripple-ring" />
```

The root `<div>` already has `overflow: hidden` implied by `overflow-hidden` — verify and ensure it also has `relative` positioning (add `relative` to className if not present).

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors. If `FocusZone` type was exported and used elsewhere, check with:
```bash
grep -r "FocusZone" src/
```
If unused after removal, it's fine.

- [ ] **Step 6: Commit**

```bash
git add src/hotkeys/widgets/runWorkspaceWidget.ts src/components/RunWorkspaceWidget/index.tsx
git commit -m "feat: register run-workspace WidgetDefinition, retire useWidgetHotkeys, wire actionHandler #widget-hotkeys"
```

---

## Chunk 4: Global Wiring — WorkspaceShell + InfiniteCanvas + HotkeyPalette Migration

### Task 10: Register widget definitions at module load

Widget definition files must be imported somewhere to trigger their `registerWidget()` side effects. Create a barrel entry point:

**Files:**
- Create: `src/hotkeys/widgets/index.ts`
- Modify: `src/main.tsx` or `src/App.tsx`

- [ ] **Step 1: Create barrel**

```typescript
// src/hotkeys/widgets/index.ts
// Import all widget definitions to trigger registration side-effects
import './canvasWidget'
import './groupContainerWidget'
// runWorkspaceWidget is imported directly by RunWorkspaceWidget/index.tsx
```

- [ ] **Step 2: Import barrel in app entry point**

Find the app entry (likely `src/main.tsx` or `src/App.tsx`):
```bash
head -5 /home/ubuntu/repo/tinstar/src/main.tsx 2>/dev/null || head -5 /home/ubuntu/repo/tinstar/src/App.tsx
```

Add at the top:
```typescript
import './hotkeys/widgets'  // register widget definitions
```

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/widgets/index.ts src/main.tsx
git commit -m "feat: import widget definitions at app entry for registration side-effects #widget-hotkeys"
```

---

### Task 11: Wire FocusPathProvider + useContextRouter into WorkspaceShell

**Files:**
- Modify: `src/components/WorkspaceShell.tsx`

WorkspaceShell wraps `WorkspaceShellInner` with `SelectionProvider`. Add `FocusPathProvider` alongside it, add `useContextRouter` in the inner component, and sync `selectedRunId` → focus path.

- [ ] **Step 1: Add imports to WorkspaceShell.tsx**

Near the top imports, add:
```typescript
import { FocusPathProvider, useFocusPath } from '../hotkeys/FocusPathContext'
import { useContextRouter } from '../hotkeys/contextRouter'
```

- [ ] **Step 2: Wrap WorkspaceShell with FocusPathProvider**

Find the `WorkspaceShell` component at the bottom of the file (line ~604). It currently renders:
```tsx
<SelectionProvider>
  <WorkspaceShellInner />
</SelectionProvider>
```

Change to:
```tsx
<FocusPathProvider>
  <SelectionProvider>
    <WorkspaceShellInner />
  </SelectionProvider>
</FocusPathProvider>
```

- [ ] **Step 3: Remove ActiveScopeProvider from WorkspaceShell.tsx**

Find the three lines referencing `ActiveScopeProvider` (import, opening tag ~line 387, closing tag ~line 598) and remove them. The `setScope` calls (if any) should also be removed.

Search for uses:
```bash
grep -n "setScope\|ActiveScopeProvider\|useActiveScope" src/components/WorkspaceShell.tsx
```

Remove all such references.

- [ ] **Step 4: Sync selectedRunId with FocusPathContext in WorkspaceShellInner**

In `WorkspaceShellInner`, after the `selectedRunId` useMemo (line ~287), add:

```typescript
  const { pushFocus, clearFocus } = useFocusPath()

  // Sync selectedRunId → FocusPathContext
  useEffect(() => {
    if (selectedRunId) {
      clearFocus()
      const run = runMap.get(selectedRunId)
      pushFocus({ id: selectedRunId, type: 'run-workspace', label: run?.id ?? selectedRunId })
    } else {
      clearFocus()
    }
  }, [selectedRunId, pushFocus, clearFocus, runMap])
```

- [ ] **Step 5: Add useContextRouter in WorkspaceShellInner**

Near where `useGlobalHotkeys` is called, add:

```typescript
  const { path, chordState, pushFocus: _pushFocus, clearFocus: _clearFocus, setChord, clearChord } = useFocusPath()

  useContextRouter({
    path,
    chordState,
    pushFocus: _pushFocus,
    clearFocus: _clearFocus,
    setChord,
    clearChord,
    // Flourish callbacks wired in Task 13 (InfiniteCanvas owns the widget elements)
  })
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 7: Commit**

```bash
git add src/components/WorkspaceShell.tsx
git commit -m "feat: wire FocusPathProvider + useContextRouter + selectedRunId sync into WorkspaceShell #widget-hotkeys"
```

---

### Task 12: Update HotkeyPalette to read from widgetRegistry

**Files:**
- Modify: `src/components/HotkeyPalette.tsx`

Replace the `HOTKEYS`/`useActiveScope` data source with `getAllWidgets()` from the registry.

- [ ] **Step 1: Update HotkeyPalette.tsx imports and data source**

Replace:
```typescript
import { HOTKEYS, type HotkeyDef } from '../hotkeys/registry'
import { useActiveScope } from '../hotkeys/ActiveScopeContext'
```

With:
```typescript
import { getAllWidgets } from '../hotkeys/widgetRegistry'
import type { Binding } from '../hotkeys/widgetTypes'
```

- [ ] **Step 2: Replace the HOTKEYS rendering logic**

Currently the palette filters `HOTKEYS` by `scope` using `useActiveScope`. Replace with flat list of all widget bindings grouped by widget type.

Remove `const { scope } = useActiveScope()` and the `isAvailable` function.

Replace the `filtered` derivation and rendering with:

```typescript
  // Flatten all registered widget bindings into a searchable list
  const allBindings = useMemo(() => {
    const result: Array<{ widgetType: string; displayName: string; binding: Binding }> = []
    for (const def of getAllWidgets()) {
      for (const b of def.bindings) {
        result.push({ widgetType: def.type, displayName: def.displayName, binding: b })
      }
    }
    return result
  }, [])

  const filtered = q
    ? allBindings.filter(({ binding }) =>
        binding.label.toLowerCase().includes(q) || binding.key.toLowerCase().includes(q)
      )
    : allBindings

  // Group by widget displayName (replaces category)
  const groups = useMemo(() => {
    const map = new Map<string, Binding[]>()
    for (const { displayName, binding } of filtered) {
      if (!map.has(displayName)) map.set(displayName, [])
      map.get(displayName)!.push(binding)
    }
    return map
  }, [filtered])
```

Update the JSX that renders categories/hotkeys to use `groups` (iterate `[...groups.entries()]`). Render `binding.label` and `binding.key` where it used to render `h.description` and `h.keys`.

- [ ] **Step 3: Add useMemo import if not present**

```bash
grep "useMemo" src/components/HotkeyPalette.tsx
```

Add to React import if missing.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: Delete the old files**

```bash
rm src/hotkeys/ActiveScopeContext.tsx src/hotkeys/registry.ts src/hotkeys/useWidgetHotkeys.ts
npx tsc --noEmit 2>&1 | head -30
```

Fix any remaining import errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: migrate HotkeyPalette to widgetRegistry, delete ActiveScopeContext + registry + useWidgetHotkeys #widget-hotkeys"
```

---

### Task 13: InfiniteCanvas — flourish on widget selection

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

When a widget is selected via keyboard (`[`/`]`) or click, the corresponding `RunWorkspaceWidget` should fire the Hollywood Hit. The canvas doesn't own the widget DOM directly — instead, the selected widget's `useFlourish` is triggered via an event or by checking a "just selected" flag.

Simplest approach: export a `widgetFlourishRegistry` (parallel to `actionHandlerRegistry`) that maps widgetId → triggerHollywoodHit.

- [ ] **Step 1: Add flourishRegistry to actionHandlerRegistry.ts**

Append to `src/hotkeys/actionHandlerRegistry.ts`:

```typescript
type FlourishFn = () => void
const flourishHandlers = new Map<string, FlourishFn>()

export function registerFlourishHandler(widgetId: string, fn: FlourishFn): void {
  flourishHandlers.set(widgetId, fn)
}

export function deregisterFlourishHandler(widgetId: string): void {
  flourishHandlers.delete(widgetId)
}

export function triggerWidgetFlourish(widgetId: string): void {
  flourishHandlers.get(widgetId)?.()
}
```

- [ ] **Step 2: Register triggerHollywoodHit in RunWorkspaceWidget**

In `RunWorkspaceWidget/index.tsx`, add import:
```typescript
import { registerFlourishHandler, deregisterFlourishHandler } from '../../hotkeys/actionHandlerRegistry'
```

Add a useEffect after the action handler registration:
```typescript
  useEffect(() => {
    registerFlourishHandler(run.id, triggerHollywoodHit)
    return () => deregisterFlourishHandler(run.id)
  }, [run.id, triggerHollywoodHit])
```

- [ ] **Step 3: Call triggerWidgetFlourish when a run is selected**

In `WorkspaceShell.tsx`, in the `useEffect` that syncs `selectedRunId`, add:
```typescript
import { triggerWidgetFlourish } from '../hotkeys/actionHandlerRegistry'

// Inside the useEffect:
    if (selectedRunId) {
      clearFocus()
      const run = runMap.get(selectedRunId)
      pushFocus({ id: selectedRunId, type: 'run-workspace', label: run?.id ?? selectedRunId })
      triggerWidgetFlourish(selectedRunId)  // ← add this line
    } else {
      clearFocus()
    }
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: E2E smoke test — verify app still loads**

```bash
TINSTAR_FAST_SIM=1 npm run dev &
sleep 5
curl -s http://localhost:5273/ | head -5
kill %1
```
Expected: HTML response (app running).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire flourish registry — Hollywood Hit fires on widget selection #widget-hotkeys"
```

---

## Chunk 5: HotkeysSidebar + Layout

### Task 14: HotkeysSidebar component

**Files:**
- Create: `src/components/HotkeysSidebar.tsx`

- [ ] **Step 1: Create HotkeysSidebar.tsx**

```tsx
// src/components/HotkeysSidebar.tsx
import { useState, useCallback, useRef, useEffect } from 'react'
import { useHotkeyContext } from '../hotkeys/FocusPathContext'
import type { Binding } from '../hotkeys/widgetTypes'

// Tier-1 always-available bindings shown in the bottom section
const ALWAYS_AVAILABLE: Array<{ key: string; label: string }> = [
  { key: '`',         label: 'Canvas root' },
  { key: ']',         label: 'Next session' },
  { key: '[',         label: 'Prev session' },
  { key: 'Shift+]',   label: 'Next (all)' },
  { key: 'Shift+[',   label: 'Prev (all)' },
  { key: '?',         label: 'Hotkeys' },
  { key: 'Ctrl+↵',    label: 'New session' },
  { key: 'S',         label: 'Quick session' },
  { key: 'Ctrl+G',    label: 'Arrange grid' },
  { key: '1–9',       label: 'Hotgroup select' },
  { key: 'Ctrl+1–9',  label: 'Hotgroup assign' },
]

const LS_WIDTH = 'tinstar-sidebar-hotkeys-width'
const LS_COLLAPSED = 'tinstar-sidebar-hotkeys-collapsed'
const MIN_W = 140
const MAX_W = 320
const DEFAULT_W = 180

function KeyBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1 py-0 bg-surface-raised border border-white/20 rounded text-2xs font-mono text-slate-300">
      {label}
    </span>
  )
}

function BindingRow({ binding }: { binding: Binding | { key: string; label: string } }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-2xs text-slate-400 truncate">{binding.label}</span>
      <KeyBadge label={binding.key} />
    </div>
  )
}

export function HotkeysSidebar() {
  const { path, chordState, activeDefinition } = useHotkeyContext()

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(LS_WIDTH)
    return saved ? Math.max(MIN_W, Math.min(MAX_W, parseInt(saved))) : DEFAULT_W
  })
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(LS_COLLAPSED) === 'true'
  })

  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: width }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [width])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const newW = Math.max(MIN_W, Math.min(MAX_W, dragRef.current.startW - (e.clientX - dragRef.current.startX)))
    setWidth(newW)
    localStorage.setItem(LS_WIDTH, String(newW))
  }, [])

  const onPointerUp = useCallback(() => { dragRef.current = null }, [])

  const toggleCollapse = useCallback(() => {
    setCollapsed(c => {
      const next = !c
      localStorage.setItem(LS_COLLAPSED, String(next))
      return next
    })
  }, [])

  // Breadcrumb labels
  const breadcrumb = ['Canvas', ...path.map(n => n.label)]
  const contextLabel = activeDefinition?.displayName ?? 'Canvas'

  // Active bindings — if chord is active, show chord-only bindings; else show regular
  const activeBindings: Binding[] = activeDefinition
    ? (chordState
        ? activeDefinition.bindings.filter(b => b.chord)
        : activeDefinition.bindings.filter(b => !b.chord))
    : []

  if (collapsed) {
    return (
      <div
        className="w-6 flex-shrink-0 flex flex-col items-center justify-start pt-2 bg-surface-panel border-l border-white/10 cursor-pointer hover:bg-surface-hover"
        onClick={toggleCollapse}
        data-testid="hotkeys-sidebar-collapsed"
      >
        <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr] rotate-180 mt-1">KEYS</span>
      </div>
    )
  }

  return (
    <div
      className="flex-shrink-0 bg-surface-panel border-l border-white/10 relative flex flex-col overflow-hidden"
      style={{ width }}
      data-testid="hotkeys-sidebar"
    >
      {/* Drag handle on left edge */}
      <div
        className="absolute top-0 left-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        data-testid="hotkeys-sidebar-resize-handle"
      />

      {/* Header: breadcrumb + collapse button */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-white/10 min-w-0">
        <div className="flex items-center gap-0.5 text-2xs text-slate-500 truncate font-mono min-w-0">
          {breadcrumb.map((label, i) => (
            <span key={i} className="flex items-center gap-0.5 truncate">
              {i > 0 && <span className="text-slate-600 flex-shrink-0">›</span>}
              <span className={i === breadcrumb.length - 1 ? 'text-slate-300' : ''}>
                {label}
              </span>
            </span>
          ))}
        </div>
        <button
          className="flex-shrink-0 ml-1 text-slate-500 hover:text-primary text-xs"
          onClick={toggleCollapse}
          title="Collapse hotkeys panel"
        >
          »
        </button>
      </div>

      {/* Current context bindings */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1.5 min-h-0">
        <div className={`text-2xs font-mono font-bold text-slate-500 uppercase tracking-widest mb-1.5 ${chordState ? 'text-primary' : ''}`}>
          {chordState ? '⌨ CHORD' : contextLabel}
        </div>
        {activeBindings.length === 0 ? (
          <div className="text-2xs text-slate-600 italic">no bindings</div>
        ) : (
          <div className={chordState ? 'opacity-100' : ''}>
            {activeBindings.map(b => <BindingRow key={b.key} binding={b} />)}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-white/10 mx-2" />

      {/* Always-available tier-1 section */}
      <div className="px-2 py-1.5 flex-shrink-0">
        <div className="text-2xs font-mono font-bold text-slate-600 uppercase tracking-widest mb-1">
          Always
        </div>
        <div className="space-y-0">
          {ALWAYS_AVAILABLE.map(b => <BindingRow key={b.key} binding={b} />)}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add src/components/HotkeysSidebar.tsx
git commit -m "feat: add HotkeysSidebar — resizable/hideable, context-aware, localStorage-persisted #widget-hotkeys"
```

---

### Task 15: Wire HotkeysSidebar into WorkspaceShell layout

**Files:**
- Modify: `src/components/WorkspaceShell.tsx`

- [ ] **Step 1: Import HotkeysSidebar**

```typescript
import { HotkeysSidebar } from './HotkeysSidebar'
```

- [ ] **Step 2: Add HotkeysSidebar to the right of the canvas**

Find the "Canvas" section (the `<div className="flex-1 relative overflow-hidden" data-testid="canvas-slot">` block) and wrap it together with the sidebar in a flex container, or append after:

The current structure is:
```jsx
{/* Main area: sidebar + canvas */}
<div className="flex flex-1 overflow-hidden">
  {/* Sidebar (left) */}
  ...
  {/* Canvas */}
  <div className="flex-1 relative overflow-hidden" data-testid="canvas-slot">
    <InfiniteCanvas ... />
  </div>
</div>
```

Change to:
```jsx
{/* Main area: sidebar + canvas + hotkeys sidebar */}
<div className="flex flex-1 overflow-hidden">
  {/* Sidebar (left) */}
  ...
  {/* Canvas */}
  <div className="flex-1 relative overflow-hidden" data-testid="canvas-slot">
    <InfiniteCanvas ... />
  </div>
  {/* Hotkeys sidebar (right) */}
  <HotkeysSidebar />
</div>
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Run the app and verify sidebar renders**

```bash
TINSTAR_FAST_SIM=1 npm run dev &
sleep 4
# Open http://localhost:5273 in browser and verify:
# - Hotkeys sidebar appears on the right
# - Backtick clears focus path
# - Sidebar shows "Canvas" context when nothing selected
# - Selecting a widget shows "Agent Session" context
# - Collapse button works
# - Drag handle resizes
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add src/components/WorkspaceShell.tsx
git commit -m "feat: wire HotkeysSidebar into WorkspaceShell layout on right side #widget-hotkeys"
```

---

### Task 16: E2E tests for new functionality

**Files:**
- Modify: `e2e/hotkeys.spec.ts`

- [ ] **Step 1: Add sidebar tests to hotkeys.spec.ts**

Append to the existing test file:

```typescript
test.describe('Hotkeys Sidebar', () => {
  test('sidebar renders with ALWAYS section', async ({ page }) => {
    await expect(page.getByTestId('hotkeys-sidebar')).toBeVisible()
    await expect(page.getByTestId('hotkeys-sidebar').getByText('Always')).toBeVisible()
  })

  test('sidebar collapse and expand', async ({ page }) => {
    const sidebar = page.getByTestId('hotkeys-sidebar')
    await expect(sidebar).toBeVisible()
    // Click collapse button
    await sidebar.getByTitle('Collapse hotkeys panel').click()
    await expect(page.getByTestId('hotkeys-sidebar-collapsed')).toBeVisible()
    await expect(page.getByTestId('hotkeys-sidebar')).not.toBeVisible()
    // Click collapsed strip to expand
    await page.getByTestId('hotkeys-sidebar-collapsed').click()
    await expect(page.getByTestId('hotkeys-sidebar')).toBeVisible()
  })

  test('backtick clears focus path (root key)', async ({ page }) => {
    // Select a widget first (using ] cycle key if any sessions exist)
    await page.keyboard.press('`')
    // Sidebar should show Canvas context
    await expect(page.getByTestId('hotkeys-sidebar').getByText('Canvas')).toBeVisible()
  })
})

test.describe('HotkeyPalette after migration', () => {
  test('palette still renders with key bindings', async ({ page }) => {
    await page.keyboard.press('?')
    const palette = page.getByTestId('hotkey-palette')
    await expect(palette).toBeVisible()
    // Should show at least the Agent Session section (from run-workspace WidgetDefinition)
    await expect(palette.getByText('Agent Session')).toBeVisible()
  })
})
```

- [ ] **Step 2: Run E2E tests**

```bash
TINSTAR_FAST_SIM=1 npx playwright test e2e/hotkeys.spec.ts --reporter=line 2>&1 | tail -30
```
Expected: all tests pass (including existing palette tests)

- [ ] **Step 3: Fix any failures, then commit**

```bash
git add e2e/hotkeys.spec.ts
git commit -m "test: add E2E tests for HotkeysSidebar collapse and context routing #widget-hotkeys"
```

---

## Final Verification

- [ ] **Full type-check**

```bash
npx tsc --noEmit 2>&1
```
Expected: 0 errors

- [ ] **Full E2E suite**

```bash
TINSTAR_FAST_SIM=1 npx playwright test --reporter=line 2>&1 | tail -20
```
Expected: all existing tests still pass

- [ ] **Manual smoke: verify flourish fires**

Start with `TINSTAR_FAST_SIM=1 npm run dev`, select a session widget with `]`, verify Hollywood Hit animation fires on the widget border.

- [ ] **Manual smoke: verify sidebar context updates**

Open sidebar, press backtick, verify breadcrumb shows "Canvas". Press `]` to select a session, verify breadcrumb updates to show "Agent Session".
