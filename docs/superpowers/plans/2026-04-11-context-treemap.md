# Context Treemap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a context window usage treemap to the RunWorkspaceWidget right panel, showing how a Claude Code agent's 200K token context is consumed across categories (messages, tools, skills, memory, etc.).

**Architecture:** The backend spawns a sidecar Claude Code process (`claude --print --resume <id> --fork-session`) that queries the running session's context usage via the SDK control protocol. The frontend splits the existing Procedures panel into top (procedures) and bottom (telemetry), rendering a squarified treemap colored by the run's accent color at ranked opacities.

**Tech Stack:** React, Tailwind, `squarify` npm package (treemap layout math), Node.js `child_process.spawn` (sidecar), Claude Code SDK control protocol (`get_context_usage`)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/server/sessions/context-usage.ts` | **New** — Sidecar spawner, response parser, concurrency guard, TTL cache |
| `src/server/api/routes.ts` | **Modify** — Add `GET /api/sessions/:name/context` route |
| `src/components/RunWorkspaceWidget/TelemetryPanel.tsx` | **New** — Telemetry section with treemap, tooltips, loading/error/empty states |
| `src/components/RunWorkspaceWidget/index.tsx` | **Modify** — Split right panel, add draggable divider, pass props to TelemetryPanel |

---

### Task 1: Install squarify dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install squarify**

Run:
```bash
npm install squarify
```

Expected: `squarify` added to `dependencies` in `package.json`. The package ships its own TypeScript types (`lib/index.d.ts`), so no `@types/` package is needed.

- [ ] **Step 2: Verify types resolve**

Create a temporary file to confirm the import works:
```bash
echo 'import squarify from "squarify"; console.log(squarify)' > /tmp/sq-check.ts
npx tsc --noEmit --moduleResolution bundler --module ESNext --target ES2020 /tmp/sq-check.ts 2>&1 || true
rm /tmp/sq-check.ts
```

If types don't resolve cleanly, add a `declare module 'squarify'` shim in `src/vite-env.d.ts`. The `squarify` API:

```typescript
import squarify from 'squarify'

