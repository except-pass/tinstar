# Slash Command Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline slash-command autocompletion to the prompt composer in `RunSessionPanel.tsx`, with filesystem-based discovery, local usage tracking, OTLP telemetry, Tab-cycling, and ghost-text inline preview.

**Architecture:** Server-side singleton scans `~/.claude/{commands,skills}` and plugin caches with mtime-keyed caching invalidated by `fs.watch`; results merged with a small JSON usage-tracking file. A pure matcher module (token detection + scoring) is shared between unit tests and the React hook. The composer never blocks on the network — module-scoped client cache serves matches synchronously.

**Tech Stack:** Node fs + fs.watch (no new deps), React + Tailwind, Vite plugin server, existing `OtlpExporter` for counters. Tests use the project's Vitest + Playwright setup.

**Spec:** `docs/superpowers/specs/2026-05-05-slash-command-autocomplete-design.md`

---

## File Structure

**New files:**

| Path | Responsibility |
|------|---------------|
| `src/lib/slashMatching.ts` | Pure: token detection at cursor, scoring, ranking blend. No I/O. |
| `src/lib/__tests__/slashMatching.test.ts` | Unit tests for the above. |
| `src/server/sessions/slashCommandRegistry.ts` | Filesystem scan, mtime cache, fs.watch invalidation. |
| `src/server/sessions/__tests__/slashCommandRegistry.test.ts` | Tests over a tmp dir fixture. |
| `src/server/sessions/slashUsage.ts` | Load/save/increment `~/.config/tinstar/slash-usage.json`. |
| `src/server/sessions/__tests__/slashUsage.test.ts` | Tests over a tmp file. |
| `src/hooks/useSlashCommands.ts` | Module-singleton client cache, refresh-on-mount. |
| `src/components/RunWorkspaceWidget/SlashChips.tsx` | Status-bar chip strip. |

**Edited:**

| Path | Change |
|------|--------|
| `src/server/types.ts` | Add `SlashCommand` type if shared with client. |
| `src/server/api/routes.ts` (RouteContext at L526; prompt POST at L3269) | Register `GET /api/slash-commands`; hook usage increment + OTLP counter into prompt POST. |
| `src/server/index.ts` (L442) | Pass `otlpExporter` and `slashUsage` instances into `RouteContext`. |
| `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` (PromptComposer L167) | Wire detection, cycle state, ghost-text overlay, replace status row. |

---

## Task 1: Pure matcher module — token detection

**Files:**
- Create: `src/lib/slashMatching.ts`
- Test:   `src/lib/__tests__/slashMatching.test.ts`

- [ ] **Step 1: Write failing tests for `findSlashToken`**

```ts
// src/lib/__tests__/slashMatching.test.ts
import { describe, it, expect } from 'vitest'
import { findSlashToken } from '../slashMatching'

describe('findSlashToken', () => {
  it('detects slash at start of string', () => {
    expect(findSlashToken('/foo', 4)).toEqual({ start: 0, partial: 'foo' })
  })
  it('detects slash after a space', () => {
    expect(findSlashToken('please /foo', 11)).toEqual({ start: 7, partial: 'foo' })
  })
  it('detects slash after a newline', () => {
    expect(findSlashToken('hi\n/bar', 7)).toEqual({ start: 3, partial: 'bar' })
  })
  it('returns null for path-like slash (non-whitespace before)', () => {
    expect(findSlashToken('path/to/foo', 11)).toBeNull()
  })
  it('returns null when cursor is before any slash', () => {
    expect(findSlashToken('hello /foo', 3)).toBeNull()
  })
  it('handles empty partial (just typed `/`)', () => {
    expect(findSlashToken('/', 1)).toEqual({ start: 0, partial: '' })
  })
  it('returns null when cursor moves into whitespace after token', () => {
    expect(findSlashToken('/foo bar', 5)).toBeNull()
  })
  it('returns the token even if cursor is mid-token', () => {
    expect(findSlashToken('/foo', 2)).toEqual({ start: 0, partial: 'f' })
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/lib/__tests__/slashMatching.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `findSlashToken`**

```ts
// src/lib/slashMatching.ts
export interface SlashToken {
  /** Index of the leading `/` in the original text. */
  start: number
  /** Substring after the `/` and before the cursor. */
  partial: string
}

const WS_RE = /\s/

