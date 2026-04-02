# Ad-Hoc Hands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable ad-hoc spawning of collaborator agents ("Hands") from any running session, with discovery via NATS task broadcast.

**Architecture:** Hand definitions are `.md` files with YAML frontmatter (Claude CLI agent format) stored in `~/.config/tinstar/hands/`. A new HandsPanel component in the left sidebar lists available hands. Dragging a hand onto the canvas spawns a sibling session on the same task/worktree. Agents discover each other via existing NATS task broadcast subscriptions.

**Tech Stack:** React, TypeScript, js-yaml, existing session/NATS infrastructure

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/server/hands/parser.ts` | Parse hand definition files (YAML frontmatter + markdown body) |
| `src/server/hands/discovery.ts` | Discover hands from `~/.config/tinstar/hands/` |
| `src/server/hands/index.ts` | Re-export hand loader API |
| `src/components/RunWorkspaceWidget/HandsPanel.tsx` | UI panel listing available hands with drag support |
| `src/server/api/routes.ts` | Add `GET /api/hands` and `POST /api/sessions/:id/spawn` endpoints |
| `src/server/patterns/parser.ts` | Update to support `hand:` references and `orchestrator:` field |

---

### Task 1: Hand Definition Parser

**Files:**
- Create: `src/server/hands/parser.ts`
- Test: `src/server/hands/__tests__/parser.test.ts`

- [ ] **Step 1: Write the failing test for parseHandFile**

```typescript
// src/server/hands/__tests__/parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseHandFile } from '../parser'