// Input: array of { value: number, ...rest }
// Container: { x0, y0, x1, y1 }
// Output: array of { x0, y0, x1, y1, ...rest } (input fields carried through)
const layout = squarify(
  [{ value: 100, label: 'A' }, { value: 50, label: 'B' }],
  { x0: 0, y0: 0, x1: 300, y1: 200 }
)
// layout[0] => { x0: 0, y0: 0, x1: 200, y1: 200, value: 100, label: 'A' }
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add squarify dependency for context treemap"
```

---

### Task 2: Backend — context-usage sidecar module

**Files:**
- Create: `src/server/sessions/context-usage.ts`

- [ ] **Step 1: Create the context-usage module**

Write `src/server/sessions/context-usage.ts`:

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ContextCategory {
  name: string
  tokens: number
  percentage: number
}

export interface ContextData {
  categories: ContextCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold: number | null
}

/* ------------------------------------------------------------------ */
/*  Concurrency guard + TTL cache                                      */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  data: ContextData
  ts: number
}

const CACHE_TTL_MS = 30_000
const SIDECAR_TIMEOUT_MS = 45_000

const inflightMap = new Map<string, Promise<ContextData>>()
const cacheMap = new Map<string, CacheEntry>()

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function getDetailedUsage(conversationId: string): Promise<ContextData> {
  // Return cached if fresh
  const cached = cacheMap.get(conversationId)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  // Return in-flight promise if one exists (concurrency guard)
  const inflight = inflightMap.get(conversationId)
  if (inflight) return inflight

  const promise = spawnSidecar(conversationId)
  inflightMap.set(conversationId, promise)

  try {
    const data = await promise
    cacheMap.set(conversationId, { data, ts: Date.now() })
    return data
  } finally {
    inflightMap.delete(conversationId)
  }
}

/* ------------------------------------------------------------------ */
/*  Sidecar                                                            */
/* ------------------------------------------------------------------ */

function spawnSidecar(conversationId: string): Promise<ContextData> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child?.kill('SIGKILL')
        reject(new Error('Sidecar timed out'))
      }
    }, SIDECAR_TIMEOUT_MS)

    try {
      child = spawn('claude', [
        '--print',
        '--resume', conversationId,
        '--fork-session',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '1',
        '--model', 'claude-haiku-4-5-20251001',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      clearTimeout(timeout)
      settled = true
      reject(new Error(`Failed to spawn claude sidecar: ${(err as Error).message}`))
      return
    }

    // Send control request + throwaway user message (needed to flush the control_response)
    const requestId = randomUUID()
    const controlLine = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'get_context_usage' },
    })
    const userLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x' },
      session_id: '',
      parent_tool_use_id: null,
    })

    child.stdin!.write(controlLine + '\n')
    child.stdin!.write(userLine + '\n')
    child.stdin!.end()

    // Parse stdout line-by-line for the control_response
    let buffer = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()! // keep incomplete last line

      for (const line of lines) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'control_response' && parsed.request_id === requestId) {
            settled = true
            clearTimeout(timeout)
            child?.kill('SIGKILL')

            const r = parsed.response?.response
            if (!r?.categories) {
              reject(new Error('Control response missing categories'))
              return
            }

            resolve({
              categories: r.categories,
              totalTokens: r.totalTokens ?? 0,
              maxTokens: r.maxTokens ?? 200_000,
              percentage: r.percentage ?? 0,
              model: r.model ?? 'unknown',
              isAutoCompactEnabled: r.isAutoCompactEnabled ?? false,
              autoCompactThreshold: r.autoCompactThreshold ?? null,
            })
          }
        } catch {
          // Not JSON or not our message — skip
        }
      }
    })

    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`Sidecar process error: ${err.message}`))
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        const msg = stderr.trim() ? `Sidecar exited ${code}: ${stderr.slice(0, 200)}` : `Sidecar exited with code ${code}`
        reject(new Error(msg))
      }
    })
  })
}
```

- [ ] **Step 2: Verify it type-checks**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors related to `context-usage.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/context-usage.ts
git commit -m "feat(telemetry): add context-usage sidecar module"
```

---

### Task 3: Backend — API route

**Files:**
- Modify: `src/server/api/routes.ts` (add route after the `/files` route at ~line 1836)

- [ ] **Step 1: Add the import**

At the top of `src/server/api/routes.ts`, after the existing session imports (around line 49, after the `natsControlSocketPath` import), add:

```typescript
import { getDetailedUsage } from '../sessions/context-usage'
```

- [ ] **Step 2: Add the route handler**

In `src/server/api/routes.ts`, immediately after the closing `}` of the `GET /api/sessions/:name/files` block (after line 1836), add:

```typescript
    // GET /api/sessions/:name/context
    if (method === 'GET' && url.startsWith('/api/sessions/') && url.includes('/context')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) {
          json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${name}' not found` } }, 404)
          return true
        }
        if (!session.conversation?.id) {
          json(res, { ok: false, error: { code: 'NO_CONVERSATION', message: 'Session has no active conversation' } }, 404)
          return true
        }
        getDetailedUsage(session.conversation.id)
          .then(data => json(res, { ok: true, data }))
          .catch(err => {
            log.error('api', `context fetch failed for ${name}: ${(err as Error).message}`)
            json(res, { ok: false, error: { code: 'CONTEXT_FETCH_FAILED', message: (err as Error).message } }, 500)
          })
        return true
      }
    }
```

- [ ] **Step 3: Verify it type-checks**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat(telemetry): add GET /api/sessions/:name/context route"
```

---

### Task 4: Frontend — TelemetryPanel component

**Files:**
- Create: `src/components/RunWorkspaceWidget/TelemetryPanel.tsx`

- [ ] **Step 1: Create TelemetryPanel with empty/loading/error states**

