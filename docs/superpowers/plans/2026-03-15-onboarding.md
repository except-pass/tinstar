# Tinstar Onboarding & Packaging Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tinstar push-button easy (`npx tinstar`) for Claude Code power users, with contextual in-app nudges replacing tutorials.

**Architecture:** Extract the backend from the Vite plugin into a standalone Node HTTP server. Ship a CLI that runs pre-flight checks, offers project registration from cwd, then starts the production server. Frontend gets smarter defaults (task-only grouping) and contextual empty states.

**Tech Stack:** Node.js HTTP server, `http-proxy` for websocket proxying, Vite (build-only), React + Tailwind (frontend nudges)

**Spec:** `docs/superpowers/specs/2026-03-15-onboarding-design.md`

---

## File Map

### New Files
| File | Purpose |
|------|---------|
| `src/server/standalone.ts` | Standalone Node HTTP server (production entry point) |
| `bin/tinstar.js` | CLI entry point: pre-flight checks, project detection, server launch |
| `src/components/EmptyCanvasHint.tsx` | "Press S" hint for empty canvas |
| `src/components/NoTasksToast.tsx` | One-time toast nudge when launching without tasks |

### Modified Files
| File | Change |
|------|--------|
| `src/server/index.ts` | Extract init logic into shared `createBackend()` function |
| `src/components/WorkspaceShell.tsx:45` | Default dimensions `['task']` instead of `['initiative', 'epic', 'task']` |
| `src/components/InfiniteCanvas.tsx` | Render `EmptyCanvasHint` when tree is empty |
| `src/components/CreateSessionDialog.tsx:241-250` | Add "+Add project" to project dropdown |
| `vite.config.ts` | Add proxy to standalone backend for dev mode |
| `package.json` | Add `bin` field, `build:server` script, production dependencies |
| `README.md` | Rewrite Quick Start with `npx tinstar` and agent install prompt |

---

## Chunk 1: Server Extraction

### Task 1: Extract shared init function from Vite plugin

**Files:**
- Modify: `src/server/index.ts:37-291`

The `configureServer()` hook in `tinstarBackend()` contains ~240 lines of initialization (event bus, document store, session rehydration, Caddy, reconciliation loops). Extract this into a standalone function that both the Vite plugin and the new standalone server can call.

- [ ] **Step 1: Create `initBackend()` function**

Extract lines 48-270 of `src/server/index.ts` into a new exported function:

```typescript
export interface BackendContext {
  bus: EventBus
  docStore: DocumentStore
  otelStore: OTelStore
  sse: SSEBroadcaster
  readyQueue: ReadyQueue
  sessionConfig: TinstarConfig | null
  startSimulator: () => void
  resetSimulator: () => void
}

export function initBackend(): BackendContext {
  // All the existing initialization code from configureServer(),
  // minus the server.middlewares.use() call at the end
}
```

The function returns a `BackendContext` that both the Vite plugin and standalone server use.

- [ ] **Step 2: Update `tinstarBackend()` to use `initBackend()`**

```typescript
export function tinstarBackend(): Plugin {
  return {
    name: 'tinstar-backend',
    configureServer(server) {
      const ctx = initBackend()
      server.middlewares.use((req, res, next) => {
        handleRequest(ctx, req, res)
          .then(handled => { if (!handled) next() })
          .catch(next)
      })
    },
  }
}
```

- [ ] **Step 3: Verify dev mode still works**

Run: `npm run dev`
Expected: Server starts, UI loads at localhost:5273, no regressions.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "refactor: extract initBackend() from Vite plugin for reuse"
```

---

### Task 2: Create standalone HTTP server

**Files:**
- Create: `src/server/standalone.ts`
- Modify: `package.json` (add build:server script)

- [ ] **Step 1: Create standalone server**

```typescript
// src/server/standalone.ts
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createReadStream, existsSync, statSync } from 'node:fs'
import httpProxy from 'http-proxy'
import { initBackend } from './index'
import { handleRequest } from './api/routes'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function startServer(options: { port: number; clientDir: string; open?: boolean }) {
  const ctx = initBackend()
  const { port, clientDir } = options

  const server = createServer(async (req, res) => {
    // API routes first
    const handled = await handleRequest(ctx, req, res).catch(() => false)
    if (handled) return

    // Static file serving for built frontend
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    let filePath = join(clientDir, url.pathname === '/' ? 'index.html' : url.pathname)

    // SPA fallback — serve index.html for non-file routes
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = join(clientDir, 'index.html')
    }

    const ext = filePath.slice(filePath.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  })

  // WebSocket proxy for /s/ → Caddy (started by Tinstar via ensureCaddy())
  const proxy = httpProxy.createProxyServer({ target: 'http://localhost:8088', ws: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/s/')) {
      proxy.ws(req, socket, head)
    }
  })

  server.listen(port, () => {
    console.log(`→ Tinstar running at http://localhost:${port}`)
    console.log(`→ Press S in the app to launch your first agent session`)
    if (options.open) {
      import('child_process').then(cp => {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
        cp.exec(`${cmd} http://localhost:${port}`)
      })
    }
  })

  // Try next port if occupied
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      startServer({ ...options, port: port + 1 })
    } else {
      throw err
    }
  })

  return server
}

