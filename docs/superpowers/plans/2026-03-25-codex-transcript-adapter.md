# Codex Transcript Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Tinstar to discover, read, and parse Codex JSONL transcripts for status detection and recap entries.

**Architecture:** New `codex-transcript.ts` module with three functions (discover, readStatus, parseRecap). The status watcher's `adapter === 'codex'` branch calls into this module. The existing `readTail` utility is exported from `transcript-parser.ts` for shared use.

**Tech Stack:** Node.js fs APIs, `tmux capture-pane` via `execFile`, existing JSONL tail-reading pattern.

---

### Task 1: Export `readTail` from transcript-parser.ts

**Files:**
- Modify: `src/server/sessions/transcript-parser.ts:8-24`

- [ ] **Step 1: Make `readTail` exported**

Change `function readTail` to `export function readTail` at line 8. No other changes needed — the function is already generic.

```typescript
/** Read the last N lines of a file without reading the entire thing. */
export function readTail(filePath: string, maxLines: number): string[] {
```

- [ ] **Step 2: Verify existing code still compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/transcript-parser.ts
git commit -m "refactor: export readTail for shared use by adapters"
```

---

### Task 2: Create codex-transcript.ts with discovery

**Files:**
- Create: `src/server/sessions/codex-transcript.ts`

- [ ] **Step 1: Create the module with `discoverTranscript`**

The function scans `~/.codex/sessions/` for JSONL files whose `session_meta.payload.cwd` matches the workspace, then cross-references agent message text against the tmux pane capture.

```typescript
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from '../logger'

const execFileAsync = promisify(execFile)

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

/** Read the last N bytes of a file and return as string. */
function tailBytes(filePath: string, bytes: number): string {
  const size = statSync(filePath).size
  if (size === 0) return ''
  const fd = openSync(filePath, 'r')
  try {
    const readFrom = Math.max(0, size - bytes)
    const buf = Buffer.alloc(Math.min(bytes, size))
    readSync(fd, buf, 0, buf.length, readFrom)
    return buf.toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

/** Extract agent message text from JSONL lines. */
function extractAgentMessages(jsonlText: string): string[] {
  const messages: string[] = []
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type !== 'event_msg') continue
      const p = obj.payload
      if (p?.type === 'agent_message' && p.message) {
        messages.push(p.message)
      } else if (p?.type === 'task_complete' && p.last_agent_message) {
        messages.push(p.last_agent_message)
      }
    } catch { /* skip malformed */ }
  }
  return messages
}

/** List candidate JSONL files from the creation date through today. */
function listCandidateFiles(createdAt: string): string[] {
  if (!existsSync(CODEX_SESSIONS_DIR)) return []
  const startDate = new Date(createdAt)
  const today = new Date()
  const files: string[] = []

  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear().toString()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const dayDir = join(CODEX_SESSIONS_DIR, yyyy, mm, dd)
    if (!existsSync(dayDir)) continue
    try {
      for (const f of readdirSync(dayDir)) {
        if (f.endsWith('.jsonl')) files.push(join(dayDir, f))
      }
    } catch { /* skip unreadable dirs */ }
  }

  // Most recent first
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/** Read the first line of a file to get session_meta. */
function readSessionMeta(filePath: string): { cwd: string; timestamp: string } | null {
  try {
    const fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(2048)
    const bytesRead = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0]
    if (!firstLine) return null
    const obj = JSON.parse(firstLine)
    if (obj.type !== 'session_meta') return null
    return {
      cwd: obj.payload?.cwd ?? '',
      timestamp: obj.payload?.timestamp ?? obj.timestamp ?? '',
    }
  } catch {
    return null
  }
}

/**
 * Discover the Codex JSONL transcript for a Tinstar session.
 * Matches by workdir + cross-references agent text against tmux pane.
 */