Write `src/components/RunWorkspaceWidget/TelemetryPanel.tsx`:

```typescript
import { useState, useCallback, useEffect, useRef } from 'react'
import squarify from 'squarify'
import { hexToRgba } from '../runAccent'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ContextCategory {
  name: string
  tokens: number
  percentage: number
}

interface ContextData {
  categories: ContextCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold: number | null
}

interface Props {
  sessionId: string
  runAccent: string
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const OPACITY_BY_RANK = [0.55, 0.45, 0.35, 0.28, 0.22, 0.18, 0.12]
const FREE_SPACE_OPACITY = 0.04
const AUTOCOMPACT_OPACITY = 0.10
const LABEL_THRESHOLD = 0.08 // 8% of total to show label

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  'Messages': 'Conversation history — prompts, responses, and tool call/result pairs',
  'System prompt': 'Base instructions Claude Code uses for every turn',
  'System tools': 'Built-in tool definitions (Bash, Read, Edit, Grep, etc.)',
  'MCP tools': 'Model Context Protocol tools from connected external servers',
  'Custom agents': 'Subagent type definitions from plugins',
  'Memory files': 'Project instructions (CLAUDE.md), auto-memory, and user-level config files',
  'Skills': 'Skill frontmatter loaded from plugins and user commands',
  'Autocompact buffer': 'Reserved headroom — when context hits this threshold, older messages are summarized',
  'Free space': 'Available context remaining before autocompact triggers',
  'MCP tools (deferred)': 'MCP tools available on-demand but not yet loaded into context',
  'System tools (deferred)': 'Built-in tools available on-demand via ToolSearch',
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function humanizeAge(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 10) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

function abbreviate(name: string): string {
  const abbrevs: Record<string, string> = {
    'System prompt': 'Sys prompt',
    'System tools': 'Sys tools',
    'Memory files': 'Memory',
    'Autocompact buffer': 'Buffer',
    'Free space': 'Free',
    'MCP tools (deferred)': 'MCP def.',
    'System tools (deferred)': 'Sys def.',
    'Custom agents': 'Agents',
  }
  return abbrevs[name] ?? name
}

function opacityForCategory(name: string, rank: number): number {
  if (name === 'Free space') return FREE_SPACE_OPACITY
  if (name === 'Autocompact buffer') return AUTOCOMPACT_OPACITY
  return OPACITY_BY_RANK[Math.min(rank, OPACITY_BY_RANK.length - 1)]
}

function labelColor(opacity: number): string {
  return opacity >= 0.30
    ? 'rgba(255,255,255,0.7)'
    : 'rgba(255,255,255,0.4)'
}

/* ------------------------------------------------------------------ */
/*  Treemap                                                            */
/* ------------------------------------------------------------------ */

interface TreemapProps {
  categories: ContextCategory[]
  accent: string
  maxTokens: number
}

interface TooltipState {
  name: string
  tokens: number
  percentage: number
  description: string
  x: number
  y: number
}

function Treemap({ categories, accent, maxTokens }: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  // Filter out zero-token categories, sort descending
  const sorted = categories
    .filter(c => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  // Compute layout using squarify — needs pixel dimensions
  const [dims, setDims] = useState({ w: 160, h: 120 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setDims({ w: rect.width, h: rect.height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const input = sorted.map((c, i) => ({
    value: c.tokens,
    name: c.name,
    tokens: c.tokens,
    percentage: c.percentage,
    rank: i,
  }))

  const layout = dims.w > 0 && dims.h > 0
    ? squarify(input, { x0: 0, y0: 0, x1: dims.w, y1: dims.h })
    : []

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0">
      {layout.map((cell: { x0: number; y0: number; x1: number; y1: number; name: string; tokens: number; percentage: number; rank: number }) => {
        const w = cell.x1 - cell.x0
        const h = cell.y1 - cell.y0
        const opacity = opacityForCategory(cell.name, cell.rank)
        const bg = hexToRgba(accent, opacity)
        const pctOfTotal = cell.tokens / maxTokens
        const showLabel = pctOfTotal >= LABEL_THRESHOLD && w > 28 && h > 16

        return (
          <div
            key={cell.name}
            className="absolute rounded-sm"
            style={{
              left: `${(cell.x0 / dims.w) * 100}%`,
              top: `${(cell.y0 / dims.h) * 100}%`,
              width: `${(w / dims.w) * 100}%`,
              height: `${(h / dims.h) * 100}%`,
              background: bg,
              padding: '1px',
            }}
            onMouseEnter={(e) => {
              const rect = containerRef.current?.getBoundingClientRect()
              if (!rect) return
              setTooltip({
                name: cell.name,
                tokens: cell.tokens,
                percentage: cell.percentage,
                description: CATEGORY_DESCRIPTIONS[cell.name] ?? '',
                x: e.clientX - rect.left,
                y: cell.y0,
              })
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            {showLabel && (
              <span
                className="text-2xs font-mono leading-none select-none pointer-events-none block truncate"
                style={{ color: labelColor(opacity), fontSize: '8px' }}
              >
                {abbreviate(cell.name)} {cell.percentage.toFixed(0)}%
              </span>
            )}
          </div>
        )
      })}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-50 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 shadow-lg pointer-events-none"
          style={{
            left: `${Math.min(tooltip.x, dims.w - 130)}px`,
            top: `${Math.max(0, tooltip.y - 52)}px`,
            maxWidth: '150px',
          }}
        >
          <div className="text-2xs font-bold text-slate-200 truncate">{tooltip.name}</div>
          <div className="text-2xs text-slate-400 font-mono">
            {tooltip.tokens.toLocaleString()} tokens ({tooltip.percentage.toFixed(1)}%)
          </div>
          {tooltip.description && (
            <div className="text-2xs text-slate-500 mt-0.5 leading-tight">{tooltip.description}</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  TelemetryPanel                                                     */
/* ------------------------------------------------------------------ */

export function TelemetryPanel({ sessionId, runAccent }: Props) {
  const [data, setData] = useState<ContextData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [ageLabel, setAgeLabel] = useState('')

  // Update humanized age every 30s
  useEffect(() => {
    if (!loadedAt) return
    const update = () => setAgeLabel(humanizeAge(Date.now() - loadedAt))
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [loadedAt])

  const fetchContext = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message ?? 'Unknown error')
      setData(json.data as ContextData)
      setLoadedAt(Date.now())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  /* ---- Empty state ---- */
  if (!data && !loading && !error) {
    return (
      <section className="flex flex-col flex-1 min-h-0">
        <div className="panel-header">
          <h3 className="panel-label">Telemetry</h3>
        </div>
        <div className="flex-1 flex items-center justify-center p-2">
          <button
            onClick={fetchContext}
            className="flex items-center gap-1.5 px-3 py-1.5 text-2xs font-mono text-slate-400 border border-dashed border-slate-600 rounded hover:border-slate-400 hover:text-slate-300 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">query_stats</span>
            Load Context
          </button>
        </div>
      </section>
    )
  }

  /* ---- Loading state ---- */
  if (loading && !data) {
    return (
      <section className="flex flex-col flex-1 min-h-0">
        <div className="panel-header">
          <h3 className="panel-label">Telemetry</h3>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-2xs font-mono text-slate-500 animate-pulse">Loading...</span>
        </div>
      </section>
    )
  }

  /* ---- Error state ---- */
  if (error && !data) {
    return (
      <section className="flex flex-col flex-1 min-h-0">
        <div className="panel-header">
          <h3 className="panel-label">Telemetry</h3>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-2">
          <span className="text-2xs text-red-400 text-center">{error}</span>
          <button
            onClick={fetchContext}
            className="text-2xs font-mono text-slate-400 hover:text-slate-300"
          >
            Retry
          </button>
        </div>
      </section>
    )
  }

  /* ---- Loaded state ---- */
  return (
    <section className="flex flex-col flex-1 min-h-0">
      <div className="panel-header">
        <h3 className="panel-label">Telemetry</h3>
      </div>
      <div className="flex-1 min-h-0 flex flex-col px-1 pt-1">
        <Treemap
          categories={data!.categories}
          accent={runAccent}
          maxTokens={data!.maxTokens}
        />
      </div>
      <div className="flex items-center justify-between px-2 py-1 text-2xs font-mono text-slate-600">
        <span>{loadedAt ? `loaded ${ageLabel}` : ''}</span>
        <button
          onClick={fetchContext}
          disabled={loading}
          className="text-slate-500 hover:text-slate-300 disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-xs">refresh</span>
        </button>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors. If `squarify` types cause issues, the output type from `squarify()` carries forward input properties — you may need to cast. The `squarify` return type includes `x0, y0, x1, y1` plus all input fields.

- [ ] **Step 3: Commit**

```bash
git add src/components/RunWorkspaceWidget/TelemetryPanel.tsx
git commit -m "feat(telemetry): add TelemetryPanel component with treemap"
```

---

### Task 5: Frontend — Split right panel with draggable divider

**Files:**
- Modify: `src/components/RunWorkspaceWidget/index.tsx`

- [ ] **Step 1: Add TelemetryPanel import**

In `src/components/RunWorkspaceWidget/index.tsx`, after the `ProceduresPanel` import (line 7), add:

```typescript
import { TelemetryPanel } from './TelemetryPanel'
```

- [ ] **Step 2: Add telemetry divider state and drag handlers**

Inside the `RunWorkspaceWidget` component function, after the existing `handsResizeDragRef` declaration (search for `handsResizeDragRef`), add:

```typescript
  // Telemetry divider — percentage of right panel height allocated to Procedures (top)
  const [procsPercent, setProcsPercent] = useState(50)
  const telemetryDragRef = useRef<{ startY: number; startPct: number } | null>(null)

  const onTelemetryDividerPointerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    telemetryDragRef.current = { startY: e.clientY, startPct: procsPercent }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [procsPercent])

  const onTelemetryDividerPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!telemetryDragRef.current) return
    const parentEl = (e.currentTarget as HTMLElement).parentElement
    if (!parentEl) return
    const parentHeight = parentEl.getBoundingClientRect().height
    if (parentHeight < 1) return
    const deltaY = e.clientY - telemetryDragRef.current.startY
    const deltaPct = (deltaY / parentHeight) * 100
    const newPct = Math.max(15, Math.min(85, telemetryDragRef.current.startPct + deltaPct))
    setProcsPercent(newPct)
  }, [])

  const onTelemetryDividerPointerUp = useCallback(() => {
    telemetryDragRef.current = null
  }, [])