// Auto-start when run directly (dev mode via tsx, or direct node invocation)
const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!) : 5273
const noOpen = args.includes('--no-open')
if (args.length > 0 || !process.argv[1]?.includes('node_modules')) {
  startServer({ port, clientDir: join(import.meta.dirname, '../../dist/client'), open: !noOpen })
}
```

- [ ] **Step 2: Add `http-proxy` dependency**

Run: `npm install http-proxy`
Run: `npm install -D @types/http-proxy`

- [ ] **Step 3: Add server build script to package.json**

Add to `scripts`:
```json
"build:server": "npx esbuild src/server/standalone.ts --bundle --platform=node --format=esm --outdir=dist/server --external:http-proxy"
```

Add to `scripts`:
```json
"build:all": "vite build --outDir dist/client && npm run build:server"
```

- [ ] **Step 4: Verify server builds**

Run: `npm run build:all`
Expected: `dist/client/` and `dist/server/` both produced.

- [ ] **Step 5: Commit**

```bash
git add src/server/standalone.ts package.json package-lock.json
git commit -m "feat: add standalone HTTP server for production use"
```

---

### Task 3: Create CLI entry point

**Files:**
- Create: `bin/tinstar.js`
- Modify: `package.json` (add bin field)

- [ ] **Step 1: Create the CLI script**

```javascript
#!/usr/bin/env node
// bin/tinstar.js — Tinstar CLI entry point

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function check(label, fn) {
  try {
    const result = fn()
    console.log(`${GREEN}✓${RESET} ${label}${result ? ` ${DIM}(${result})${RESET}` : ''}`)
    return true
  } catch (err) {
    console.log(`${RED}✗${RESET} ${label}`)
    console.log(`  ${DIM}→ ${err.message}${RESET}`)
    return false
  }
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

async function main() {
  console.log(`\n${BOLD}Tinstar${RESET} — Agent Orchestrator\n`)

  // Pre-flight checks
  let allPassed = true

  allPassed &= check('Claude Code installed', () => {
    const version = execSync('claude --version', { encoding: 'utf-8' }).trim()
    return `v${version}`
  })

  allPassed &= check('Claude authenticated', () => {
    const raw = execSync('claude auth status', { encoding: 'utf-8' }).trim()
    const status = JSON.parse(raw)
    if (!status.loggedIn) throw new Error('Run: claude auth login')
    return status.email
  })

  allPassed &= check('tmux installed', () => {
    execSync('which tmux', { encoding: 'utf-8' })
    return null
  })

  allPassed &= check('ttyd installed', () => {
    execSync('which ttyd', { encoding: 'utf-8' })
    return null
  })

  if (!allPassed) {
    console.log(`\n${DIM}Fix the issues above and re-run: npx tinstar${RESET}\n`)
    process.exit(1)
  }

  console.log()

  // Project detection
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: process.cwd() }).trim()
    const projectName = basename(gitRoot)
    const projectsFile = join(homedir(), '.config', 'tinstar', 'projects.json')

    let projects = {}
    try { projects = JSON.parse(readFileSync(projectsFile, 'utf-8')) } catch {}

    if (!Object.values(projects).includes(gitRoot)) {
      const answer = await ask(`📁 Detected project: ${BOLD}${projectName}${RESET} (${gitRoot})\n   Add as a Tinstar project? [Y/n] `)
      if (answer !== 'n' && answer !== 'no') {
        mkdirSync(join(homedir(), '.config', 'tinstar'), { recursive: true })
        projects[projectName] = gitRoot
        writeFileSync(projectsFile, JSON.stringify(projects, null, 2))
        console.log(`${GREEN}✓${RESET} Added ${projectName}\n`)
      } else {
        console.log()
      }
    }
  } catch {
    // Not a git repo — skip silently
  }

  // Start server
  const noOpen = process.argv.includes('--no-open')
  const { startServer } = await import('../dist/server/standalone.js')
  startServer({ port: 5273, clientDir: join(import.meta.dirname, '..', 'dist', 'client'), open: !noOpen })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Add bin field to package.json**