export async function discoverTranscript(
  sessionName: string,
  workdir: string,
  createdAt: string,
  tmuxTarget: string,
): Promise<string | null> {
  const candidates = listCandidateFiles(createdAt)
  const cwdMatches = candidates.filter(f => {
    const meta = readSessionMeta(f)
    return meta && meta.cwd === workdir
  })

  if (cwdMatches.length === 0) return null
  if (cwdMatches.length === 1) return cwdMatches[0]!

  // Multiple matches — cross-reference with tmux pane
  let tmuxText: string
  try {
    const { stdout } = await execFileAsync('tmux', ['capture-pane', '-t', tmuxTarget, '-p', '-S', '-200'])
    tmuxText = stdout
  } catch {
    // Can't capture pane — return most recent match
    return cwdMatches[0]!
  }

  for (const f of cwdMatches) {
    const tail = tailBytes(f, 8192)
    const messages = extractAgentMessages(tail)
    // Check if any agent message (30+ chars for specificity) appears in tmux
    for (const msg of messages) {
      const snippet = msg.slice(0, 120)
      if (snippet.length >= 30 && tmuxText.includes(snippet)) {
        log.info('codex-transcript', `${sessionName}: matched ${f} via text: "${snippet.slice(0, 60)}..."`)
        return f
      }
    }
  }

  // No text match — fall back to most recent cwd match
  log.info('codex-transcript', `${sessionName}: no text match, using most recent cwd match`)
  return cwdMatches[0]!
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/codex-transcript.ts
git commit -m "feat: codex transcript discovery — match by cwd + text cross-reference"
```

---

### Task 3: Add status and recap parsing to codex-transcript.ts

**Files:**
- Modify: `src/server/sessions/codex-transcript.ts`

- [ ] **Step 1: Add `readCodexStatus` function**

Append to `codex-transcript.ts`:

```typescript
import { readTail } from './transcript-parser'
import type { RecapEntry } from '../../types'
import { randomUUID } from 'node:crypto'

/**
 * Read session status from a Codex JSONL transcript.
 * Scans backwards for task_started/task_complete events.
 */
export function readCodexStatus(transcriptPath: string): 'running' | 'idle' | null {
  if (!existsSync(transcriptPath)) return null
  const lines = readTail(transcriptPath, 20)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!)
      if (obj.type !== 'event_msg') continue
      const sub = obj.payload?.type
      if (sub === 'task_complete') return 'idle'
      if (sub === 'task_started') return 'running'
    } catch { /* skip */ }
  }
  return null
}
```

- [ ] **Step 2: Add `parseCodexRecapEntries` function**

Append to `codex-transcript.ts`. Uses the same offset-tracking pattern as the Claude parser:

```typescript
const codexOffsets = new Map<string, number>()

export function resetCodexOffset(sessionName: string): void {
  codexOffsets.delete(sessionName)
}

/**
 * Parse new recap entries from a Codex transcript.
 * Groups user_message + task_complete.last_agent_message into turns.
 */