describe('parseHandFile', () => {
  it('parses a valid hand definition', () => {
    const content = `---
name: reviewer
description: Reviews code for quality and security
cliTemplate: Claude (multi-agent)
---

You are a code reviewer. Focus on edge cases and security.

<agent-protocol>
When you spawn, announce yourself on the task channel.
</agent-protocol>
`
    const hand = parseHandFile(content)
    expect(hand).not.toBeNull()
    expect(hand!.name).toBe('reviewer')
    expect(hand!.description).toBe('Reviews code for quality and security')
    expect(hand!.cliTemplate).toBe('Claude (multi-agent)')
    expect(hand!.prompt).toContain('You are a code reviewer')
    expect(hand!.prompt).toContain('<agent-protocol>')
  })

  it('returns null for invalid frontmatter', () => {
    const content = `No frontmatter here`
    expect(parseHandFile(content)).toBeNull()
  })

  it('returns null when name is missing', () => {
    const content = `---
description: Missing name field
---

Some prompt text.
`
    expect(parseHandFile(content)).toBeNull()
  })

  it('defaults cliTemplate to Claude (multi-agent)', () => {
    const content = `---
name: worker
description: General purpose worker
---

Do work.
`
    const hand = parseHandFile(content)
    expect(hand!.cliTemplate).toBe('Claude (multi-agent)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/hands/__tests__/parser.test.ts`
Expected: FAIL with "Cannot find module '../parser'"

- [ ] **Step 3: Write the parser implementation**

```typescript
// src/server/hands/parser.ts
import { load as parseYaml } from 'js-yaml'

export interface Hand {
  name: string
  description: string
  cliTemplate: string
  prompt: string
}

/**
 * Parse a hand definition file (markdown with YAML frontmatter).
 * Returns null if parsing fails or required fields are missing.
 */
export function parseHandFile(content: string): Hand | null {
  try {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontmatterMatch) return null

    const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>
    const prompt = frontmatterMatch[2].trim()

    const name = frontmatter.name as string
    if (!name) return null

    return {
      name,
      description: (frontmatter.description as string) ?? '',
      cliTemplate: (frontmatter.cliTemplate as string) ?? 'Claude (multi-agent)',
      prompt,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/hands/__tests__/parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/hands/parser.ts src/server/hands/__tests__/parser.test.ts
git commit -m "$(cat <<'EOF'
feat(hands): add hand definition parser

Parses .md files with YAML frontmatter into Hand objects.
Defaults cliTemplate to 'Claude (multi-agent)' when not specified.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Hand Discovery

**Files:**
- Create: `src/server/hands/discovery.ts`
- Create: `src/server/hands/index.ts`
- Test: `src/server/hands/__tests__/discovery.test.ts`

- [ ] **Step 1: Write the failing test for discoverHands**

```typescript
// src/server/hands/__tests__/discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverHands, getHandByName } from '../discovery'

describe('discoverHands', () => {
  const testDir = join(tmpdir(), `tinstar-hands-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('discovers hand files from directory', () => {
    writeFileSync(join(testDir, 'reviewer.md'), `---
name: reviewer
description: Code reviewer
---

Review code.
`)
    writeFileSync(join(testDir, 'worker.md'), `---
name: worker
description: General worker
---

Do work.
`)

    const hands = discoverHands(testDir)
    expect(hands).toHaveLength(2)
    expect(hands.map(h => h.name).sort()).toEqual(['reviewer', 'worker'])
  })

  it('skips invalid files', () => {
    writeFileSync(join(testDir, 'valid.md'), `---
name: valid
description: Valid hand
---

Prompt.
`)
    writeFileSync(join(testDir, 'invalid.md'), `No frontmatter`)
    writeFileSync(join(testDir, 'readme.txt'), `Not a markdown file`)

    const hands = discoverHands(testDir)
    expect(hands).toHaveLength(1)
    expect(hands[0]!.name).toBe('valid')
  })

  it('returns empty array for non-existent directory', () => {
    const hands = discoverHands('/nonexistent/path')
    expect(hands).toEqual([])
  })
})

describe('getHandByName', () => {
  const testDir = join(tmpdir(), `tinstar-hands-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, 'reviewer.md'), `---
name: reviewer
description: Code reviewer
---

Review code.
`)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns hand by name', () => {
    const hand = getHandByName('reviewer', testDir)
    expect(hand).not.toBeNull()
    expect(hand!.name).toBe('reviewer')
  })

  it('returns null for unknown hand', () => {
    const hand = getHandByName('unknown', testDir)
    expect(hand).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/hands/__tests__/discovery.test.ts`
Expected: FAIL with "Cannot find module '../discovery'"

- [ ] **Step 3: Write the discovery implementation**

```typescript
// src/server/hands/discovery.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseHandFile, type Hand } from './parser'

/** Default hands directory - lives alongside other Tinstar config */
export const DEFAULT_HANDS_DIR = join(homedir(), '.config', 'tinstar', 'hands')

/**
 * Discover all hand definition files in a directory.
 * Returns array of parsed hands, skipping invalid files.
 */
export function discoverHands(dir: string = DEFAULT_HANDS_DIR): Hand[] {
  if (!existsSync(dir)) return []

  const hands: Hand[] = []

  try {
    const files = readdirSync(dir)

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const hand = parseHandFile(content)
        if (hand) {
          hands.push(hand)
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return hands
}

/**
 * Get a specific hand by name.
 */
export function getHandByName(name: string, dir: string = DEFAULT_HANDS_DIR): Hand | null {
  const hands = discoverHands(dir)
  return hands.find(h => h.name === name) ?? null
}
```

- [ ] **Step 4: Create the index.ts barrel export**

```typescript
// src/server/hands/index.ts
export { parseHandFile, type Hand } from './parser'
export { discoverHands, getHandByName, DEFAULT_HANDS_DIR } from './discovery'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/server/hands/__tests__/discovery.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/hands/discovery.ts src/server/hands/index.ts src/server/hands/__tests__/discovery.test.ts
git commit -m "$(cat <<'EOF'
feat(hands): add hand discovery from ~/.config/tinstar/hands/

Discovers .md hand definitions from the hands directory.
Provides getHandByName for lookup by name.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Hands API Endpoints

**Files:**
- Modify: `src/server/api/routes.ts`
- Test: Manual verification via curl

- [ ] **Step 1: Add GET /api/hands endpoint**

In `src/server/api/routes.ts`, find the patterns endpoint section (around line 2432) and add the hands endpoint nearby:

```typescript
// Add import at top of file (around line 98, near the patterns import)
import { discoverHands, getHandByName } from '../hands'

// Add endpoint (after the patterns endpoint, around line 2446)
    // GET /api/hands
    if (method === 'GET' && url === '/api/hands') {
      const hands = discoverHands()
      const data = hands.map(h => ({
        name: h.name,
        description: h.description,
        cliTemplate: h.cliTemplate,
      }))
      return json(res, { ok: true, data })
    }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify manually**

Run: `curl http://localhost:5280/api/hands | jq`
Expected: `{"ok":true,"data":[]}` (empty array until hands are created)

- [ ] **Step 4: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "$(cat <<'EOF'
feat(api): add GET /api/hands endpoint

Returns list of available hand definitions for the UI.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Spawn API Endpoint

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Step 1: Add POST /api/sessions/:id/spawn endpoint**

In `src/server/api/routes.ts`, find the session routes section and add the spawn endpoint. Add it after the existing session action endpoints (around line 2100):

```typescript
    // POST /api/sessions/:name/spawn — spawn a companion hand on the same task
    if (method === 'POST' && url.startsWith('/api/sessions/') && url.endsWith('/spawn')) {
      const parentName = extractSessionName(url, '/api/sessions/')?.replace('/spawn', '')
      if (!parentName) return json(res, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Session name required' } }, 400)

      const parentSession = getSession(sessDir, parentName)
      if (!parentSession) return json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Session '${parentName}' not found` } }, 404)

      const body = await readBody(req)
      const { hand: handName, prompt: promptOverride, orchestrator } = body as {
        hand: string
        prompt?: string
        orchestrator?: boolean
      }

      if (!handName) {
        return json(res, { ok: false, error: { code: 'MISSING_HAND', message: 'hand field is required' } }, 400)
      }

      const hand = getHandByName(handName)
      if (!hand) {
        return json(res, { ok: false, error: { code: 'HAND_NOT_FOUND', message: `Hand '${handName}' not found` } }, 404)
      }

      // Generate unique session name
      const spawnedName = `${parentName}-${handName}-${shortId()}`

      // Build the prompt: hand base + optional override
      let fullPrompt = hand.prompt
      if (promptOverride) {
        fullPrompt = `${hand.prompt}\n\n---\n\n${promptOverride}`
      }

      // Resolve the parent's run to get taskId for NATS subject computation
      const parentRun = ctx.docStore.getRuns().find(r => r.sessionId === parentName)
      const taskId = parentRun?.taskId

      // Inherit workspace from parent session
      const workspace = parentSession.workspace

      // Build NATS subscriptions for the spawned session
      let natsConfig: { enabled: boolean; subscriptions: string[] } | null = null
      if (parentSession.nats?.enabled && taskId) {
        const natsSubject = buildNatsSubject(spawnedName, ctx.docStore, taskId)
        const subscriptions = computeNatsSubscriptions(natsSubject)
        natsConfig = { enabled: true, subscriptions }
      }

      // Resolve CLI template from hand definition
      const cliTemplate = hand.cliTemplate

      // Create the spawned session
      const session = createSession(sessDir, {
        name: spawnedName,
        backend: parentSession.backend,
        project: parentSession.project,
        workspace: {
          path: workspace.path,
          worktree: workspace.worktree,
          branch: workspace.branch,
          basePath: workspace.basePath,
        },
        profile: parentSession.profile,
        skipPermissions: parentSession.skipPermissions,
        cliTemplate,
        adapter: parentSession.adapter,
        nats: natsConfig,
      })

      emitSessionEvent('managed_session.created', { session })

      // Start the session with the combined prompt via --append-system-prompt
      const startCtx = {
        sessionsDir: sessDir,
        config: cfg,
        docStore: ctx.docStore,
        appendSystemPrompt: fullPrompt,
      }

      const backend = session.backend === 'docker' ? dockerBackend : tmuxBackend
      try {
        await backend.start(session, startCtx)
        setState(sessDir, spawnedName, 'running')
        emitSessionEvent('managed_session.state_changed', { name: spawnedName, state: 'running' })

        // Create a run entity linked to the same task as the parent
        if (taskId) {
          const runId = shortId()
          ctx.docStore.createRun({
            id: runId,
            taskId,
            sessionId: spawnedName,
            name: `${handName} (spawned)`,
            color: parentRun?.color,
          })
        }

        return json(res, {
          ok: true,
          data: {
            session: spawnedName,
            hand: handName,
            parentSession: parentName,
            orchestrator: orchestrator ?? false,
          },
        }, 201)
      } catch (err) {
        // Clean up on failure
        deleteSession(sessDir, spawnedName)
        return json(res, {
          ok: false,
          error: { code: 'SPAWN_FAILED', message: (err as Error).message },
        }, 500)
      }
    }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "$(cat <<'EOF'
feat(api): add POST /api/sessions/:id/spawn endpoint

Spawns a companion hand on the same task/worktree as the parent session.
Injects hand prompt via --append-system-prompt and inherits NATS config.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: HandsPanel UI Component

**Files:**
- Create: `src/components/RunWorkspaceWidget/HandsPanel.tsx`

- [ ] **Step 1: Create the HandsPanel component**

```typescript
// src/components/RunWorkspaceWidget/HandsPanel.tsx
import { useState, useEffect } from 'react'

interface Hand {
  name: string
  description: string
  cliTemplate: string
}

interface Props {
  sessionId: string
  onCollapse?: () => void
}

export function HandsPanel({ sessionId, onCollapse }: Props) {
  const [hands, setHands] = useState<Hand[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/hands')
      .then(res => res.json())
      .then(data => {
        if (data.ok) setHands(data.data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function handleDragStart(e: React.DragEvent, hand: Hand) {
    e.dataTransfer.setData('application/tinstar-hand', JSON.stringify({
      handName: hand.name,
      sessionId,
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  async function handleSpawn(handName: string, prompt?: string) {
    const res = await fetch(`/api/sessions/${sessionId}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hand: handName, prompt }),
    })
    const data = await res.json()
    if (!data.ok) {
      console.error('Spawn failed:', data.error)
    }
  }

  return (
    <section className="flex flex-col bg-surface-panel border-t border-primary/10">
      <div className="panel-header">
        <h3 className="panel-label flex items-center gap-1.5">
          <span>🤚</span>
          <span>Hands</span>
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs font-mono text-slate-600">{hands.length}</span>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="text-slate-500 hover:text-primary ml-1"
            >
              <span className="material-symbols-outlined text-sm">chevron_right</span>
            </button>
          )}
        </div>
      </div>

      <div data-scrollable className="flex-1 overflow-y-auto scrollbar-thin max-h-32">
        {loading ? (
          <div className="px-2 py-3 text-2xs font-mono text-slate-600 text-center animate-pulse">
            Loading...
          </div>
        ) : hands.length === 0 ? (
          <div className="px-2 py-3 text-2xs font-mono text-slate-700 text-center">
            No hands defined
          </div>
        ) : (
          hands.map(hand => (
            <div
              key={hand.name}
              draggable
              onDragStart={e => handleDragStart(e, hand)}
              onClick={() => handleSpawn(hand.name)}
              className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-primary/5 transition-colors cursor-grab active:cursor-grabbing"
              title={hand.description || hand.name}
            >
              <span className="text-xs">🤚</span>
              <span className="flex-1 text-2xs font-mono text-slate-400 group-hover:text-slate-300 truncate">
                {hand.name}
              </span>
            </div>
          ))
        )}
      </div>

      <button
        onClick={() => {
          const prompt = window.prompt('Enter prompt override (optional):')
          if (prompt !== null && hands.length > 0) {
            // For now, spawn the first hand with the custom prompt
            // TODO: Add hand selection dialog
            handleSpawn(hands[0]!.name, prompt || undefined)
          }
        }}
        className="m-2 flex items-center justify-center gap-1.5 py-1.5 border border-dashed border-primary/20 text-primary/40 hover:text-primary/70 hover:border-primary/40 transition-all rounded-sm"
        title="Spawn hand with custom prompt"
      >
        <span className="material-symbols-outlined text-sm">add</span>
        <span className="text-2xs font-bold font-display tracking-[0.12em] uppercase">Spawn</span>
      </button>
    </section>
  )
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/RunWorkspaceWidget/HandsPanel.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add HandsPanel component for spawning collaborators