export function findSlashToken(text: string, cursor: number): SlashToken | null {
  // Walk back from cursor through non-whitespace to find token start.
  let i = cursor - 1
  while (i >= 0 && !WS_RE.test(text[i]!)) i--
  // text[i] is whitespace or i is -1; token candidate starts at i+1.
  const tokenStart = i + 1
  if (text[tokenStart] !== '/') return null
  return { start: tokenStart, partial: text.slice(tokenStart + 1, cursor) }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run src/lib/__tests__/slashMatching.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add src/lib/slashMatching.ts src/lib/__tests__/slashMatching.test.ts
git commit -m "feat(slash): pure findSlashToken cursor detector"
```

---

## Task 2: Pure matcher module — scoring + ranking

**Files:**
- Modify: `src/lib/slashMatching.ts`
- Modify: `src/lib/__tests__/slashMatching.test.ts`

- [ ] **Step 1: Write failing tests for scoring + `rankCommands`**

Append to `src/lib/__tests__/slashMatching.test.ts`:

```ts
import { rankCommands, type SlashCommand, type UsageEntry } from '../slashMatching'

const cmds: SlashCommand[] = [
  { name: 'full-review',  description: 'review pipeline',     source: 'user' },
  { name: 'flourish-test', description: 'flourish demo',       source: 'user' },
  { name: 'review',        description: 'review pull requests', source: 'user' },
  { name: 'tinstar-commit',description: 'commit with task tag', source: 'user' },
]

describe('rankCommands', () => {
  it('exact name match wins over prefix', () => {
    const out = rankCommands(cmds, 'review', {})
    expect(out[0]!.name).toBe('review')
  })
  it('prefix beats substring', () => {
    const out = rankCommands(cmds, 'full', {})
    expect(out[0]!.name).toBe('full-review')
  })
  it('substring matches when no prefix', () => {
    const out = rankCommands(cmds, 'commit', {})
    expect(out[0]!.name).toBe('tinstar-commit')
  })
  it('description matches with low score', () => {
    const out = rankCommands(cmds, 'pull', {})
    expect(out[0]!.name).toBe('review') // matches "pull requests" in description
  })
  it('empty partial uses recency+frequency only', () => {
    const usage: Record<string, UsageEntry> = {
      'full-review':  { count: 10, lastUsedAt: new Date(Date.now() - 1000).toISOString() },
      'review':       { count: 1,  lastUsedAt: new Date(Date.now() - 90 * 86400_000).toISOString() },
    }
    const out = rankCommands(cmds, '', usage)
    expect(out[0]!.name).toBe('full-review')
  })
  it('caps result list at 5', () => {
    const many: SlashCommand[] = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd-${i}`, description: '', source: 'user',
    }))
    expect(rankCommands(many, 'cmd', {})).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/lib/__tests__/slashMatching.test.ts`
Expected: FAIL — `rankCommands` not exported.

- [ ] **Step 3: Implement scoring and `rankCommands`**

Append to `src/lib/slashMatching.ts`:

```ts
export interface SlashCommand {
  name: string
  description: string
  source: 'project' | 'user' | 'plugin' | 'project-skill' | 'user-skill' | 'plugin-skill'
  argumentHint?: string | null
}

export interface UsageEntry {
  count: number
  lastUsedAt: string  // ISO
}

const MAX_RESULTS = 5

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

function matchScore(name: string, description: string, partial: string): number {
  if (!partial) return 0
  const n = name.toLowerCase()
  const d = description.toLowerCase()
  const p = partial.toLowerCase()
  if (n === p) return 1000
  if (n.startsWith(p)) return 900 - (n.length - p.length)
  if (n.includes(p)) return 700
  if (isSubsequence(p, n)) return 500
  if (d.includes(p)) return 200
  return 0
}

function recencyBoost(lastUsedAt: string | undefined): number {
  if (!lastUsedAt) return 0
  const age = Date.now() - new Date(lastUsedAt).getTime()
  if (age < 24 * 3600_000) return 100
  if (age < 7 * 24 * 3600_000) return 30
  return 0
}

function frequencyBoost(count: number | undefined): number {
  if (!count) return 0
  return Math.min(60, Math.floor(10 * Math.log2(1 + count)))
}

export function rankCommands(
  commands: SlashCommand[],
  partial: string,
  usage: Record<string, UsageEntry>,
): SlashCommand[] {
  const scored = commands.map(cmd => {
    const u = usage[cmd.name]
    const m = matchScore(cmd.name, cmd.description, partial)
    // When partial is non-empty, require at least a description-level match.
    // Otherwise (empty partial) include everything ranked by recency + frequency.
    const score = m + recencyBoost(u?.lastUsedAt) + frequencyBoost(u?.count)
    return { cmd, score, eligible: partial === '' || m > 0 }
  })
  return scored
    .filter(s => s.eligible)
    .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
    .slice(0, MAX_RESULTS)
    .map(s => s.cmd)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run src/lib/__tests__/slashMatching.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/slashMatching.ts src/lib/__tests__/slashMatching.test.ts
git commit -m "feat(slash): scoring ladder + recency/frequency ranking"
```

---

## Task 3: Server-side filesystem registry — discovery

**Files:**
- Create: `src/server/sessions/slashCommandRegistry.ts`
- Test:   `src/server/sessions/__tests__/slashCommandRegistry.test.ts`

- [ ] **Step 1: Write failing tests for `discoverSlashCommands`**

```ts
// src/server/sessions/__tests__/slashCommandRegistry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSlashCommands } from '../slashCommandRegistry'

let home: string
let cwd: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'slash-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'slash-cwd-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function write(path: string, contents: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

describe('discoverSlashCommands', () => {
  it('reads ~/.claude/commands/*.md', async () => {
    write(join(home, '.claude/commands/foo.md'), '---\ndescription: do foo\n---\nbody')
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'foo')).toMatchObject({
      name: 'foo', description: 'do foo', source: 'user',
    })
  })
  it('reads ~/.claude/skills/*/SKILL.md and uses dir name', async () => {
    write(
      join(home, '.claude/skills/my-skill/SKILL.md'),
      '---\nname: my-skill\ndescription: my skill desc\n---\nbody',
    )
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'my-skill')).toMatchObject({
      name: 'my-skill', description: 'my skill desc', source: 'user-skill',
    })
  })
  it('namespaces plugin skills as <plugin>:<skill>', async () => {
    write(
      join(home, '.claude/plugins/cache/marketplaceX/superpowers/1.0.0/skills/brainstorming/SKILL.md'),
      '---\nname: brainstorming\ndescription: brainstorm\n---\n',
    )
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'superpowers:brainstorming')).toMatchObject({
      source: 'plugin-skill',
    })
  })
  it('reads project commands from <cwd>/.claude/commands', async () => {
    write(join(cwd, '.claude/commands/local.md'), '---\ndescription: local\n---\n')
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds.find(c => c.name === 'local')).toMatchObject({ source: 'project' })
  })
  it('returns empty array when nothing exists', async () => {
    const cmds = await discoverSlashCommands({ home, cwd })
    expect(cmds).toEqual([])
  })
  it('falls back to filename when frontmatter has no description', async () => {
    write(join(home, '.claude/commands/noDesc.md'), '# heading\n')
    const cmds = await discoverSlashCommands({ home, cwd })
    const cmd = cmds.find(c => c.name === 'noDesc')!
    expect(cmd.description).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/server/sessions/__tests__/slashCommandRegistry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement discovery**

```ts
// src/server/sessions/slashCommandRegistry.ts
import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SlashCommand } from '../../lib/slashMatching'

// homedir/watch/FSWatcher are also used by the registry class added in Task 4.

export interface DiscoverOpts {
  home?: string  // defaults to os.homedir()
  cwd?: string   // defaults to process.cwd()
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(FRONTMATTER_RE)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) out[key] = val
  }
  return out
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
function safeStatIsDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}
function safeRead(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function loadCommandsDir(dir: string, source: SlashCommand['source']): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -3)
    const text = safeRead(join(dir, entry))
    if (text == null) continue
    const fm = parseFrontmatter(text)
    out.push({
      name,
      description: fm.description ?? '',
      source,
      argumentHint: fm['argument-hint'] ?? null,
    })
  }
  return out
}