```

- [ ] **Step 3: Replace the right panel JSX**

Find the right panel rendering block. Currently it looks like this (approximately lines 358-381):

```tsx
        <div
          data-testid="focus-zone-right-panel"
          className={`flex ${focusZone === 'right-panel' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
        >
          {procsCollapsed ? (
            <div
              data-testid="collapsed-procedures"
              className="w-6 flex flex-col items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover"
              onClick={() => setProcsCollapsed(false)}
            >
              <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr]">Procs</span>
            </div>
          ) : (
            <ProceduresPanel
              taskId={run.taskId}
              sessionId={run.sessionId}
              sessionStatus={run.status}
              onCollapse={() => setProcsCollapsed(true)}
              onFocusTerminal={() => {
                pushFocus({ id: run.id, type: 'run-terminal', label: 'Terminal' })
              }}
            />
          )}
        </div>
```

Replace it with:

```tsx
        <div
          data-testid="focus-zone-right-panel"
          className={`flex ${focusZone === 'right-panel' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
        >
          {procsCollapsed ? (
            <div
              data-testid="collapsed-procedures"
              className="w-6 flex flex-col items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover"
              onClick={() => setProcsCollapsed(false)}
            >
              <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr]">Procs</span>
            </div>
          ) : (
            <div className="w-40 flex flex-col bg-surface-panel">
              {/* Procedures — top section */}
              <div style={{ height: `${procsPercent}%` }} className="flex flex-col min-h-[60px] overflow-hidden">
                <ProceduresPanel
                  taskId={run.taskId}
                  sessionId={run.sessionId}
                  sessionStatus={run.status}
                  onCollapse={() => setProcsCollapsed(true)}
                  onFocusTerminal={() => {
                    pushFocus({ id: run.id, type: 'run-terminal', label: 'Terminal' })
                  }}
                />
              </div>

              {/* Draggable divider */}
              <div
                className="h-1 flex-shrink-0 bg-slate-800 hover:bg-slate-600 cursor-row-resize flex items-center justify-center transition-colors"
                onPointerDown={onTelemetryDividerPointerDown}
                onPointerMove={onTelemetryDividerPointerMove}
                onPointerUp={onTelemetryDividerPointerUp}
              >
                <div className="w-5 h-0.5 bg-slate-600 rounded-full" />
              </div>

              {/* Telemetry — bottom section */}
              <div style={{ height: `${100 - procsPercent}%` }} className="flex flex-col min-h-[60px] overflow-hidden">
                <TelemetryPanel
                  sessionId={run.sessionId}
                  runAccent={runAccent}
                />
              </div>
            </div>
          )}
        </div>
```

**Important:** ProceduresPanel currently applies its own `w-40` class. Since the outer wrapper now provides `w-40`, you need to remove the `w-40` from ProceduresPanel's root element. Open `src/components/RunWorkspaceWidget/ProceduresPanel.tsx` and change:

```tsx
<section className="w-40 flex flex-col bg-surface-panel">
```

to:

```tsx
<section className="flex flex-col flex-1 min-h-0 bg-surface-panel">
```

This makes ProceduresPanel fill its parent rather than setting its own width (the parent wrapper now controls both width and height).

- [ ] **Step 4: Verify it type-checks**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Visual verification**

Run:
```bash
npm run dev
```

Open a run workspace in the browser. Verify:
1. The right panel shows Procedures (top) and Telemetry (bottom) split ~50/50
2. The horizontal divider is visible between them and changes cursor to `row-resize` on hover
3. Dragging the divider adjusts the split (both sections respect the 60px minimum)
4. The "Load Context" button with the `query_stats` icon appears in the telemetry section
5. Collapsing the panel (clicking the collapse chevron) still hides the entire right panel
6. Expanding it again restores both sections

- [ ] **Step 6: Commit**

```bash
git add src/components/RunWorkspaceWidget/index.tsx src/components/RunWorkspaceWidget/ProceduresPanel.tsx
git commit -m "feat(telemetry): split right panel with draggable divider for telemetry"
```

---

### Task 6: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Test the full flow with a running session**

Start the dev server and open a run workspace that has an active Claude session (a session with a `conversation.id`).

1. Click "Load Context" in the telemetry section
2. Verify the loading shimmer appears
3. After ~10-15 seconds, the treemap should render with accent-colored cells
4. Hover over cells — tooltips should appear with category name, token count, percentage, and description
5. The footer should show "loaded just now" which updates to "loaded 30s ago" after 30 seconds
6. Click the refresh button — should re-enter loading state and update

- [ ] **Step 2: Test error handling**

1. Open a run workspace for a session without a conversation ID (freshly created, not yet started)
2. Use the browser devtools Network tab to call `GET /api/sessions/<name>/context`
3. Verify it returns 404 with `NO_CONVERSATION` error code

- [ ] **Step 3: Test the collapsed state**

1. Collapse the right panel via the chevron
2. Verify the thin "Procs" bar appears (same as before)
3. Expand it — both Procedures and Telemetry should reappear with the divider

- [ ] **Step 4: Final commit (if any touchups needed)**

```bash
git add -u
git commit -m "fix(telemetry): touchups from e2e testing"
```