Lists available hands with drag-to-spawn support.
Click spawns immediately, drag spawns at drop location.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Integrate HandsPanel into RunWorkspaceWidget

**Files:**
- Modify: `src/components/RunWorkspaceWidget/index.tsx`

- [ ] **Step 1: Import HandsPanel**

At the top of `src/components/RunWorkspaceWidget/index.tsx`, add the import (around line 7):

```typescript
import { HandsPanel } from './HandsPanel'
```

- [ ] **Step 2: Add state for hands panel collapse**

After the existing `procsCollapsed` state (around line 36), add:

```typescript
const [handsCollapsed, setHandsCollapsed] = useState(true)
```

- [ ] **Step 3: Add HandsPanel below the files panel**

Find the left sidebar section (the `filesCollapsed` conditional around line 204). Inside the expanded files panel div (around line 214), add the HandsPanel after the existing content but before the resize handle:

Replace the structure so the left panel contains both the files area and hands area. Update the left panel section:

```typescript
        ) : (
          <div
            className="flex flex-col bg-surface-panel relative flex-shrink-0 min-h-0"
            style={{ width: filesPanelWidth, borderRight: `1px solid ${hexToRgba(runAccent, 0.2)}` }}
          >
            {/* Mode toggle tabs */}
            <div
              data-testid="focus-zone-left-tab"
              className={`flex ${focusZone === 'left-tab' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
              style={{ borderBottom: `1px solid ${hexToRgba(runAccent, 0.15)}` }}
            >
              <button
                onClick={() => setFilePanelMode('touched')}
                className={`flex-1 px-2 py-1 text-2xs font-mono uppercase tracking-wider transition-colors ${
                  filePanelMode === 'touched'
                    ? ''
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-hover'
                }`}
                style={filePanelMode === 'touched' ? { color: runAccent, backgroundColor: hexToRgba(runAccent, 0.1), borderBottom: `1px solid ${runAccent}` } : undefined}
              >
                Changed
              </button>
              <button
                onClick={() => setFilePanelMode('tree')}
                className={`flex-1 px-2 py-1 text-2xs font-mono uppercase tracking-wider transition-colors ${
                  filePanelMode === 'tree'
                    ? ''
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-hover'
                }`}
                style={filePanelMode === 'tree' ? { color: runAccent, backgroundColor: hexToRgba(runAccent, 0.1), borderBottom: `1px solid ${runAccent}` } : undefined}
              >
                Explorer
              </button>
              <button
                onClick={() => setFilesCollapsed(true)}
                className="px-1 text-slate-500"
                style={{ color: runAccent }}
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
            </div>
            {/* Panel content - files take remaining space */}
            <div
              data-testid="focus-zone-file-list"
              className={`flex flex-col flex-1 min-h-0 overflow-hidden ${focusZone === 'file-list' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
            >
              {filePanelMode === 'touched' ? (
                <TouchedFilesPanel files={run.touchedFiles} sessionId={run.sessionId} onOpenFile={handleOpenFile} />
              ) : (
                <FileTreePanel sessionId={run.sessionId} onOpenFile={handleOpenFile} />
              )}
            </div>
            {/* Hands panel at bottom - only show if NATS enabled */}
            {run.natsEnabled && !handsCollapsed && (
              <HandsPanel
                sessionId={run.sessionId}
                onCollapse={() => setHandsCollapsed(true)}
              />
            )}
            {/* Collapsed hands indicator */}
            {run.natsEnabled && handsCollapsed && (
              <div
                className="h-6 flex items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover border-t border-primary/10"
                onClick={() => setHandsCollapsed(false)}
                title="Show Hands panel"
              >
                <span className="text-2xs font-mono text-slate-500 flex items-center gap-1">
                  <span>🤚</span>
                  <span>Hands</span>
                </span>
              </div>
            )}
            {/* Resize handle */}
            <div
              className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize transition-colors z-10"
              style={{ backgroundColor: hexToRgba(runAccent, 0.18) }}
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
            />
          </div>
        )}
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Verify visually**

Start dev server and verify the Hands panel appears in a NATS-enabled session's left sidebar.

- [ ] **Step 6: Commit**

```bash
git add src/components/RunWorkspaceWidget/index.tsx
git commit -m "$(cat <<'EOF'
feat(ui): integrate HandsPanel into RunWorkspaceWidget sidebar

Shows hands panel at bottom of left sidebar when NATS is enabled.
Panel is collapsible to save vertical space.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Canvas Drop Handler for Hands

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

- [ ] **Step 1: Add hand drop handler**

In `src/components/InfiniteCanvas.tsx`, find the existing drop handlers in `handleDrop` (look for `application/tinstar-nats` or similar). Add handling for `application/tinstar-hand`:

```typescript
    // Hand spawn drop
    const handData = e.dataTransfer.getData('application/tinstar-hand')
    if (handData) {
      try {
        const { handName, sessionId } = JSON.parse(handData) as { handName: string; sessionId: string }
        // Spawn the hand via API
        fetch(`/api/sessions/${sessionId}/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hand: handName }),
        })
          .then(res => res.json())
          .then(data => {
            if (data.ok) {
              // The spawned session will create a run, which will trigger SSE update
              // and the canvas will auto-add the new widget via useRunsForTask
              console.log('Hand spawned:', data.data.session)
            } else {
              console.error('Hand spawn failed:', data.error)
            }
          })
          .catch(err => console.error('Hand spawn error:', err))
      } catch {
        // Invalid data
      }
      return
    }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/InfiniteCanvas.tsx