```json
"bin": {
  "tinstar": "bin/tinstar.js"
},
"type": "module"
```

- [ ] **Step 3: Make the script executable**

Run: `chmod +x bin/tinstar.js`

- [ ] **Step 4: Test the CLI locally**

Run: `npm run build:all && node bin/tinstar.js --no-open`
Expected: Pre-flight checks run, server starts, prints URL.

- [ ] **Step 5: Commit**

```bash
git add bin/tinstar.js package.json
git commit -m "feat: add CLI entry point for npx tinstar"
```

---

### Task 4: Update dev workflow for split architecture

**Files:**
- Modify: `vite.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Update vite.config.ts for dev proxy**

The Vite dev server proxies API calls to the standalone backend:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function devTitle(): import('vite').Plugin {
  return {
    name: 'dev-title',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace('<title>Tinstar', '<title>[DEV] Tinstar')
    },
  }
}

export default defineConfig({
  plugins: [react(), devTitle()],
  server: {
    port: 5273,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/': {
        target: 'http://localhost:5274',
      },
      '/s/': {
        target: 'http://localhost:8088',
        ws: true,
      },
    },
  },
})
```

- [ ] **Step 2: Update dev script in package.json**

Use `concurrently` to run both Vite and the backend:

Run: `npm install -D concurrently`

Update scripts:
```json
"dev:backend": "tsx watch src/server/standalone.ts -- --port 5274 --no-open",
"dev:frontend": "vite",
"dev": "concurrently -n be,fe -c blue,green \"npm run dev:backend\" \"npm run dev:frontend\""
```

Note: The standalone server already has top-level arg parsing and auto-start (added in Task 2). The `tsx watch` command passes `--port 5274 --no-open` which the server reads from `process.argv`.

- [ ] **Step 3: Add `tsx` as dev dependency**

Run: `npm install -D tsx`

- [ ] **Step 4: Verify dev mode works**

Run: `npm run dev`
Expected: Both backend and frontend start. Frontend on :5273 with HMR, backend on :5274, API calls proxied correctly.

- [ ] **Step 5: Run E2E tests**

Run: `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test`
Expected: Tests pass.

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts package.json package-lock.json
git commit -m "feat: split dev workflow — Vite for frontend HMR, standalone backend"
```

---

## Chunk 2: Frontend Onboarding UX

### Task 5: Change default grouping to task-only

**Files:**
- Modify: `src/components/WorkspaceShell.tsx:45`

- [ ] **Step 1: Change default dimensions**

In `WorkspaceShell.tsx`, line 45, change:

```typescript
return ['initiative', 'epic', 'task']
```

to:

```typescript
return ['task']
```

This only affects users with no saved `tinstar-dimensions` in localStorage.

- [ ] **Step 2: Verify in browser**

Clear localStorage (`tinstar-dimensions` key), reload. Should show only Task as active pill. Initiative, Epic, Worktree should appear as `+` addable pills.

- [ ] **Step 3: Verify existing prefs preserved**

Set `tinstar-dimensions` to `'["initiative","task"]'` in localStorage, reload. Should show Initiative and Task as active, not reset to default.

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceShell.tsx
git commit -m "feat: default grouping to task-only for new users"
```

---

### Task 6: Add empty canvas "Press S" hint

**Files:**
- Create: `src/components/EmptyCanvasHint.tsx`
- Modify: `src/components/InfiniteCanvas.tsx`

- [ ] **Step 1: Create EmptyCanvasHint component**