export function parseCodexRecapEntries(sessionName: string, transcriptPath: string): RecapEntry[] {
  if (!existsSync(transcriptPath)) return []

  const content = readFileSync(transcriptPath, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())
  const lastOffset = codexOffsets.get(sessionName) ?? 0
  const newLines = lines.slice(lastOffset)
  if (newLines.length === 0) return []

  const entries: RecapEntry[] = []

  for (const line of newLines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type !== 'event_msg') continue
      const p = obj.payload
      const ts = obj.timestamp ?? new Date().toISOString()

      if (p?.type === 'user_message' && p.message) {
        entries.push({ id: randomUUID(), type: 'user', content: p.message, timestamp: ts })
      } else if (p?.type === 'task_complete' && p.last_agent_message) {
        entries.push({ id: randomUUID(), type: 'agent', content: p.last_agent_message, timestamp: ts })
      }
    } catch { /* skip */ }
  }

  codexOffsets.set(sessionName, lines.length)
  return entries
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/server/sessions/codex-transcript.ts
git commit -m "feat: codex status parsing and recap entry extraction"
```

---

### Task 4: Wire codex adapter into status-watcher.ts

**Files:**
- Modify: `src/server/sessions/status-watcher.ts:64-74`

- [ ] **Step 1: Import codex functions**

Add to the imports at the top of `status-watcher.ts`:

```typescript
import { discoverTranscript, readCodexStatus, parseCodexRecapEntries } from './codex-transcript'
```

- [ ] **Step 2: Add transcript cache to StatusWatcher class**

Add a new private field alongside `idleStreak` and `processTreeOverride`:

```typescript
/** Cached Codex transcript paths per session */
private readonly codexTranscripts = new Map<string, string>()
```

- [ ] **Step 3: Replace the non-claude adapter branch**

Replace the current `adapter !== 'claude'` block (lines 67-74) with codex-specific logic:

```typescript
    // Codex adapter: discover transcript, then parse status from it
    if (adapter === 'codex' && session.backend === 'tmux') {
      this.checkCodexSession(session)
      return
    }

    // Generic/unknown adapters: process-tree only
    if (adapter !== 'claude' && session.backend === 'tmux') {
      if (this.processTreeOverride.has(session.name)) {
        return
      }
      this.checkProcessTree(session)
      return
    }
```

- [ ] **Step 4: Add `checkCodexSession` method**

Add a new private method to the class:

```typescript
  private async checkCodexSession(session: Session): Promise<void> {
    const workdir = session.workspace?.path
    if (!workdir) return

    // Try cached path first
    let transcriptPath = this.codexTranscripts.get(session.name)

    // Validate cache — clear if file doesn't exist or is stale
    if (transcriptPath) {
      if (!existsSync(transcriptPath)) {
        this.codexTranscripts.delete(session.name)
        transcriptPath = undefined
      }
    }

    // Discover if no cache
    if (!transcriptPath) {
      const tmuxTarget = `tinstar-${session.name}`
      const discovered = await discoverTranscript(
        session.name,
        workdir,
        session.created,
        tmuxTarget,
      )
      if (discovered) {
        this.codexTranscripts.set(session.name, discovered)
        transcriptPath = discovered
        log.info('status-watcher', `${session.name}: codex transcript discovered at ${discovered}`)
      }
    }

    if (!transcriptPath) {
      // No transcript found yet — fall back to process-tree
      if (!this.processTreeOverride.has(session.name)) {
        this.checkProcessTree(session)
      }
      return
    }

    // Parse status from Codex JSONL
    const status = readCodexStatus(transcriptPath)
    if (!status) return

    if (status !== session.state) {
      this.transitionState(session, status)
    }

    // Parse recap entries on idle transitions
    if (status === 'idle' && this.opts.onRecapEntries) {
      try {
        const entries = parseCodexRecapEntries(session.name, transcriptPath)
        if (entries.length > 0) {
          this.opts.onRecapEntries(session.name, entries)
        }
      } catch (err) {
        log.warn('status-watcher', `codex recap parse failed for ${session.name}: ${err}`)
      }
    }
  }
```

Add this import at the top:

```typescript
import { existsSync } from 'node:fs'
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Manual test with sitehistory session**

Restart dev server. Check that the sitehistory-run4 session (which uses Codex) gets its transcript discovered and status parsed from JSONL instead of just process-tree.

Check logs for: `codex transcript discovered at...`

- [ ] **Step 7: Commit**

```bash
git add src/server/sessions/status-watcher.ts
git commit -m "feat: wire codex adapter into status watcher with transcript discovery"
```

---

### Task 5: Export codex-transcript from sessions index

**Files:**
- Modify: `src/server/sessions/index.ts`

- [ ] **Step 1: Check if sessions/index.ts re-exports modules**

Read the file to see the export pattern. If it re-exports from sub-modules, add codex-transcript. If not (modules are imported directly), skip this task.

- [ ] **Step 2: Commit if changed**

```bash
git add src/server/sessions/index.ts
git commit -m "chore: export codex-transcript from sessions index"
```