git commit -m "$(cat <<'EOF'
feat(canvas): handle hand drops to spawn collaborators

Dropping a hand onto the canvas spawns it via the spawn API.
New run widget appears automatically via SSE update.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Update Pattern Parser for Hand References

**Files:**
- Modify: `src/server/patterns/parser.ts`
- Modify: `src/server/patterns/__tests__/parser.test.ts`

- [ ] **Step 1: Add test for hand reference parsing**

In `src/server/patterns/__tests__/parser.test.ts`, add:

```typescript
import { describe, it, expect } from 'vitest'
import { parsePatternFile } from '../parser'

describe('parsePatternFile with hands', () => {
  it('parses pattern with hand references', () => {
    const content = `---
name: review-critique
description: Code review pattern
orchestrator: reviewer
---

worker:
  hand: general-purpose
  prompt: |
    You do the implementation work.

reviewer:
  hand: reviewer
  dependsOn:
    worker:
      condition: ready
`
    const pattern = parsePatternFile(content)
    expect(pattern).not.toBeNull()
    expect(pattern!.name).toBe('review-critique')
    expect(pattern!.orchestrator).toBe('reviewer')
    expect(pattern!.sessions).toHaveLength(2)

    const worker = pattern!.sessions.find(s => s.role === 'worker')
    expect(worker?.config.hand).toBe('general-purpose')

    const reviewer = pattern!.sessions.find(s => s.role === 'reviewer')
    expect(reviewer?.config.hand).toBe('reviewer')
  })

  it('allows inline prompts for backward compatibility', () => {
    const content = `---