function loadSkillsDir(dir: string, source: SlashCommand['source'], namespace?: string): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const entry of safeReaddir(dir)) {
    const skillDir = join(dir, entry)
    if (!safeStatIsDir(skillDir)) continue
    const text = safeRead(join(skillDir, 'SKILL.md'))
    if (text == null) continue
    const fm = parseFrontmatter(text)
    const baseName = fm.name ?? entry
    const name = namespace ? `${namespace}:${baseName}` : baseName
    out.push({
      name,
      description: fm.description ?? '',
      source,
    })
  }
  return out
}

function loadPluginCache(pluginsCacheDir: string): SlashCommand[] {
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{commands,skills}
  const out: SlashCommand[] = []
  for (const marketplace of safeReaddir(pluginsCacheDir)) {
    const mDir = join(pluginsCacheDir, marketplace)
    if (!safeStatIsDir(mDir)) continue
    for (const plugin of safeReaddir(mDir)) {
      const pDir = join(mDir, plugin)
      if (!safeStatIsDir(pDir)) continue
      for (const version of safeReaddir(pDir)) {
        const vDir = join(pDir, version)
        if (!safeStatIsDir(vDir)) continue
        out.push(...loadCommandsDir(join(vDir, 'commands'), 'plugin'))
        out.push(...loadSkillsDir(join(vDir, 'skills'), 'plugin-skill', plugin))
      }
    }
  }
  return out
}