```tsx
// src/components/EmptyCanvasHint.tsx
export function EmptyCanvasHint() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="flex items-center gap-2 text-slate-500">
        <span className="text-sm">Press</span>
        <kbd className="px-2 py-1 bg-surface-raised border border-white/10 rounded text-xs font-mono text-slate-300">
          S
        </kbd>
        <span className="text-sm">to launch your first session</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Render in InfiniteCanvas when empty**

In `InfiniteCanvas.tsx`, import `EmptyCanvasHint` and render it when no runs exist. Use `runMap.size` (not `renderedNodes.length`, which includes group container nodes). Find the canvas render area (around line 689-699) and add:

```tsx
{runMap.size === 0 && <EmptyCanvasHint />}
```

Render inside the canvas container but outside the transformed layer, so it's centered on screen regardless of pan/zoom.

- [ ] **Step 3: Verify in browser**

With no runs, the hint should appear centered. Create a session — the hint disappears immediately.

- [ ] **Step 4: Commit**

```bash
git add src/components/EmptyCanvasHint.tsx src/components/InfiniteCanvas.tsx
git commit -m "feat: show 'Press S' hint on empty canvas"
```

---

### Task 7: Add "+Add project" to session modal project dropdown

**Files:**
- Modify: `src/components/CreateSessionDialog.tsx:241-250`

- [ ] **Step 1: Add state for inline project creation**

Add to the component's existing state declarations:

```typescript
const [addingProject, setAddingProject] = useState(false)
const [newProjectPath, setNewProjectPath] = useState('')
```

- [ ] **Step 2: Replace the `<select>` with enhanced dropdown**

Replace the project `<select>` (lines 241-250) with:

```tsx
<select
  value={addingProject ? '__add__' : project}
  onChange={e => {
    if (e.target.value === '__add__') {
      setAddingProject(true)
    } else {
      setProject(e.target.value)
      setAddingProject(false)
    }
  }}
  className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
>
  {projects.length === 0 ? (
    <option value="" disabled>No projects yet — add one to get started</option>
  ) : (
    <option value="">None</option>
  )}
  {projects.map(p => (
    <option key={p.name} value={p.name}>{p.name}</option>
  ))}
  <option value="__add__">+ Add project</option>
</select>
{addingProject && (
  <div className="mt-2 flex gap-2">
    <input
      type="text"
      value={newProjectPath}
      onChange={e => setNewProjectPath(e.target.value)}
      placeholder="/path/to/project"
      autoFocus
      className="flex-1 px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
      onKeyDown={e => {
        if (e.key === 'Enter' && newProjectPath.trim()) {
          const name = newProjectPath.trim().split('/').pop() || 'project'
          fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, path: newProjectPath.trim() }),
          }).then(r => r.json()).then(() => {
            setProjects(prev => [...prev, { name, path: newProjectPath.trim() }])
            setProject(name)
            setAddingProject(false)
            setNewProjectPath('')
          })
        } else if (e.key === 'Escape') {
          setAddingProject(false)
          setNewProjectPath('')
        }
      }}
    />
  </div>
)}
```

- [ ] **Step 3: Verify in browser**

Open session dialog. With zero projects: shows "No projects yet" + "+ Add project". With projects: shows normal list + "+ Add project" at bottom. Click "+Add project" → inline input appears → type path → Enter → project registers and is selected.

- [ ] **Step 4: Commit**

```bash
git add src/components/CreateSessionDialog.tsx
git commit -m "feat: inline project creation in session dialog"
```

---

### Task 8: Add no-tasks nudge toast

**Files:**
- Create: `src/components/NoTasksToast.tsx`
- Modify: `src/components/WorkspaceShell.tsx`

- [ ] **Step 1: Create NoTasksToast component**

```tsx
// src/components/NoTasksToast.tsx
import { useState, useEffect } from 'react'

const DISMISSED_KEY = 'tinstar-no-tasks-nudge-dismissed'

export function NoTasksToast({ taskCount, runCount }: { taskCount: number; runCount: number }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Show only when: runs exist, no tasks, and not previously dismissed
    if (runCount > 0 && taskCount === 0 && !localStorage.getItem(DISMISSED_KEY)) {
      setVisible(true)
    }
  }, [taskCount, runCount])

  if (!visible) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-surface-raised border border-white/10 rounded-lg shadow-lg p-4 text-xs text-slate-300 animate-in slide-in-from-bottom-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-slate-200 font-medium mb-1">Tip: Tinstar works best with tasks</p>
          <p className="text-slate-400">They help organize your agents' work and track progress.</p>
        </div>
        <button
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, '1')
            setVisible(false)
          }}
          className="text-slate-500 hover:text-slate-300 shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add to WorkspaceShell**