name: simple
description: Simple pattern
---

worker:
  prompt: |
    You are a worker. Do the work.
`
    const pattern = parsePatternFile(content)
    expect(pattern).not.toBeNull()
    expect(pattern!.sessions[0]?.config.prompt).toContain('You are a worker')
    expect(pattern!.sessions[0]?.config.hand).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/patterns/__tests__/parser.test.ts`
Expected: FAIL (orchestrator field not parsed)

- [ ] **Step 3: Update parser to support orchestrator and hand fields**

In `src/server/patterns/parser.ts`, update the interfaces and parsing:

```typescript
import { load as parseYaml } from 'js-yaml'

export interface PatternSessionConfig {
  backend?: 'tmux' | 'docker'
  project?: string
  worktree?: boolean
  worktreePath?: string
  skipPermissions?: boolean
  profile?: string
  cliTemplate?: string
  prompt?: string
  hand?: string  // NEW: reference to a hand definition

  // k8s-style orchestration (patterns-v2)
  dependsOn?: Record<string, { condition: 'ready' | 'started' }>
  replicas?: number
  readiness?: { nats: 'auto' | 'manual' }
}

export interface PatternSession {
  role: string
  config: PatternSessionConfig
}

export interface Pattern {
  name: string
  description: string
  orchestrator?: string  // NEW: which role is the orchestrator
  sessions: PatternSession[]
}

/**
 * Parse a pattern file content (markdown with YAML frontmatter and body).
 * Returns null if parsing fails.
 */
export function parsePatternFile(content: string): Pattern | null {
  try {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontmatterMatch) return null

    const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>
    const body = frontmatterMatch[2].trim()

    const name = frontmatter.name as string
    const description = (frontmatter.description as string) ?? ''
    const orchestrator = frontmatter.orchestrator as string | undefined  // NEW

    if (!name) return null

    const bodyYaml = parseYaml(body) as Record<string, unknown>
    if (!bodyYaml || typeof bodyYaml !== 'object') return null

    const sessions: PatternSession[] = []

    for (const [role, config] of Object.entries(bodyYaml)) {
      if (config && typeof config === 'object') {
        sessions.push({
          role,
          config: config as PatternSessionConfig,
        })
      }
    }

    return { name, description, orchestrator, sessions }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/patterns/__tests__/parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/patterns/parser.ts src/server/patterns/__tests__/parser.test.ts
git commit -m "$(cat <<'EOF'
feat(patterns): support hand references and orchestrator field

Patterns can now reference hand definitions via hand: field.
Explicit orchestrator: field declares the hub role.
Inline prompts still work for backward compatibility.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Resolve Hand References During Pattern Spawn

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Step 1: Update pattern spawn to resolve hand references**

In the pattern-based session creation section of `routes.ts` (around line 1793), update to resolve hand references:

Find where `interpolatedConfig` is used and add hand resolution:

```typescript
            const interpolatedConfig = interpolateSessionConfig(config, templateVars)

            // Resolve hand reference if present
            let sessionPrompt: string | undefined
            if (interpolatedConfig.hand) {
              const hand = getHandByName(interpolatedConfig.hand)
              if (!hand) {
                errors.push(`${sessionName}: hand '${interpolatedConfig.hand}' not found`)
                continue
              }
              // Use hand's prompt and cliTemplate
              sessionPrompt = hand.prompt
              if (interpolatedConfig.prompt) {
                sessionPrompt = `${hand.prompt}\n\n---\n\n${interpolatedConfig.prompt}`
              }
              // Override cliTemplate if not explicitly set
              if (!interpolatedConfig.cliTemplate) {
                interpolatedConfig.cliTemplate = hand.cliTemplate
              }
            } else if (role === 'orchestrator') {
              const patternPrompt = interpolatedConfig.prompt ?? ''
              sessionPrompt = prompt ? `${prompt}\n\n---\n\n${patternPrompt}` : patternPrompt
            } else {
              sessionPrompt = interpolatedConfig.prompt
            }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "$(cat <<'EOF'