export async function discoverSlashCommands(opts: DiscoverOpts = {}): Promise<SlashCommand[]> {
  const home = opts.home ?? homedir()
  const cwd  = opts.cwd  ?? process.cwd()
  return [
    ...loadCommandsDir(join(cwd, '.claude/commands'), 'project'),
    ...loadSkillsDir(join(cwd, '.claude/skills'), 'project-skill'),
    ...loadCommandsDir(join(home, '.claude/commands'), 'user'),
    ...loadSkillsDir(join(home, '.claude/skills'), 'user-skill'),
    ...loadPluginCache(join(home, '.claude/plugins/cache')),
  ]
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run src/server/sessions/__tests__/slashCommandRegistry.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/slashCommandRegistry.ts src/server/sessions/__tests__/slashCommandRegistry.test.ts
git commit -m "feat(slash): filesystem discovery of commands and skills"
```

---

## Task 4: Server-side registry — caching + fs.watch invalidation

**Files:**
- Modify: `src/server/sessions/slashCommandRegistry.ts`
- Modify: `src/server/sessions/__tests__/slashCommandRegistry.test.ts`

- [ ] **Step 1: Write a failing test for caching**

Append to `src/server/sessions/__tests__/slashCommandRegistry.test.ts`:

```ts
import { SlashCommandRegistry } from '../slashCommandRegistry'

describe('SlashCommandRegistry caching', () => {
  it('caches and invalidates on file change', async () => {
    write(join(home, '.claude/commands/a.md'), '---\ndescription: A\n---\n')
    const reg = new SlashCommandRegistry({ home, cwd })
    const first = await reg.list()
    expect(first.find(c => c.name === 'a')).toBeTruthy()

    // Same call returns cached (no rescan), still finds 'a'.
    const second = await reg.list()
    expect(second).toEqual(first)

    // Add another file, then call invalidate(); next list() rescans.
    write(join(home, '.claude/commands/b.md'), '---\ndescription: B\n---\n')
    reg.invalidate()
    const third = await reg.list()
    expect(third.find(c => c.name === 'b')).toBeTruthy()

    reg.dispose()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npx vitest run src/server/sessions/__tests__/slashCommandRegistry.test.ts -t caching`
Expected: FAIL — `SlashCommandRegistry` not exported.

- [ ] **Step 3: Implement `SlashCommandRegistry`**

Append to `src/server/sessions/slashCommandRegistry.ts`:

```ts
export class SlashCommandRegistry {
  private cache: SlashCommand[] | null = null
  private watchers: FSWatcher[] = []
  private opts: DiscoverOpts

  constructor(opts: DiscoverOpts = {}) {
    this.opts = opts
  }

  async list(): Promise<SlashCommand[]> {
    if (this.cache) return this.cache
    const cmds = await discoverSlashCommands(this.opts)
    this.cache = cmds
    this.installWatchers()
    return cmds
  }

  invalidate(): void {
    this.cache = null
  }

  dispose(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* already closed */ }
    }
    this.watchers = []
    this.cache = null
  }

  private installWatchers(): void {
    if (this.watchers.length > 0) return
    const home = this.opts.home ?? homedir()
    const cwd  = this.opts.cwd  ?? process.cwd()
    const dirs = [
      join(cwd,  '.claude/commands'),
      join(cwd,  '.claude/skills'),
      join(home, '.claude/commands'),
      join(home, '.claude/skills'),
      join(home, '.claude/plugins/cache'),
    ]
    for (const d of dirs) {
      try {
        const w = watch(d, { recursive: true }, () => this.invalidate())
        this.watchers.push(w)
      } catch {
        // Directory may not exist yet — that's fine, no rescan needed for it.
      }
    }
  }
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `npx vitest run src/server/sessions/__tests__/slashCommandRegistry.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/slashCommandRegistry.ts src/server/sessions/__tests__/slashCommandRegistry.test.ts
git commit -m "feat(slash): registry with mtime cache and fs.watch invalidation"
```

---

## Task 5: Local usage tracking

**Files:**
- Create: `src/server/sessions/slashUsage.ts`
- Test:   `src/server/sessions/__tests__/slashUsage.test.ts`

- [ ] **Step 1: Write failing tests for `SlashUsage`**

```ts
// src/server/sessions/__tests__/slashUsage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SlashUsage, extractLeadingSlashName } from '../slashUsage'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slash-usage-'))
  file = join(dir, 'usage.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractLeadingSlashName', () => {
  it('extracts `/foo`', () => expect(extractLeadingSlashName('/foo bar')).toBe('foo'))
  it('rejects non-leading slash', () => expect(extractLeadingSlashName('hello /foo')).toBeNull())
  it('rejects path-style', () => expect(extractLeadingSlashName('/foo/bar/baz')).toBe('foo'))
  it('returns null for plain text', () => expect(extractLeadingSlashName('hello')).toBeNull())
  it('handles namespaced names', () => expect(extractLeadingSlashName('/superpowers:brainstorming')).toBe('superpowers:brainstorming'))
})

describe('SlashUsage', () => {
  it('starts empty', () => {
    const u = new SlashUsage(file)
    expect(u.snapshot()).toEqual({})
  })
  it('increments and persists', async () => {
    const u = new SlashUsage(file)
    u.increment('foo')
    u.increment('foo')
    u.increment('bar')
    await u.flush()
    expect(existsSync(file)).toBe(true)
    const u2 = new SlashUsage(file)
    expect(u2.snapshot()['foo']!.count).toBe(2)
    expect(u2.snapshot()['bar']!.count).toBe(1)
  })
  it('LRU-evicts at cap', async () => {
    const u = new SlashUsage(file, { cap: 3 })
    u.increment('a'); await delay(2)
    u.increment('b'); await delay(2)
    u.increment('c'); await delay(2)
    u.increment('d')  // pushes 'a' out
    expect(u.snapshot()['a']).toBeUndefined()
    expect(Object.keys(u.snapshot()).sort()).toEqual(['b', 'c', 'd'])
  })
})

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)) }
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/server/sessions/__tests__/slashUsage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SlashUsage`**

```ts
// src/server/sessions/slashUsage.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UsageEntry } from '../../lib/slashMatching'

const LEADING_SLASH_RE = /^\/([A-Za-z0-9_:-]+)/

export function extractLeadingSlashName(text: string): string | null {
  const trimmed = text.trimStart()
  // Whitespace was trimmed; if `/` is now first, original was at start (no
  // non-whitespace before it).
  const m = trimmed.match(LEADING_SLASH_RE)
  return m ? m[1]! : null
}

export interface SlashUsageOpts {
  cap?: number
}

const DEFAULT_CAP = 1000

export class SlashUsage {
  private data: Record<string, UsageEntry> = {}
  private dirty = false
  private cap: number

  constructor(private filePath: string, opts: SlashUsageOpts = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch {
      // Corrupt file — start fresh.
      this.data = {}
    }
  }

  snapshot(): Record<string, UsageEntry> {
    return this.data
  }

  increment(name: string): void {
    const now = new Date().toISOString()
    const cur = this.data[name]
    this.data[name] = { count: (cur?.count ?? 0) + 1, lastUsedAt: now }
    this.dirty = true
    this.evictIfNeeded()
  }

  private evictIfNeeded(): void {
    const keys = Object.keys(this.data)
    if (keys.length <= this.cap) return
    const sorted = keys
      .map(k => ({ k, t: Date.parse(this.data[k]!.lastUsedAt) }))
      .sort((a, b) => a.t - b.t)
    const drop = sorted.slice(0, keys.length - this.cap)
    for (const { k } of drop) delete this.data[k]
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
    this.dirty = false
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run src/server/sessions/__tests__/slashUsage.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/slashUsage.ts src/server/sessions/__tests__/slashUsage.test.ts
git commit -m "feat(slash): local usage tracking with LRU eviction"
```

---

## Task 6: Wire registry + usage into RouteContext

**Files:**
- Modify: `src/server/api/routes.ts` (RouteContext at L526)
- Modify: `src/server/index.ts` (RouteContext construction at L442)

- [ ] **Step 1: Add fields to `RouteContext`**

Edit `src/server/api/routes.ts` at L526:

```ts
import type { SlashCommandRegistry } from '../sessions/slashCommandRegistry'
import type { SlashUsage } from '../sessions/slashUsage'
import type { OtlpExporter } from '../stores/otlp-exporter'

export interface RouteContext {
  docStore: DocumentStore
  otelStore: OTelStore
  sse: SSEBroadcaster
  bus: EventBus
  startSimulator: () => void
  resetSimulator: () => void
  sessionConfig: TinstarConfig | null
  readyQueue: ReadyQueue
  natsTraffic?: import('../nats-traffic').NatsTrafficBridge
  natsHealth?: import('../nats-health').NatsHealthMonitor
  readinessTracker?: import('../sessions/readiness').SessionReadinessTracker
  telemetryRoutes?: TelemetryRoutes
  ccQuotaService?: import('../cc-quota/service').CcQuotaService
  slashRegistry?: SlashCommandRegistry
  slashUsage?: SlashUsage
  otlpExporter?: OtlpExporter
}
```

- [ ] **Step 2: Construct and pass them in `initBackend`**

Edit `src/server/index.ts`. Near the top with other imports, add:

```ts
import { SlashCommandRegistry } from './sessions/slashCommandRegistry'
import { SlashUsage } from './sessions/slashUsage'
import { join } from 'node:path'
import { homedir } from 'node:os'
```

After `otlpExporter.start()` (around L59), add:

```ts
  const slashRegistry = new SlashCommandRegistry()
  const slashUsage = new SlashUsage(join(homedir(), '.config/tinstar/slash-usage.json'))
  // Debounced flush every 5s while dirty
  setInterval(() => { void slashUsage.flush() }, 5_000).unref()
```

Update the return at L442:

```ts
  return {
    docStore, otelStore, sse, bus, startSimulator, resetSimulator,
    sessionConfig, readyQueue, telemetryRoutes, ccQuotaService,
    slashRegistry, slashUsage, otlpExporter,
    get natsTraffic() { return natsTraffic },
    get natsHealth() { return natsHealth },
    get readinessTracker() { return readinessTracker },
  }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/server/api/routes.ts src/server/index.ts
git commit -m "feat(slash): plumb registry + usage + otlp into RouteContext"
```

---

## Task 7: `GET /api/slash-commands` endpoint

**Files:**
- Modify: `src/server/api/routes.ts` (add new route inside `handleRequest`)

- [ ] **Step 1: Add the route handler**

Insert near other `GET` routes in `handleRequest` (e.g. just after the `/api/cc-quota` GET around L675):

```ts
  if (method === 'GET' && url === '/api/slash-commands') {
    if (!ctx.slashRegistry) return json(res, { commands: [] })
    const commands = await ctx.slashRegistry.list()
    const usage = ctx.slashUsage?.snapshot() ?? {}
    const merged = commands.map(c => ({
      ...c,
      useCount: usage[c.name]?.count ?? 0,
      lastUsedAt: usage[c.name]?.lastUsedAt ?? null,
    }))
    return json(res, { commands: merged })
  }
```

- [ ] **Step 2: Quick smoke check**

Type-check + curl test (server must be running on the user's existing port — DO NOT start or kill the dev server):

Run: `npx tsc --noEmit`
Expected: PASS.

Then ask the user to verify by hitting their running server:
`curl -s http://localhost:5273/api/slash-commands | head -c 300`
Expected: a JSON object with `commands: [...]` containing entries from `~/.claude/commands/` and `~/.claude/skills/`.

- [ ] **Step 3: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat(slash): GET /api/slash-commands endpoint"
```

---

## Task 8: Hook usage increment + OTLP counter into prompt POST

**Files:**
- Modify: `src/server/api/routes.ts` (prompt POST handler around L3269)

- [ ] **Step 1: Update the handler**

Edit the prompt POST handler. The existing block looks like:

```ts
    const promptMatch = method === 'POST' && url.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
    if (promptMatch) {
      const sessionId = promptMatch[1]!
      const session = getSession(sessDir, sessionId)
      if (!session) {
        json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${sessionId}' not found` } }, 404)
        return true
      }
      readBody(req).then(async (body) => {
        const { text, force } = JSON.parse(body) as { text: string; force?: boolean }
        if (!force && session.state !== 'idle') {
          json(res, { error: 'session-not-ready' }, 400)
          return
        }
        if (!text) { json(res, { error: 'missing text' }, 400); return }
        try {
          if (session.backend === 'docker') {
            await dockerBackend.sendPrompt(cfg, sessionId, text)
          } else if (session.backend === 'tmux') {
            await tmuxBackend.sendPrompt(cfg, sessionId, text)
          } else {
            json(res, { error: 'input-unavailable' }, 503)
            return
          }
          json(res, { ok: true })
        } catch (err) {
          json(res, { error: (err as Error).message }, 500)
        }
      })
      return true
    }
```

Add the import at the top of `routes.ts`:

```ts
import { extractLeadingSlashName } from '../sessions/slashUsage'
```

Inside the `try` block, just after the successful `sendPrompt` call and before `json(res, { ok: true })`, add:

```ts
          // Track slash usage (fire-and-forget; never blocks response).
          const slashName = extractLeadingSlashName(text)
          if (slashName) {
            ctx.slashUsage?.increment(slashName)
            ctx.otlpExporter?.pushMetric({
              name: 'tinstar_slash_use_total',
              type: 'counter',
              value: 1,
              labels: { name: slashName },
              timestamp: new Date().toISOString(),
            })
          }
```

So the inner success branch becomes:

```ts
          if (session.backend === 'docker') {
            await dockerBackend.sendPrompt(cfg, sessionId, text)
          } else if (session.backend === 'tmux') {
            await tmuxBackend.sendPrompt(cfg, sessionId, text)
          } else {
            json(res, { error: 'input-unavailable' }, 503)
            return
          }
          const slashName = extractLeadingSlashName(text)
          if (slashName) {
            ctx.slashUsage?.increment(slashName)
            ctx.otlpExporter?.pushMetric({
              name: 'tinstar_slash_use_total',
              type: 'counter',
              value: 1,
              labels: { name: slashName },
              timestamp: new Date().toISOString(),
            })
          }
          json(res, { ok: true })
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat(slash): track usage on prompt send (local + OTLP)"
```

---

## Task 9: Client hook `useSlashCommands`

**Files:**
- Create: `src/hooks/useSlashCommands.ts`

- [ ] **Step 1: Implement the singleton hook**

```ts
// src/hooks/useSlashCommands.ts
import { useSyncExternalStore } from 'react'
import type { SlashCommand, UsageEntry } from '../lib/slashMatching'

export interface ServerSlashCommand extends SlashCommand {
  useCount: number
  lastUsedAt: string | null
}

interface State {
  commands: ServerSlashCommand[]
  usage: Record<string, UsageEntry>
  loaded: boolean
}

let state: State = { commands: [], usage: {}, loaded: false }
const listeners = new Set<() => void>()
let inflight = false

function emit() { for (const l of listeners) l() }
function setState(patch: Partial<State>) { state = { ...state, ...patch }; emit() }

async function refresh(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    const res = await fetch('/api/slash-commands')
    if (!res.ok) return
    const body = (await res.json()) as { commands: ServerSlashCommand[] }
    const usage: Record<string, UsageEntry> = {}
    for (const c of body.commands) {
      if (c.lastUsedAt) usage[c.name] = { count: c.useCount, lastUsedAt: c.lastUsedAt }
    }
    setState({ commands: body.commands, usage, loaded: true })
  } catch {
    // Network error — keep previous data.
  } finally {
    inflight = false
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (!state.loaded) void refresh()
  return () => listeners.delete(l)
}

function getSnapshot(): State { return state }

export interface UseSlashCommands {
  commands: ServerSlashCommand[]
  usage: Record<string, UsageEntry>
  refresh: () => void
}

export function useSlashCommands(): UseSlashCommands {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { commands: s.commands, usage: s.usage, refresh: () => void refresh() }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSlashCommands.ts
git commit -m "feat(slash): client hook with module-singleton cache"
```

---

## Task 10: `SlashChips` status-bar strip component

**Files:**
- Create: `src/components/RunWorkspaceWidget/SlashChips.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// src/components/RunWorkspaceWidget/SlashChips.tsx
import type { SlashCommand } from '../../lib/slashMatching'
import { hexToRgba } from '../runAccent'

interface Props {
  candidates: SlashCommand[]
  activeIndex: number
  accent: string
  onSelect: (index: number) => void
}

export function SlashChips({ candidates, activeIndex, accent, onSelect }: Props) {
  if (candidates.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 text-2xs font-mono overflow-hidden">
      <span className="text-slate-600 shrink-0">tab:</span>
      {candidates.map((cmd, i) => {
        const active = i === activeIndex
        return (
          <button
            key={cmd.name}
            type="button"
            onClick={() => onSelect(i)}
            title={cmd.description}
            className="px-1.5 py-0.5 rounded transition-colors shrink-0 truncate"
            style={{
              background: active ? hexToRgba(accent, 0.2) : 'transparent',
              color: active ? accent : hexToRgba(accent, 0.45),
              border: `1px solid ${active ? hexToRgba(accent, 0.5) : 'transparent'}`,
            }}
          >
            /{cmd.name}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/RunWorkspaceWidget/SlashChips.tsx
git commit -m "feat(slash): SlashChips status-bar strip"
```

---

## Task 11: Wire slash mode into `PromptComposer`

**Files:**
- Modify: `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` (PromptComposer at L167)

- [ ] **Step 1: Add imports**

Near the top of the file (after the existing imports):

```ts
import { findSlashToken, rankCommands, type SlashCommand } from '../../lib/slashMatching'
import { useSlashCommands } from '../../hooks/useSlashCommands'
import { SlashChips } from './SlashChips'
```

- [ ] **Step 2: Inside `PromptComposer`, add slash state**

After the existing `useState`/refs block (around L181), add:

```ts
  const { commands, usage, refresh: refreshSlash } = useSlashCommands()
  const [slashCursor, setSlashCursor] = useState<number>(0)
  const [cycleState, setCycleState] = useState<{ candidates: SlashCommand[]; index: number } | null>(null)

  const slashToken = findSlashToken(text, slashCursor)
  const candidates = slashToken
    ? (cycleState?.candidates ?? rankCommands(commands, slashToken.partial, usage))
    : []
  const activeIndex = cycleState?.index ?? 0
  const topMatch = candidates[activeIndex] ?? null
```

Refresh the list whenever the composer expands so disk changes show up immediately:

```ts
  useEffect(() => { if (isExpanded) refreshSlash() }, [isExpanded, refreshSlash])
```

- [ ] **Step 3: Update the `onChange` handler to track cursor**

Replace the existing textarea `onChange` (was `onChange={e => setText(e.target.value)}` at L318):

```tsx
            onChange={e => {
              setText(e.target.value)
              setSlashCursor(e.target.selectionStart ?? e.target.value.length)
              setCycleState(null)
            }}
            onSelect={e => setSlashCursor((e.target as HTMLTextAreaElement).selectionStart)}
```

- [ ] **Step 4: Add Tab handling to `handleKeyDown`**

Modify `handleKeyDown` (around L244). Insert this branch BEFORE the existing `Enter` and `PageUp/Down` branches:

```ts
    if (e.key === 'Tab' && slashToken && candidates.length > 0) {
      e.preventDefault()
      const nextIndex = cycleState ? (cycleState.index + 1) % cycleState.candidates.length : 0
      const list = cycleState?.candidates ?? candidates
      const chosen = list[nextIndex]!
      const before = text.slice(0, slashToken.start)
      const after  = text.slice(slashCursor)
      const replacement = `/${chosen.name}`
      const newText = before + replacement + after
      setText(newText)
      const newCursor = before.length + replacement.length
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.setSelectionRange(newCursor, newCursor)
        setSlashCursor(newCursor)
      })
      setCycleState({ candidates: list, index: nextIndex })
      return
    }
```

(The existing handlers for `Ctrl+Enter`, `PageUp/Down/Escape`, and `ArrowUp` follow unchanged.)

Also, any other key should clear the cycle. The existing handler doesn't fire for character keys we don't intercept (the `onChange` does), and we already clear `cycleState` in `onChange`. But we also clear in `handleKeyDown` for non-Tab keys to be safe — add at the very top of `handleKeyDown`:

```ts
    if (e.key !== 'Tab' && cycleState) setCycleState(null)
```

- [ ] **Step 5: Replace the status-bar row**

Find the existing row (around L329):

```tsx
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-slate-600 font-mono">
              {status === 'idle' ? 'Ready' : status === 'running' ? 'Wait for idle...' : status ?? 'Unknown'}
            </span>
            <div className="flex items-center gap-2">
              {/* history button + send button */}
            </div>
          </div>
```

Modify the left-hand label area to show chips when in slash mode:

```tsx
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-2xs text-slate-600 font-mono shrink-0">
                {status === 'idle' ? 'Ready' : status === 'running' ? 'Wait for idle...' : status ?? 'Unknown'}
              </span>
              {slashToken && (
                <SlashChips
                  candidates={candidates}
                  activeIndex={activeIndex}
                  accent={accent}
                  onSelect={(i) => {
                    const chosen = candidates[i]!
                    const before = text.slice(0, slashToken.start)
                    const after  = text.slice(slashCursor)
                    const replacement = `/${chosen.name}`
                    const newText = before + replacement + after
                    setText(newText)
                    const newCursor = before.length + replacement.length
                    requestAnimationFrame(() => {
                      textareaRef.current?.focus({ preventScroll: true })
                      textareaRef.current?.setSelectionRange(newCursor, newCursor)
                      setSlashCursor(newCursor)
                    })
                    setCycleState({ candidates, index: i })
                  }}
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* existing history button + send button — unchanged */}
            </div>
          </div>
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/RunWorkspaceWidget/RunSessionPanel.tsx
git commit -m "feat(slash): wire slash mode + Tab cycle + chips into composer"
```

---

## Task 12: Inline ghost-text overlay

**Files:**
- Modify: `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` (PromptComposer textarea container)

- [ ] **Step 1: Wrap the textarea in a positioned container with a mirrored overlay**

Replace the textarea block around L315 (existing single `<textarea ...>` element) with:

```tsx
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => {
                setText(e.target.value)
                setSlashCursor(e.target.selectionStart ?? e.target.value.length)
                setCycleState(null)
              }}
              onSelect={e => setSlashCursor((e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={handleKeyDown}
              onFocus={onTextareaFocus}
              onBlur={onTextareaBlur}
              placeholder="Enter prompt text... (Ctrl+Enter to send)"
              className="w-full h-24 px-2 py-1.5 bg-surface-base border rounded text-xs font-mono text-slate-200 placeholder:text-slate-600 resize-y outline-none focus:border-primary/50 relative z-10"
              style={{ borderColor: hexToRgba(accent, 0.2), background: 'transparent' }}
            />
            {slashToken && topMatch && !cycleState && topMatch.name.startsWith(slashToken.partial) && topMatch.name !== slashToken.partial && (
              <div
                aria-hidden
                className="absolute inset-0 px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-words text-slate-600 pointer-events-none overflow-hidden"
              >
                <span className="invisible">{text.slice(0, slashCursor)}</span>
                <span>{topMatch.name.slice(slashToken.partial.length)}</span>
              </div>
            )}
          </div>
```

The overlay matches the textarea's font/padding so the visible-portion-of-text invisibly fills the space up to the cursor, then the suffix renders in dim slate-600 right where the cursor sits.

- [ ] **Step 2: Verify visually**

Type-check first:

Run: `npx tsc --noEmit`
Expected: PASS.

Manual check (user runs the existing dev server — DO NOT start one): open the prompt composer, type `/full`, see ghost text `-review` appear after `full`. Type a non-prefix-matching string like `/zzzz` — no ghost text. Press Tab on `/full` — ghost text disappears (in cycle mode).

- [ ] **Step 3: Commit**

```bash
git add src/components/RunWorkspaceWidget/RunSessionPanel.tsx
git commit -m "feat(slash): ghost-text overlay for top match preview"
```

---

## Task 13: Playwright e2e for the cycle behavior

**Files:**
- Create: `e2e/slash-autocomplete.spec.ts`

- [ ] **Step 1: Inspect existing e2e patterns**

Run: `ls e2e/ && head -40 e2e/$(ls e2e/ | grep -E 'spec\.ts$' | head -1)`
Expected: see how other tests set up `BASE_URL`, expand the composer, and find a session.

- [ ] **Step 2: Write the test**

```ts
// e2e/slash-autocomplete.spec.ts
import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:5273'

test.describe('slash command autocomplete', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE)
    // Open the first session — adapt selector to match other e2e tests in the repo.
    await page.getByTestId('session-card').first().click()
    // Expand the composer.
    await page.getByRole('button', { name: /Prompt Composer/i }).click()
  })

  test('typing / shows chips, Tab inserts top match', async ({ page }) => {
    const ta = page.locator('textarea')
    await ta.click()
    await ta.type('/full')
    // Chips visible.
    await expect(page.getByText(/^tab:/)).toBeVisible()
    // Tab inserts the top match.
    await ta.press('Tab')
    await expect(ta).toHaveValue(/\/full-review/)
  })

  test('Tab again cycles to next candidate', async ({ page }) => {
    const ta = page.locator('textarea')
    await ta.click()
    await ta.type('/re')      // many matches: /respond-to-pr, /recap, /recon, /review...
    await ta.press('Tab')      // top match
    const first = await ta.inputValue()
    await ta.press('Tab')      // next match
    const second = await ta.inputValue()
    expect(first).not.toBe(second)
  })

  test('typing a non-Tab key resets cycle', async ({ page }) => {
    const ta = page.locator('textarea')
    await ta.click()
    await ta.type('/re')
    await ta.press('Tab')      // enters cycle at index 0
    await ta.press('Backspace') // resets cycle
    await ta.press('Tab')      // fresh cycle starts at index 0 with new partial
    // No assertion on the exact value — just that no exception was thrown
    // and the textarea has a leading slash-named token.
    await expect(ta).toHaveValue(/^\/[a-z0-9-]+/)
  })
})
```

- [ ] **Step 3: Run the test**

The user runs the dev server. Ask them for the URL/port and use it. DO NOT start a server.

Run: `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test e2e/slash-autocomplete.spec.ts`
Expected: PASS (3/3). If first run reveals selector mismatches with this repo's existing e2e helpers (e.g. `session-card` test id), fix the selectors to match what other specs use, re-run, then commit.

- [ ] **Step 4: Commit**

```bash
git add e2e/slash-autocomplete.spec.ts
git commit -m "test(slash): e2e for chips, Tab cycle, and reset"
```

---

## Task 14: Manual verification + spec doc-hygiene

**Files:**
- (verification only)

- [ ] **Step 1: Manual smoke test**

Verify in the running app (the user's existing server):

- Type `/` (just the slash) → chips appear sorted by recency/frequency.
- Type `/ful` → ghost text `l-review` appears; chips show `/full-review` highlighted.
- Press `Tab` → text becomes `/full-review`, chips remain (highlighting index 0).
- Press `Tab` again → text becomes `/<next match>`, highlight shifts to index 1.
- Type a character (e.g. ` `) → cycle clears; if past whitespace, slash mode exits.
- Send a `/foo` prompt → `~/.config/tinstar/slash-usage.json` shows `foo` with count 1.
- Confirm `curl localhost:5273/api/slash-commands | jq '.commands | length'` returns > 0.

- [ ] **Step 2: Confirm OTLP counter is reaching Prometheus**

Run: `curl -s http://localhost:9090/api/v1/query?query=tinstar_slash_use_total | head -c 500`
Expected: a JSON result with `data.result` containing entries per slash name. (Skip if Prometheus isn't running locally.)

- [ ] **Step 3: Mark spec implemented**

Per `doc-hygiene` skill: once the feature ships, the spec dies. Move the spec out of `docs/superpowers/specs/` into project documentation if there's a stable home; otherwise leave it as a historical record (the spec frontmatter already has its date). Don't edit the spec to retroactively describe the implementation — the code is the truth.

If a `README` or feature index exists, add one line:
> Prompt composer supports slash-command autocompletion (`/`, Tab to cycle, ranked by recency).

- [ ] **Step 4: Final commit if anything was edited**

```bash
git status
git add <any-touched-files>
git commit -m "docs(slash): note slash autocomplete in feature docs"
```

---

## Out of scope

The following are intentionally NOT in this plan, per the spec:
- Per-session command lists for sessions running with isolated `~/.claude` mounts.
- Built-in claude-code commands without on-disk representation (e.g. `/help`, `/clear`).
- Caching across browser reloads; the in-memory module cache is fine.
- Cycle-on-shift-tab (only forward cycle).

If any of these become a real need later, they're additive on top of the structures in this plan.