Import and render `NoTasksToast` in `WorkspaceShell.tsx`, passing the task and run counts. Use `taxRepo.getTasks()` (public method, not the private `.tasks` field):

```tsx
<NoTasksToast
  taskCount={taxRepo.getTasks().length}
  runCount={runRepo.getAll().length}
/>
```

Place near the end of the component's return, after other overlays/dialogs.

- [ ] **Step 3: Verify in browser**

With zero tasks and at least one run: toast appears at bottom-right. Click ✕ → disappears, never shows again (check localStorage). With tasks defined: never shows.

- [ ] **Step 4: Commit**

```bash
git add src/components/NoTasksToast.tsx src/components/WorkspaceShell.tsx
git commit -m "feat: one-time toast nudge when launching without tasks"
```

---

## Chunk 3: README & Packaging

### Task 9: Rewrite README for users

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the Quick Start section**

Replace the current Quick Start (lines 31-36) with:

```markdown
## Quick Start

### Install with an agent

Paste this into Claude Code:

> Install and launch Tinstar for me. Run `npx tinstar` and fix any
> missing dependencies it reports until it starts successfully.

### Manual install

```bash
npx tinstar
```

The CLI checks for dependencies (Claude Code, tmux, ttyd), offers to register your current directory as a project, and starts the server.
```

- [ ] **Step 2: Update Prerequisites section**

Update to reflect tmux-first approach:

```markdown
## Prerequisites

- **Node.js 20+** — runtime
- **Claude Code** — installed and authenticated (`claude auth login`)
- **tmux** — session multiplexing (`brew install tmux` / `apt install tmux`)
- **ttyd** — web terminal (`brew install ttyd` / [download binary](https://github.com/tsl0922/ttyd/releases))
- **Docker** (optional) — for isolated container sessions
```

- [ ] **Step 3: Update Development section**

Distinguish user workflow from contributor workflow:

```markdown
## Development

For contributors working on Tinstar itself:

```bash
git clone <repo> && cd tinstar
npm install
npm run dev          # Vite HMR + backend (hot-reload)
npx tsc --noEmit     # Type check
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test  # E2E tests
```
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for npx tinstar user experience"
```

---

### Task 10: Prepare npm package publishing

**Files:**
- Modify: `package.json`
- Create: `.npmignore`

- [ ] **Step 1: Update package.json for publishing**

Add/update these fields (and **remove `"private": true`** which blocks npm publish):

```json
{
  "name": "tinstar",
  "version": "3.2.0",
  "private": false,
  "description": "Agent orchestrator — manage multiple Claude Code sessions from a visual canvas",
  "bin": {
    "tinstar": "bin/tinstar.js"
  },
  "type": "module",
  "files": [
    "bin/",
    "dist/client/",
    "dist/server/",
    "README.md"
  ],
  "keywords": ["claude", "agent", "orchestrator", "ai", "tmux"],
  "license": "MIT"
}
```

The `files` field ensures only the built output ships — no source code, no tests, no docs.

- [ ] **Step 2: Create .npmignore**

```
src/
e2e/
docs/
scripts/
backlog/
.claude/
*.config.*
tsconfig.json
```

- [ ] **Step 3: Add prepublish script**

```json
"prepublishOnly": "npm run build:all"
```

This ensures the package is always built before publishing.

- [ ] **Step 4: Test local pack**

Run: `npm pack --dry-run`
Expected: Only `bin/`, `dist/client/`, `dist/server/`, `README.md`, and `package.json` are included.

- [ ] **Step 5: Test with npx locally**

Run: `npm pack` then `npx ./tinstar-3.2.0.tgz --no-open`
Expected: Pre-flight checks run, server starts.

- [ ] **Step 6: Commit**

```bash
git add package.json .npmignore
git commit -m "feat: prepare package for npm publishing"
```

---

## Execution Order & Dependencies

```
Task 1 (extract initBackend)
  └─→ Task 2 (standalone server)
       └─→ Task 3 (CLI entry point)
            └─→ Task 4 (dev workflow split)

Task 5 (default grouping)        ← independent
Task 6 (empty canvas hint)       ← independent
Task 7 (project dropdown)        ← independent
Task 8 (no-tasks toast)          ← independent

Task 9 (README)                  ← after Task 3
Task 10 (npm packaging)          ← after Tasks 1-4
```

Tasks 5-8 are independent of each other and of Tasks 1-4. They can be parallelized.
Tasks 9-10 depend on the server extraction being complete.