feat(patterns): resolve hand references during pattern spawn

When a pattern session specifies hand: field, loads the hand definition
and uses its prompt and cliTemplate. Inline prompts override hand prompts.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Create Sample Hand Definitions

**Files:**
- Create: Sample hands in test fixtures (for documentation)

- [ ] **Step 1: Document the hand definition format**

Create example hands that users can copy to `~/.config/tinstar/hands/`:

```markdown
<!-- ~/.config/tinstar/hands/reviewer.md -->
---
name: reviewer
description: Reviews code for quality, edge cases, and security
cliTemplate: Claude (multi-agent)
---

You are a code reviewer. When introduced to other agents, announce yourself
and your capabilities. Respond to introduction messages with your own.

Focus on:
- Edge cases and error handling
- Security vulnerabilities
- Code clarity and maintainability
- Test coverage gaps

<agent-protocol>
When you spawn:
1. Announce yourself on the task channel: "Hi, I'm reviewer. I review code for quality, edge cases, and security."
2. Respond to other agents' introductions with yours
3. If you're the orchestrator, coordinate work across agents
</agent-protocol>
```

```markdown
<!-- ~/.config/tinstar/hands/general-purpose.md -->
---
name: general-purpose
description: General-purpose implementation agent
cliTemplate: Claude (multi-agent)
---

You are a general-purpose implementation agent. You handle coding tasks,
debugging, and feature implementation.

<agent-protocol>
When you spawn:
1. Announce yourself on the task channel: "Hi, I'm general-purpose. I handle implementation work."
2. Respond to other agents' introductions with yours
3. Wait for orchestrator instructions or proceed with the task at hand
</agent-protocol>
```

- [ ] **Step 2: Add to docs**

Update the spec document to reference these examples.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-02-ad-hoc-hands-design.md
git commit -m "$(cat <<'EOF'
docs(hands): add sample hand definitions

Includes reviewer and general-purpose hand examples
that users can copy to ~/.config/tinstar/hands/

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: End-to-End Verification

**Files:**
- No new files

- [ ] **Step 1: Create test hand definitions**

```bash
mkdir -p ~/.config/tinstar/hands
cat > ~/.config/tinstar/hands/reviewer.md << 'EOF'
---
name: reviewer
description: Reviews code for quality
cliTemplate: Claude (multi-agent)
---

You are a code reviewer. Announce yourself when spawned.
EOF
```

- [ ] **Step 2: Start dev server**

Run: `npm run dev`

- [ ] **Step 3: Verify hands API**

Run: `curl http://localhost:5280/api/hands | jq`
Expected: Shows the reviewer hand

- [ ] **Step 4: Test spawn API manually**

Create a session with NATS enabled, then:

Run: `curl -X POST http://localhost:5280/api/sessions/<session-name>/spawn -H 'Content-Type: application/json' -d '{"hand":"reviewer"}'`
Expected: Returns success with spawned session name

- [ ] **Step 5: Verify UI**

1. Open Tinstar in browser
2. Create a session with NATS enabled (use Claude (multi-agent) template)
3. Expand the left sidebar
4. Click "Hands" at the bottom to expand
5. Verify "reviewer" appears in the list
6. Drag reviewer onto the canvas
7. Verify a new sibling session spawns

- [ ] **Step 6: Commit verification notes**

No commit needed — this is manual verification.

---

## Summary

This plan implements the ad-hoc Hands feature in 11 tasks:

1. **Hand parser** — Parse `.md` files with YAML frontmatter
2. **Hand discovery** — Find hands in `~/.config/tinstar/hands/`
3. **Hands API** — `GET /api/hands` endpoint
4. **Spawn API** — `POST /api/sessions/:id/spawn` endpoint
5. **HandsPanel** — UI component for the sidebar
6. **Widget integration** — Add HandsPanel to RunWorkspaceWidget
7. **Canvas drop** — Handle hand drops on canvas
8. **Pattern parser** — Add `hand:` and `orchestrator:` fields
9. **Pattern spawn** — Resolve hand references at spawn time
10. **Sample hands** — Example definitions for documentation
11. **E2E verification** — Manual testing of the full flow
