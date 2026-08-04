---
title: Session Time Usage - Plan
type: feat
date: 2026-08-03
topic: session-time-usage
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: docs/brainstorms/2026-08-03-session-time-usage-requirements.md
execution: code
---

# Session Time Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show where a run's wall-clock time went — working vs. waiting on an approval prompt vs. waiting on a question — as three vertical coloured strips in the Run Workspace telemetry rail, reconstructed from the session's own transcript.

**Architecture:** A pure server-side module turns a transcript (Claude Code JSONL or Codex rollout JSONL) into a list of non-overlapping bands plus failure marks. A cached, incremental route serves them. A polling hook feeds a canvas component that renders three vertical strips into the 160px-wide rail. No new data is recorded anywhere — everything is reconstructed from files already on disk, so it works on sessions that started before this feature existed.

**Tech Stack:** TypeScript, Node (server), React 18 + canvas 2D (client), Vitest, Vite.

**Spec:** `docs/brainstorms/2026-08-03-session-time-usage-requirements.md`. Requirement ids (R1–R20) below refer to it.

## Global Constraints

- Run unit tests with `env -u NODE_ENV npx vitest run --exclude='e2e/**'`. `NODE_ENV=production` in the shell causes spurious "act not supported" failures.
- Run typecheck with `env -u NODE_ENV npm run typecheck`. This compiles **three** tsconfigs (app, e2e, test). `npx tsc --noEmit` against the root tsconfig is a no-op and `-p tsconfig.app.json` alone skips test files, so broken test imports pass locally and fail CI.
- Server-side config paths go through `getConfigRoot()`, never `homedir()`.
- Frontend HTTP goes through `apiFetch` / `apiUrl` from `src/apiClient.ts`. A bare `fetch` 404s in Tauri.
- Never use `0` as a fallback for missing data. Render `--` or blank.
- Band kind strings are exactly: `approval`, `question`, `idle`, `subagent`, `tool`, `think`, `compact` (R3).
- The trailing window default is one hour and is **never** a literal at a use site — it is `DEFAULT_WINDOW_SEC`, threaded as a route query param and a hook argument (R9a).
- New `/api` routes do not go live on the standalone at :5273 until `dist` is rebuilt and the server restarted. Unit-test handlers; do not attempt live route smoke tests — leave that to the user.
- Do not start or kill the user's dev server.
- Commit after each task. Do not push and do not open a PR unless the user asks.

---

## File Structure

**Server**

| File | Responsibility |
|---|---|
| `src/server/sessions/timeline/types.ts` | Band/mark/timeline types + `DEFAULT_WINDOW_SEC`. No logic. |
| `src/server/sessions/timeline/flatten.ts` | Pure: overlapping intervals → one non-overlapping track (R2, R4). |
| `src/server/sessions/timeline/classify.ts` | Pure: one tool call → its band kind, incl. approval arithmetic (R5–R8). |
| `src/server/sessions/timeline/claude.ts` | Claude JSONL → intervals + marks. |
| `src/server/sessions/timeline/codex.ts` | Codex rollout JSONL → intervals + marks, plus rollout discovery (R19). |
| `src/server/sessions/timeline/index.ts` | Cache + incremental read, assembles a `SessionTimeline` (R14, R15). |

Split by responsibility, not layer: `classify.ts` and `flatten.ts` hold the two rules that carry all the subtlety and all the regression risk, so they are pure and directly unit-testable without touching a filesystem.

**Client**

| File | Responsibility |
|---|---|
| `src/hooks/useSessionTimeline.ts` | Polls the route, mirrors `useTurnLengthObservations`. |
| `src/components/Telemetry/TimelineStrip.tsx` | One vertical canvas strip: compositing + paint (R11, R16). |
| `src/components/Telemetry/timelinePaint.ts` | Pure: bands + height → per-pixel colour runs. Unit-tested without a DOM. |
| `src/components/RunWorkspaceWidget/TimelinePanel.tsx` | The three columns + config gate (R9, R13). |

**Modified**

| File | Change |
|---|---|
| `src/server/sessions/config.ts:90,353` | Add `timeline: boolean` to `telemetryPanels` type + default. |
| `src/server/api/routes.ts` | Register `GET /api/sessions/:name/timeline`. |
| `src/components/RunWorkspaceWidget/TelemetryPanel.tsx:108,159` | Add `timeline` to the panels default and render `<TimelinePanel/>`. |

---

## Implementation Units

---

## U1: Types and the flatten rule

**Files:**
- Create: `src/server/sessions/timeline/types.ts`
- Create: `src/server/sessions/timeline/flatten.ts`
- Test: `src/server/sessions/timeline/__tests__/flatten.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BandKind`, `Interval`, `Band`, `Mark`, `SessionTimeline`, `DEFAULT_WINDOW_SEC`, `flatten(intervals, t0, t1): Band[]`.

- [ ] **Step 1: Write `types.ts`**

```ts
/** Band kinds, in paint-priority order — earlier wins when intervals overlap (R2). */
export const BAND_KINDS = ['approval', 'question', 'subagent', 'compact', 'tool', 'idle', 'think'] as const
export type BandKind = typeof BAND_KINDS[number]

/** Default trailing window. Never inline this number at a use site (R9a). */
export const DEFAULT_WINDOW_SEC = 3600

/** An observation before flattening. May overlap other intervals. */
export interface Interval {
  /** epoch seconds */
  start: number
  /** epoch seconds */
  end: number
  kind: BandKind
  /** tool name, or a human label like 'waiting on you' */
  name: string
  /** command or argument snippet, for the tooltip */
  detail: string
}

/** A flattened band. Bands never overlap and always tile [t0, t1] (R2). */
export type Band = Interval

export type MarkKind = 'tool-failed' | 'subagent-interrupted'

export interface Mark {
  /** epoch seconds */
  at: number
  kind: MarkKind
  name: string
  detail: string
}

export interface SessionTimeline {
  /** epoch seconds of the first transcript entry */
  t0: number
  /** epoch seconds of the last transcript entry */
  t1: number
  bands: Band[]
  marks: Mark[]
  /** [start, end, isOpen] per turn, epoch seconds */
  turns: [number, number, boolean][]
  /** true when a cold parse yielded early and more remains (R15) */
  partial: boolean
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { flatten } from '../flatten'
import type { Interval } from '../types'

const iv = (start: number, end: number, kind: Interval['kind'], name = 'x'): Interval =>
  ({ start, end, kind, name, detail: '' })

describe('flatten', () => {
  it('tiles the whole span with no gaps and no overlaps', () => {
    const bands = flatten([iv(10, 20, 'tool')], 0, 30)
    expect(bands.map(b => [b.start, b.end, b.kind])).toEqual([
      [0, 10, 'think'], [10, 20, 'tool'], [20, 30, 'think'],
    ])
    const total = bands.reduce((s, b) => s + (b.end - b.start), 0)
    expect(total).toBe(30)
  })

  it('gives an overlap to the higher-priority kind', () => {
    // a script that shells out: an approval nested inside a tool span
    const bands = flatten([iv(0, 100, 'tool'), iv(40, 60, 'approval')], 0, 100)
    expect(bands.map(b => [b.start, b.end, b.kind])).toEqual([
      [0, 40, 'tool'], [40, 60, 'approval'], [60, 100, 'tool'],
    ])
  })

  it('never double-counts overlapping intervals', () => {
    const bands = flatten([iv(0, 60, 'tool'), iv(30, 90, 'subagent')], 0, 90)
    const total = bands.reduce((s, b) => s + (b.end - b.start), 0)
    expect(total).toBe(90)
  })

  it('returns a single think band when there are no intervals', () => {
    expect(flatten([], 5, 15)).toEqual([
      { start: 5, end: 15, kind: 'think', name: 'model thinking', detail: '' },
    ])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/flatten.test.ts`
Expected: FAIL — "Failed to resolve import ../flatten".

- [ ] **Step 4: Write `flatten.ts`**

```ts
import { BAND_KINDS, type Band, type BandKind, type Interval } from './types'

const PRIORITY: Record<BandKind, number> =
  Object.fromEntries(BAND_KINDS.map((k, i) => [k, i])) as Record<BandKind, number>

/**
 * Collapse overlapping observations into one non-overlapping track covering
 * [t0, t1]. Uncovered time is the model thinking — a residual, not a
 * measurement (R20).
 *
 * A sweep line is used rather than sorting-and-merging because intervals nest:
 * a Codex `exec` script shells out to `exec_command`, so a tool span can sit
 * entirely inside another. Whichever covering interval has the best priority
 * owns the stretch until the next boundary (R2).
 */
export function flatten(intervals: Interval[], t0: number, t1: number): Band[] {
  const usable = intervals.filter(i => i.end > i.start)
  if (usable.length === 0) {
    return [{ start: t0, end: t1, kind: 'think', name: 'model thinking', detail: '' }]
  }

  const bounds = [...new Set([t0, t1, ...usable.flatMap(i => [i.start, i.end])])]
    .filter(b => b >= t0 && b <= t1)
    .sort((a, b) => a - b)

  const byStart = [...usable].sort((a, b) => a.start - b.start)
  let cursor = 0
  let active: Interval[] = []
  const out: Band[] = []

  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!
    const hi = bounds[i + 1]!
    if (hi <= lo) continue
    while (cursor < byStart.length && byStart[cursor]!.start <= lo) active.push(byStart[cursor++]!)
    active = active.filter(a => a.end > lo)

    let best: Interval | null = null
    for (const a of active) {
      if (!best || PRIORITY[a.kind] < PRIORITY[best.kind]) best = a
    }
    out.push(best
      ? { start: lo, end: hi, kind: best.kind, name: best.name, detail: best.detail }
      : { start: lo, end: hi, kind: 'think', name: 'model thinking', detail: '' })
  }

  // Merge neighbours a boundary split apart, so one tool call is one band.
  const merged: Band[] = []
  for (const b of out) {
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === b.kind && prev.name === b.name && prev.end === b.start) prev.end = b.end
    else merged.push({ ...b })
  }
  return merged
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/flatten.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/sessions/timeline/types.ts src/server/sessions/timeline/flatten.ts src/server/sessions/timeline/__tests__/flatten.test.ts
git commit -m "feat(timeline): flatten overlapping transcript observations into one track"
```

---

## U2: Classification — the approval arithmetic

This is the task that carries the feature's whole point. Read R5–R8 before starting.

**Files:**
- Create: `src/server/sessions/timeline/classify.ts`
- Test: `src/server/sessions/timeline/__tests__/classify.test.ts`

**Interfaces:**
- Consumes: `Interval`, `BandKind` from U1.
- Produces:
  - `classifyCodexCall(start, end, name, args, output): Interval[]`
  - `classifyClaudeCall(start, end, name, args, resultText, isError): Interval`
  - `closeUnmatched(pending, entryTimes, now): Interval[]`
  - `QUESTION_TOOLS: Set<string>`, `SUBAGENT_TOOLS: Set<string>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { classifyCodexCall, classifyClaudeCall, closeUnmatched } from '../classify'

describe('classifyCodexCall', () => {
  it('splits a parked approval prompt off from the real runtime (R5)', () => {
    // Real case: rm -rf whose own output says it ran for 0 seconds, but whose
    // result landed 528 minutes later. All of that was an unanswered prompt.
    const out = classifyCodexCall(
      0, 31_698, 'exec_command',
      '{"cmd":"rm -rf /tmp/ce-code-review/jobs/x"}',
      'Chunk ID: 038b37\nWall time: 0.0000 seconds\nProcess exited with code 0\n',
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('approval')
    expect(out[0]!.end - out[0]!.start).toBeCloseTo(31_698, 0)
  })

  it('keeps the tail as tool time when the process really ran (R5)', () => {
    const out = classifyCodexCall(
      0, 300, 'exec_command', '{"cmd":"npm test"}',
      'Wall time: 120.0000 seconds\nProcess exited with code 0\n',
    )
    expect(out.map(i => i.kind)).toEqual(['approval', 'tool'])
    expect(out[0]!.end - out[0]!.start).toBeCloseTo(180, 0)
    expect(out[1]!.end - out[1]!.start).toBeCloseTo(120, 0)
  })

  it('does not call a genuinely slow tool an approval', () => {
    const out = classifyCodexCall(
      0, 130, 'exec_command', '{"cmd":"npm test"}',
      'Wall time: 129.0000 seconds\nProcess exited with code 0\n',
    )
    expect(out.map(i => i.kind)).toEqual(['tool'])
  })

  it('falls back to the trivial-command heuristic when runtime is unusable (R6)', () => {
    // Script-wrapped exec reports elapsed-including-stall, so subtraction finds nothing.
    const out = classifyCodexCall(
      0, 27_361, 'exec',
      'const r = await tools.exec_command({ cmd: "rm -rf -- /tmp/ce-code-review/jobs/y" });',
      'Script running with cell ID 21\nWall time 27361.5 seconds\n',
    )
    expect(out.map(i => i.kind)).toEqual(['approval'])
  })

  it('does not apply the heuristic to a long non-trivial command', () => {
    const out = classifyCodexCall(
      0, 27_361, 'exec',
      'const r = await tools.exec_command({ cmd: "npm run build" });',
      'Script running with cell ID 21\nWall time 27361.5 seconds\n',
    )
    expect(out.map(i => i.kind)).toEqual(['tool'])
  })

  it('classifies sub-agent polling as its own kind', () => {
    const out = classifyCodexCall(0, 60, 'wait_agent', '{"timeout_ms":60000}', 'ok')
    expect(out.map(i => i.kind)).toEqual(['subagent'])
  })

  it('classifies request_user_input as a question (R7)', () => {
    const out = classifyCodexCall(0, 5, 'request_user_input', '{}', 'ok')
    expect(out.map(i => i.kind)).toEqual(['question'])
  })
})

describe('classifyClaudeCall', () => {
  it('measures AskUserQuestion as question time (R7)', () => {
    const i = classifyClaudeCall(0, 240, 'AskUserQuestion', '{}', '', false)
    expect(i.kind).toBe('question')
    expect(i.end - i.start).toBe(240)
  })

  it('classifies a rejected permission as approval (R8)', () => {
    const i = classifyClaudeCall(
      0, 90, 'Bash', '{"command":"rm -rf /"}',
      "the user doesn't want to proceed with this tool use. the tool use was rejected", false,
    )
    expect(i.kind).toBe('approval')
  })

  it('treats an ordinary tool as tool time', () => {
    expect(classifyClaudeCall(0, 3, 'Read', '{}', 'file contents', false).kind).toBe('tool')
  })
})

describe('closeUnmatched', () => {
  it('closes a call with no result at the next logged entry, not at now (R4)', () => {
    // Codex drops the output line when a call is interrupted. Stretching such a
    // call to "now" produced a 34.9-hour phantom band over real work.
    const out = closeUnmatched(
      [{ start: 100, name: 'exec', args: '{}' }],
      [50, 100, 150, 900],
      100_000,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.end).toBe(150)
    expect(out[0]!.kind).toBe('tool')
    expect(out[0]!.name).toContain('no result')
  })

  it('treats a call with nothing after it as still in flight', () => {
    const out = closeUnmatched([{ start: 900, name: 'exec', args: '{}' }], [50, 900], 1_000)
    expect(out[0]!.end).toBe(1_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/classify.test.ts`
Expected: FAIL — "Failed to resolve import ../classify".

- [ ] **Step 3: Write `classify.ts`**

```ts
import type { Interval } from './types'

/** Tools whose span IS the user thinking about an answer (R7). */
export const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input'])
/** Tools whose span is the agent blocked on delegated work, not its own. */
export const SUBAGENT_TOOLS = new Set(['wait_agent', 'wait', 'Agent', 'Task'])

/** Codex tools print their own true runtime. This is what makes R5 arithmetic. */
const WALL_RE = /Wall time:?\s+([0-9.]+)\s*seconds/
/** Commands that cannot legitimately take minutes — see R6. */
const TRIVIAL_CMD_RE = /\b(rm|mv|chmod|chown|kill|git push)\b/
/** Below this, an unexplained gap is scheduling noise rather than a human. */
const MIN_APPROVAL_GAP_SEC = 45
/** Beyond this, even an unmeasurable trivial command is assumed parked. */
const HEURISTIC_MIN_SEC = 300

const REJECT_MARKERS = ["doesn't want to proceed", 'tool use was rejected']

const snip = (s: string) => s.replace(/\s+/g, ' ').slice(0, 160)

/**
 * One Codex tool call → one or two intervals.
 *
 * The load-bearing case: `exec_command` reports how long the process actually
 * ran. Any time the call existed but the process was not running was time
 * parked on an approval prompt. When a command reports 0.0 seconds and the
 * result arrives 8 hours later, that is not a slow tool (R5).
 */
export function classifyCodexCall(
  start: number, end: number, name: string, args: string, output: string,
): Interval[] {
  const detail = snip(args)
  const span = end - start
  const base = { name, detail }

  if (SUBAGENT_TOOLS.has(name)) return [{ start, end, kind: 'subagent', ...base }]
  if (QUESTION_TOOLS.has(name)) return [{ start, end, kind: 'question', ...base }]

  const m = WALL_RE.exec(output)
  if (m) {
    const ran = Number.parseFloat(m[1]!)
    const gap = span - ran
    if (gap > MIN_APPROVAL_GAP_SEC && ran < span / 2) {
      const out: Interval[] = [{ start, end: start + gap, kind: 'approval', ...base }]
      if (ran > 0.05) out.push({ start: start + gap, end, kind: 'tool', ...base })
      return out
    }
    return [{ start, end, kind: 'tool', ...base }]
  }

  // Script-wrapped exec reports elapsed-including-stall, so subtraction finds
  // nothing. Fall back to: a trivial command cannot honestly take minutes (R6).
  if (span > HEURISTIC_MIN_SEC && (name === 'exec' || name === 'exec_command') && TRIVIAL_CMD_RE.test(detail)) {
    return [{ start, end, kind: 'approval', ...base }]
  }
  return [{ start, end, kind: 'tool', ...base }]
}

/** One Claude tool call → one interval. */
export function classifyClaudeCall(
  start: number, end: number, name: string, args: string, resultText: string, isError: boolean,
): Interval {
  const base = { name, detail: snip(args) }
  if (QUESTION_TOOLS.has(name)) return { start, end, kind: 'question', ...base }
  if (SUBAGENT_TOOLS.has(name)) return { start, end, kind: 'subagent', ...base }
  const lower = resultText.toLowerCase()
  if (REJECT_MARKERS.some(mk => lower.includes(mk))) {
    return { start, end, kind: 'approval', name: `${name} (rejected)`, detail: base.detail }
  }
  void isError // failures are marks, not bands — see U3
  return { start, end, kind: 'tool', ...base }
}

export interface PendingCall { start: number; name: string; args: string }

/**
 * A call with no recorded output is NOT proof the agent is still parked on it.
 * Codex drops the output line when a call is interrupted, and this session
 * interrupts sub-agents constantly. Stretching such a call to "now" painted a
 * 34.9-hour phantom band over a day and a half of real work. If anything was
 * logged after the call, the agent had moved on (R4).
 */
export function closeUnmatched(
  pending: PendingCall[], entryTimes: number[], now: number,
): Interval[] {
  return pending.map(({ start, name, args }) => {
    const next = entryTimes.find(t => t > start)
    return {
      start,
      end: next ?? now,
      kind: 'tool' as const,
      name: next ? `${name} (no result logged)` : name,
      detail: snip(args),
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/classify.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/timeline/classify.ts src/server/sessions/timeline/__tests__/classify.test.ts
git commit -m "feat(timeline): measure approval stalls from self-reported tool runtime"
```

---

## U3: Transcript readers (Claude + Codex)

**Files:**
- Create: `src/server/sessions/timeline/claude.ts`
- Create: `src/server/sessions/timeline/codex.ts`
- Test: `src/server/sessions/timeline/__tests__/readers.test.ts`

**Interfaces:**
- Consumes: everything from U1 and U2.
- Produces:
  - `readClaudeTranscript(path): ParseResult`
  - `readCodexTranscript(path): ParseResult`
  - `pickCodexRollout(cwd, createdSec, candidates): string | null`
  - `interface ParseResult { intervals: Interval[]; marks: Mark[]; turns: [number, number, boolean][]; t0: number | null; t1: number | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClaudeTranscript } from '../claude'
import { readCodexTranscript, pickCodexRollout } from '../codex'

const iso = (sec: number) => new Date(sec * 1000).toISOString()

function write(dir: string, name: string, lines: unknown[]): string {
  const p = join(dir, name)
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return p
}

describe('readCodexTranscript', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('pairs a call to its output and records a non-zero exit as a mark (R12)', () => {
    const p = write(dir, 'r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w', timestamp: iso(0) } },
      { type: 'event_msg', timestamp: iso(1), payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"git stash --staged"}' } },
      { type: 'response_item', timestamp: iso(5), payload: { type: 'function_call_output', call_id: 'c1', output: 'Wall time: 3.0000 seconds\nProcess exited with code 129\n' } },
      { type: 'event_msg', timestamp: iso(6), payload: { type: 'task_complete' } },
    ])
    const r = readCodexTranscript(p)
    expect(r.t0).toBe(0)
    expect(r.t1).toBe(6)
    expect(r.intervals.filter(i => i.kind === 'tool')).toHaveLength(1)
    expect(r.marks).toHaveLength(1)
    expect(r.marks[0]!.kind).toBe('tool-failed')
    expect(r.marks[0]!.detail).toContain('129')
  })

  it('does not mark a zero exit as a failure', () => {
    const p = write(dir, 'r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'response_item', timestamp: iso(1), payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' } },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\n' } },
    ])
    expect(readCodexTranscript(p).marks).toHaveLength(0)
  })

  it('records an interrupted sub-agent as a mark', () => {
    const p = write(dir, 'r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'event_msg', timestamp: iso(3), payload: { type: 'sub_agent_activity', kind: 'interrupted', agent_path: '/root/x' } },
    ])
    const marks = readCodexTranscript(p).marks
    expect(marks).toHaveLength(1)
    expect(marks[0]!.kind).toBe('subagent-interrupted')
  })

  it('ignores the words error and failed in tool output (R12)', () => {
    const p = write(dir, 'r.jsonl', [
      { type: 'session_meta', timestamp: iso(0), payload: { cwd: '/w' } },
      { type: 'response_item', timestamp: iso(1), payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' } },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call_output', call_id: 'c1', output: '3 tests failed, error in foo.ts\nProcess exited with code 0\n' } },
    ])
    expect(readCodexTranscript(p).marks).toHaveLength(0)
  })
})

describe('pickCodexRollout', () => {
  it('picks the rollout nearest the session start, not the newest (R19)', () => {
    // A session that spawns sub-agents fills its own cwd with their rollouts,
    // and one of those is usually the most recently written file.
    const picked = pickCodexRollout('/w', 1000, [
      { startedSec: 1002, path: '/own.jsonl' },
      { startedSec: 9000, path: '/subagent.jsonl' },
    ])
    expect(picked).toBe('/own.jsonl')
  })

  it('returns null when there are no candidates (R18)', () => {
    expect(pickCodexRollout('/w', 1000, [])).toBeNull()
  })
})

describe('readClaudeTranscript', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('measures an AskUserQuestion span and marks an is_error result', () => {
    const p = write(dir, 'c.jsonl', [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }] } },
      { type: 'user', timestamp: iso(61), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'answered' }] } },
      { type: 'assistant', timestamp: iso(62), message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }] } },
      { type: 'user', timestamp: iso(63), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }] } },
    ])
    const r = readClaudeTranscript(p)
    const q = r.intervals.find(i => i.kind === 'question')!
    expect(q.end - q.start).toBe(60)
    expect(r.marks.filter(m => m.kind === 'tool-failed')).toHaveLength(1)
  })

  it('skips sidechain entries so a sub-agent transcript does not double-count', () => {
    const p = write(dir, 'c.jsonl', [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), isSidechain: true, message: { content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(2), isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'x' }] } },
    ])
    expect(readClaudeTranscript(p).intervals.filter(i => i.kind === 'tool')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/readers.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Implement `codex.ts`**

Read every line, sort by timestamp, pair `function_call`/`custom_tool_call` to their `*_output` by `call_id`, and hand each pair to `classifyCodexCall`. Track `task_started`/`task_complete` for turns and `user_message` for the human side. Emit a `tool-failed` mark when `/Process exited with code (\d+)/` matches a non-zero code, and a `subagent-interrupted` mark on `sub_agent_activity` with `kind === 'interrupted'`. Finish with `closeUnmatched`.

```ts
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { classifyCodexCall, closeUnmatched, type PendingCall } from './classify'
import type { Interval, Mark } from './types'

export interface ParseResult {
  intervals: Interval[]
  marks: Mark[]
  turns: [number, number, boolean][]
  t0: number | null
  t1: number | null
}

const EXIT_RE = /Process exited with code (\d+)/g
const sec = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms / 1000
}
const snip = (s: string) => s.replace(/\s+/g, ' ').slice(0, 110)

export function readCodexTranscript(path: string, now = Date.now() / 1000): ParseResult {
  const entries: { t: number; o: Record<string, unknown> }[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) } catch { continue }
    const t = sec(o.timestamp)
    if (t === null) continue
    entries.push({ t, o })
  }
  entries.sort((a, b) => a.t - b.t)

  const pending = new Map<string, PendingCall>()
  const intervals: Interval[] = []
  const marks: Mark[] = []
  const humans: number[] = []
  const ends: number[] = []

  for (const { t, o } of entries) {
    const p = (o.payload ?? {}) as Record<string, unknown>
    const sub = p.type as string | undefined
    if (o.type === 'response_item' && (sub === 'function_call' || sub === 'custom_tool_call')) {
      pending.set(String(p.call_id), {
        start: t,
        name: String(p.name ?? sub),
        args: String(p.arguments ?? p.input ?? ''),
      })
    } else if (o.type === 'response_item' && (sub === 'function_call_output' || sub === 'custom_tool_call_output')) {
      const call = pending.get(String(p.call_id))
      if (!call) continue
      pending.delete(String(p.call_id))
      const output = JSON.stringify(p.output ?? '').slice(0, 4000)
      intervals.push(...classifyCodexCall(call.start, t, call.name, call.args, output))
      const codes = [...output.matchAll(EXIT_RE)].map(m => m[1]!).filter(c => c !== '0')
      if (codes.length) {
        marks.push({ at: t, kind: 'tool-failed', name: call.name, detail: `exit ${codes.slice(0, 3).join('/')} · ${snip(call.args)}` })
      }
    } else if (o.type === 'event_msg') {
      if (sub === 'user_message') humans.push(t)
      else if (sub === 'task_complete') ends.push(t)
      else if (sub === 'context_compacted') intervals.push({ start: t, end: t + 2, kind: 'compact', name: 'compaction', detail: '' })
      else if (sub === 'sub_agent_activity' && p.kind === 'interrupted') {
        marks.push({ at: t, kind: 'subagent-interrupted', name: 'sub-agent', detail: snip(String(p.agent_path ?? '')) })
      }
    }
  }

  const t0 = entries.length ? entries[0]!.t : null
  const t1 = entries.length ? entries[entries.length - 1]!.t : null
  intervals.push(...closeUnmatched([...pending.values()], entries.map(e => e.t), now))
  if (t1 !== null) intervals.push(...idleIntervals(humans, ends, t1))
  return { intervals, marks, turns: buildTurns(humans, ends, t1), t0, t1 }
}

/**
 * Idle = the agent finished and nothing happened until the user spoke. Pair each
 * human message with the LAST turn end before it. Pairing with every earlier end
 * manufactures overlapping idle windows and inflates the total past wall clock.
 */
export function idleIntervals(humans: number[], ends: number[], t1: number): Interval[] {
  const out: Interval[] = []
  const sortedEnds = [...ends].sort((a, b) => a - b)
  let i = 0
  for (const h of [...humans].sort((a, b) => a - b)) {
    let prev: number | null = null
    while (i < sortedEnds.length && sortedEnds[i]! < h) prev = sortedEnds[i++]!
    if (prev !== null && h - prev > 2) out.push({ start: prev, end: h, kind: 'idle', name: 'waiting on you', detail: '' })
  }
  const lastEnd = sortedEnds[sortedEnds.length - 1]
  const lastHuman = humans[humans.length - 1]
  if (lastEnd !== undefined && (lastHuman === undefined || lastEnd > lastHuman) && t1 - lastEnd > 2) {
    out.push({ start: lastEnd, end: t1, kind: 'idle', name: 'waiting on you', detail: '' })
  }
  return out
}

/** A turn runs from a human message to the next turn end, or to now if still open. */
export function buildTurns(humans: number[], ends: number[], t1: number | null): [number, number, boolean][] {
  if (t1 === null) return []
  const sortedEnds = [...ends].sort((a, b) => a - b)
  return [...humans].sort((a, b) => a - b).map(h => {
    const e = sortedEnds.find(x => x > h)
    return [h, e ?? t1, e === undefined] as [number, number, boolean]
  })
}

export interface RolloutCandidate { startedSec: number; path: string }

/**
 * Choose the rollout whose own start is nearest the Tinstar session's creation.
 * Newest-mtime is wrong: a session that spawns sub-agents fills its own cwd with
 * their rollouts, and one of those is usually the newest file (R19).
 */
export function pickCodexRollout(_cwd: string, createdSec: number, candidates: RolloutCandidate[]): string | null {
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) =>
    Math.abs(c.startedSec - createdSec) < Math.abs(best.startedSec - createdSec) ? c : best).path
}

/** Scan the Codex sessions tree for rollouts whose session_meta cwd matches. */
export function findCodexCandidates(root: string, cwd: string): RolloutCandidate[] {
  const out: RolloutCandidate[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (!name.endsWith('.jsonl')) continue
      const meta = readSessionMeta(p)
      if (meta && meta.cwd === cwd) out.push({ startedSec: meta.startedSec, path: p })
    }
  }
  walk(root, 0)
  return out
}

/** The first line carries session_meta and can exceed 15KB (it holds the system prompt). */
function readSessionMeta(path: string): { cwd: string; startedSec: number } | null {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(32_768, size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const first = buf.toString('utf-8', 0, n).split('\n')[0]
    if (!first) return null
    const o = JSON.parse(first)
    if (o.type !== 'session_meta') return null
    const started = sec(o.payload?.timestamp ?? o.timestamp)
    return { cwd: String(o.payload?.cwd ?? ''), startedSec: started ?? statSync(path).mtimeMs / 1000 }
  } catch { return null }
}
```

- [ ] **Step 4: Implement `claude.ts`**

```ts
import { readFileSync } from 'node:fs'
import { classifyClaudeCall, closeUnmatched, type PendingCall } from './classify'
import { idleIntervals, buildTurns, type ParseResult } from './codex'
import type { Interval, Mark } from './types'

const sec = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms / 1000
}

export function readClaudeTranscript(path: string, now = Date.now() / 1000): ParseResult {
  const entries: { t: number; o: Record<string, unknown> }[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) } catch { continue }
    // A sub-agent's own lines land in the same file. The parent's Agent tool
    // span already covers that time; counting both double-counts it.
    if (o.isSidechain) continue
    const t = sec(o.timestamp)
    if (t === null) continue
    entries.push({ t, o })
  }
  entries.sort((a, b) => a.t - b.t)

  const pending = new Map<string, PendingCall>()
  const intervals: Interval[] = []
  const marks: Mark[] = []
  const humans: number[] = []
  const ends: number[] = []
  let lastAssistant: number | null = null

  for (const { t, o } of entries) {
    const msg = (o.message ?? {}) as Record<string, unknown>
    const blocks = Array.isArray(msg.content) ? msg.content as Record<string, unknown>[] : []
    if (o.type === 'assistant') {
      lastAssistant = t
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          pending.set(String(b.id), { start: t, name: String(b.name ?? 'tool'), args: JSON.stringify(b.input ?? {}).slice(0, 200) })
        }
      }
    } else if (o.type === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result')
      if (results.length) {
        for (const b of results) {
          const call = pending.get(String(b.tool_use_id))
          if (!call) continue
          pending.delete(String(b.tool_use_id))
          const text = JSON.stringify(b.content ?? '').slice(0, 600)
          intervals.push(classifyClaudeCall(call.start, t, call.name, call.args, text, Boolean(b.is_error)))
          if (b.is_error) marks.push({ at: t, kind: 'tool-failed', name: call.name, detail: text.replace(/\s+/g, ' ').slice(0, 110) })
        }
      } else {
        if (lastAssistant !== null) ends.push(lastAssistant)
        humans.push(t)
      }
    }
  }

  const t0 = entries.length ? entries[0]!.t : null
  const t1 = entries.length ? entries[entries.length - 1]!.t : null
  intervals.push(...closeUnmatched([...pending.values()], entries.map(e => e.t), now))
  if (t1 !== null) intervals.push(...idleIntervals(humans, ends, t1))
  return { intervals, marks, turns: buildTurns(humans, ends, t1), t0, t1 }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/readers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/sessions/timeline/claude.ts src/server/sessions/timeline/codex.ts src/server/sessions/timeline/__tests__/readers.test.ts
git commit -m "feat(timeline): read Claude and Codex transcripts into bands and marks"
```

---

## U4: Cache + assembly

**Files:**
- Create: `src/server/sessions/timeline/index.ts`
- Test: `src/server/sessions/timeline/__tests__/cache.test.ts`

**Interfaces:**
- Consumes: U1–U3.
- Produces: `buildSessionTimeline(session, opts): SessionTimeline | null`, `__resetTimelineCache(): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSessionTimeline, __resetTimelineCache } from '../index'

const iso = (s: number) => new Date(s * 1000).toISOString()

describe('buildSessionTimeline cache', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tlc-')); __resetTimelineCache() })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does not re-read a transcript whose size is unchanged (R14, AE7)', () => {
    const p = join(dir, 'c.jsonl')
    writeFileSync(p, JSON.stringify({ type: 'user', timestamp: iso(0), message: { content: 'go' } }) + '\n')
    const session = { name: 's', adapter: 'claude', transcriptPath: p, createdSec: 0 }

    const first = buildSessionTimeline(session)
    expect(first).not.toBeNull()

    const spy = vi.spyOn(require('node:fs'), 'readFileSync')
    buildSessionTimeline(session)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('re-reads once the file grows', () => {
    const p = join(dir, 'c.jsonl')
    writeFileSync(p, JSON.stringify({ type: 'user', timestamp: iso(0), message: { content: 'go' } }) + '\n')
    const session = { name: 's', adapter: 'claude', transcriptPath: p, createdSec: 0 }
    const before = buildSessionTimeline(session)!
    appendFileSync(p, JSON.stringify({ type: 'user', timestamp: iso(600), message: { content: 'more' } }) + '\n')
    const after = buildSessionTimeline(session)!
    expect(after.t1).toBeGreaterThan(before.t1)
  })

  it('returns null when no transcript path resolves (R18)', () => {
    expect(buildSessionTimeline({ name: 'marshal', adapter: 'codex', transcriptPath: null, createdSec: 0 })).toBeNull()
  })

  it('bands tile the whole span (R2)', () => {
    const p = join(dir, 'c.jsonl')
    writeFileSync(p, [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(4), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')
    const tl = buildSessionTimeline({ name: 's', adapter: 'claude', transcriptPath: p, createdSec: 0 })!
    const total = tl.bands.reduce((s, b) => s + (b.end - b.start), 0)
    expect(total).toBeCloseTo(tl.t1 - tl.t0, 3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/cache.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `index.ts`**

```ts
import { statSync } from 'node:fs'
import { readClaudeTranscript } from './claude'
import { readCodexTranscript } from './codex'
import { flatten } from './flatten'
import type { SessionTimeline } from './types'

export * from './types'
export { findCodexCandidates, pickCodexRollout } from './codex'

export interface TimelineInput {
  name: string
  adapter: 'claude' | 'codex' | string
  /** null when no transcript could be resolved — marshal-class sessions (R18) */
  transcriptPath: string | null
  createdSec: number
}

interface CacheEntry { size: number; timeline: SessionTimeline }
const cache = new Map<string, CacheEntry>()

/** Test seam. */
export function __resetTimelineCache(): void { cache.clear() }

/**
 * Build (or serve from cache) a session's timeline.
 *
 * The cache is keyed on session name and invalidated by file size. The largest
 * live transcript is 72MB; re-parsing it on every 5s poll is not viable, and a
 * transcript is append-only so size is a sound invalidation signal (R14).
 */
export function buildSessionTimeline(input: TimelineInput, now = Date.now() / 1000): SessionTimeline | null {
  if (!input.transcriptPath) return null

  let size: number
  try { size = statSync(input.transcriptPath).size } catch { return null }

  const hit = cache.get(input.name)
  if (hit && hit.size === size) return hit.timeline

  const read = input.adapter === 'codex' ? readCodexTranscript : readClaudeTranscript
  const r = read(input.transcriptPath, now)
  if (r.t0 === null || r.t1 === null) return null

  const timeline: SessionTimeline = {
    t0: r.t0,
    t1: r.t1,
    bands: flatten(r.intervals, r.t0, r.t1),
    marks: r.marks,
    turns: r.turns,
    partial: false,
  }
  cache.set(input.name, { size, timeline })
  return timeline
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/sessions/timeline/__tests__/cache.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions/timeline/index.ts src/server/sessions/timeline/__tests__/cache.test.ts
git commit -m "feat(timeline): cache session timelines and invalidate on transcript growth"
```

---

## U5: The route

**Files:**
- Modify: `src/server/api/routes.ts` (add beside the `/context` handler at ~4203)
- Modify: `src/server/sessions/config.ts:90` (type) and `:353` (default)
- Test: `src/server/api/__tests__/timeline-route.test.ts`

**Interfaces:**
- Consumes: `buildSessionTimeline`, `DEFAULT_WINDOW_SEC`.
- Produces: `GET /api/sessions/:name/timeline?windowSec=<n>` → `{ ok: true, data: SessionTimeline & { windowSec: number } }`.

- [ ] **Step 1: Add `timeline: boolean` to the config type and default**

In `src/server/sessions/config.ts`, add `timeline: boolean` to the `telemetryPanels` type block (~line 90) and `timeline: true,` to the defaults (~line 353).

- [ ] **Step 2: Write the failing test**

Copy the `makeCtx` helper and HTTP harness from `src/server/api/__tests__/runs-route.test.ts` verbatim — it stands up a real `http` server around `handleRequest`. Add `timeline: true` to the `telemetryPanels` literal in `makeCtx`.

```ts
it('404s an unknown session', async () => {
  const res = await t.fetch('/api/sessions/nope/timeline')
  expect(res.status).toBe(404)
})

it('returns bands that tile the span', async () => {
  // createSession the fixture, write a transcript, then:
  const res = await t.fetch('/api/sessions/fixture/timeline')
  expect(res.status).toBe(200)
  const { ok, data } = await res.json()
  expect(ok).toBe(true)
  const total = data.bands.reduce((s: number, b: any) => s + (b.end - b.start), 0)
  expect(total).toBeCloseTo(data.t1 - data.t0, 3)
})

it('defaults windowSec to DEFAULT_WINDOW_SEC and honours an override (R9a)', async () => {
  const a = await (await t.fetch('/api/sessions/fixture/timeline')).json()
  expect(a.data.windowSec).toBe(DEFAULT_WINDOW_SEC)
  const b = await (await t.fetch('/api/sessions/fixture/timeline?windowSec=900')).json()
  expect(b.data.windowSec).toBe(900)
})

it('reports no-transcript rather than failing (R18)', async () => {
  // a session whose workspace path resolves nothing
  const { ok, data } = await (await t.fetch('/api/sessions/notranscript/timeline')).json()
  expect(ok).toBe(true)
  expect(data).toBeNull()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/api/__tests__/timeline-route.test.ts`
Expected: FAIL — route returns 404 for the fixture session.

- [ ] **Step 4: Register the route**

Insert immediately after the `/context` block in `routes.ts`. Mirror its shape: `extractSessionName`, `getSession`, `fail(res, 'SESSION_NOT_FOUND', …)`.

```ts
// GET /api/sessions/:name/timeline?windowSec=<n> — where the run's time went
if (method === 'GET' && url.split('?')[0]!.endsWith('/timeline') && url.startsWith('/api/sessions/')) {
  const name = extractSessionName(url.split('?')[0]!, '/api/sessions/')
  if (name) {
    const session = getSession(sessDir, name)
    if (!session) {
      fail(res, 'SESSION_NOT_FOUND', `Session '${name}' not found`)
      return true
    }
    const q = new URL(url, 'http://x').searchParams
    const parsed = Number.parseInt(q.get('windowSec') ?? '', 10)
    const windowSec = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_SEC
    try {
      const timeline = buildSessionTimeline(resolveTimelineInput(session))
      // null is a real answer, not an error: a Codex session with no
      // workspace.path has no transcript to discover (R18).
      ok(res, timeline ? { ...timeline, windowSec } : null)
    } catch (err) {
      log.error('api', `timeline failed for ${name}: ${(err as Error).message}`)
      fail(res, 'INTERNAL', (err as Error).message)
    }
    return true
  }
}
```

Add a `resolveTimelineInput(session)` helper next to the route: for `adapter === 'codex'`, use `findCodexCandidates(join(getConfigRoot(), '..', '.codex', 'sessions'), session.workspace?.path)` then `pickCodexRollout`; otherwise use `getTranscriptPath(workdir, convId)` falling back to `findTranscriptByConvId(convId)`. Return `transcriptPath: null` when nothing resolves.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/api/__tests__/timeline-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full server suite and typecheck**

```bash
env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server
env -u NODE_ENV npm run typecheck
```

Adding a field to `telemetryPanels` breaks every test fixture that spells the object out in full. Fix each by adding `timeline: true`.

- [ ] **Step 7: Commit**

```bash
git add src/server/api/routes.ts src/server/sessions/config.ts src/server/api/__tests__/timeline-route.test.ts
git commit -m "feat(timeline): serve session time usage from a cached route"
```

---

## U6: Paint math (pure, no DOM)

**Files:**
- Create: `src/components/Telemetry/timelinePaint.ts`
- Test: `src/components/Telemetry/__tests__/timelinePaint.test.ts`

**Interfaces:**
- Consumes: `Band`, `BandKind`.
- Produces: `compositeColumns(bands, t0, t1, px): (BandKind | null)[]`, `runsFromColumns(cols): { kind, start, len }[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { compositeColumns, runsFromColumns } from '../timelinePaint'
import type { Band } from '../../../server/sessions/timeline/types'

const band = (start: number, end: number, kind: Band['kind']): Band =>
  ({ start, end, kind, name: 'x', detail: '' })

describe('compositeColumns', () => {
  it('gives a pixel to the kind that occupies most of it (R11)', () => {
    // 10s per pixel; pixel 0 is 9s idle + 1s tool
    const cols = compositeColumns([band(0, 9, 'idle'), band(9, 10, 'tool')], 0, 100, 10)
    expect(cols[0]).toBe('idle')
  })

  it('lets a sliver of approval win the pixel outright (R11, AE5)', () => {
    // one pixel spans 1200s; a 4s approval must still show
    const cols = compositeColumns(
      [band(0, 600, 'tool'), band(600, 604, 'approval'), band(604, 1200, 'tool')],
      0, 1200, 1,
    )
    expect(cols[0]).toBe('approval')
  })

  it('lets a sliver of question win the pixel outright', () => {
    const cols = compositeColumns(
      [band(0, 600, 'tool'), band(600, 604, 'question'), band(604, 1200, 'tool')],
      0, 1200, 1,
    )
    expect(cols[0]).toBe('question')
  })

  it('does not let tool outrank idle on occupancy alone (R11)', () => {
    // the bug that made a 73%-idle session look busy
    const bands: Band[] = []
    for (let i = 0; i < 100; i++) { bands.push(band(i * 100, i * 100 + 99, 'idle'), band(i * 100 + 99, (i + 1) * 100, 'tool')) }
    const cols = compositeColumns(bands, 0, 10_000, 10)
    expect(cols.every(c => c === 'idle')).toBe(true)
  })
})

describe('runsFromColumns', () => {
  it('collapses equal neighbours into one run', () => {
    expect(runsFromColumns(['tool', 'tool', 'idle', 'idle', 'idle'])).toEqual([
      { kind: 'tool', start: 0, len: 2 },
      { kind: 'idle', start: 2, len: 3 },
    ])
  })

  it('skips null columns', () => {
    expect(runsFromColumns([null, 'tool', null])).toEqual([{ kind: 'tool', start: 1, len: 1 }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/components/Telemetry/__tests__/timelinePaint.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `timelinePaint.ts`**

```ts
import { BAND_KINDS, type Band, type BandKind } from '../../server/sessions/timeline/types'

/**
 * Award each pixel to whichever band occupies most of it, so a strip's colour
 * proportions match the percentages printed beside it (R17).
 *
 * The two "waiting on you" kinds are the exception. At rail scale one pixel is
 * minutes to tens of minutes; a four-second approval would be averaged into
 * invisibility, and that band is the entire reason this chart exists (R11).
 */
export function compositeColumns(bands: Band[], t0: number, t1: number, px: number): (BandKind | null)[] {
  const span = Math.max(t1 - t0, 1e-9)
  const nk = BAND_KINDS.length
  const acc = new Float64Array(px * nk)

  for (const b of bands) {
    const x = ((b.start - t0) / span) * px
    const x2 = ((b.end - t0) / span) * px
    let a = Math.floor(x)
    let z = Math.ceil(x2)
    if (z <= a) z = a + 1
    if (a < 0) a = 0
    if (z > px) z = px
    const ki = BAND_KINDS.indexOf(b.kind)
    if (ki < 0) continue
    for (let c = a; c < z; c++) {
      const ov = Math.min(x2, c + 1) - Math.max(x, c)
      acc[c * nk + ki]! += ov > 0 ? ov : 1e-9
    }
  }

  const iApproval = BAND_KINDS.indexOf('approval')
  const iQuestion = BAND_KINDS.indexOf('question')
  const out: (BandKind | null)[] = new Array(px).fill(null)
  for (let c = 0; c < px; c++) {
    const base = c * nk
    let best = -1
    let bestV = 0
    for (let k = 0; k < nk; k++) {
      const v = acc[base + k]!
      if (v > bestV) { bestV = v; best = k }
    }
    if (acc[base + iApproval]! > 0) best = iApproval
    else if (acc[base + iQuestion]! > 0) best = iQuestion
    out[c] = best < 0 ? null : BAND_KINDS[best]!
  }
  return out
}

/**
 * Collapse the column array into runs. Emitting one draw call per band pinned a
 * transition at 7fps in the spike; one filled path per colour brought the median
 * frame to 17.7ms (R16).
 */
export function runsFromColumns(cols: (BandKind | null)[]): { kind: BandKind; start: number; len: number }[] {
  const out: { kind: BandKind; start: number; len: number }[] = []
  let start = 0
  let cur = cols[0] ?? null
  for (let c = 1; c <= cols.length; c++) {
    const k = c < cols.length ? cols[c]! : null
    if (k === cur && c < cols.length) continue
    if (cur !== null) out.push({ kind: cur, start, len: c - start })
    start = c
    cur = k
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/components/Telemetry/__tests__/timelinePaint.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/Telemetry/timelinePaint.ts src/components/Telemetry/__tests__/timelinePaint.test.ts
git commit -m "feat(timeline): composite bands per pixel with a rare-band override"
```

---

## U7: The hook

**Files:**
- Create: `src/hooks/useSessionTimeline.ts`
- Test: `src/hooks/__tests__/useSessionTimeline.test.ts`

**Interfaces:**
- Consumes: `SessionTimeline`, `DEFAULT_WINDOW_SEC`, `apiFetch`.
- Produces: `useSessionTimeline(sessionName, windowSec?, opts?): { timeline: SessionTimeline | null; windowSec: number; loading: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionTimeline } from '../useSessionTimeline'
import { DEFAULT_WINDOW_SEC } from '../../server/sessions/timeline/types'

vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../../apiClient'

const payload = { ok: true, data: { t0: 0, t1: 100, bands: [], marks: [], turns: [], partial: false, windowSec: 3600 } }

describe('useSessionTimeline', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => payload } as Response) })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('requests the default window when none is given (R9a)', async () => {
    renderHook(() => useSessionTimeline('s'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toContain(`windowSec=${DEFAULT_WINDOW_SEC}`)
  })

  it('requests an explicit window when given one', async () => {
    renderHook(() => useSessionTimeline('s', 900))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toContain('windowSec=900')
  })

  it('exposes null without throwing when the session has no transcript (R18)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: null }) } as Response)
    const { result } = renderHook(() => useSessionTimeline('marshal'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.timeline).toBeNull()
  })

  it('stops polling after unmount', async () => {
    const { unmount } = renderHook(() => useSessionTimeline('s', undefined, { intervalMs: 1000 }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    unmount()
    vi.advanceTimersByTime(5000)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/hooks/__tests__/useSessionTimeline.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement the hook**

Mirror `src/hooks/useTurnLengthObservations.ts`: `useEffect` with a `cancelled` flag, an interval, and cleanup that clears it.

```ts
import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import { DEFAULT_WINDOW_SEC, type SessionTimeline } from '../server/sessions/timeline/types'

interface Opts { intervalMs?: number }

export function useSessionTimeline(
  sessionName: string | null,
  windowSec: number = DEFAULT_WINDOW_SEC,
  opts: Opts = {},
): { timeline: SessionTimeline | null; windowSec: number; loading: boolean } {
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null)
  const [loading, setLoading] = useState(true)
  const intervalMs = opts.intervalMs ?? 5000

  useEffect(() => {
    if (!sessionName) { setLoading(false); return }
    let cancelled = false
    const load = async () => {
      try {
        const res = await apiFetch(
          `/api/sessions/${encodeURIComponent(sessionName)}/timeline?windowSec=${windowSec}`)
        if (!res.ok) return
        const json = await res.json()
        if (cancelled) return
        setTimeline(json.ok ? (json.data as SessionTimeline | null) : null)
      } catch { /* transient — the next poll retries */ }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    const id = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [sessionName, windowSec, intervalMs])

  return { timeline, windowSec, loading }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/hooks/__tests__/useSessionTimeline.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSessionTimeline.ts src/hooks/__tests__/useSessionTimeline.test.ts
git commit -m "feat(timeline): poll session time usage from the client"
```

---

## U8: The rail panel

**Files:**
- Create: `src/components/Telemetry/TimelineStrip.tsx`
- Create: `src/components/RunWorkspaceWidget/TimelinePanel.tsx`
- Modify: `src/components/RunWorkspaceWidget/TelemetryPanel.tsx:108` (panels default) and `:159` (render)
- Test: `src/components/RunWorkspaceWidget/__tests__/TimelinePanel.test.tsx`

**Interfaces:**
- Consumes: `useSessionTimeline`, `compositeColumns`, `runsFromColumns`.
- Produces: `<TimelinePanel sessionId={string} />`, `<TimelineStrip bands t0 t1 marks heightPx widthPx label />`.

**Colours** — reuse the spike's palette, which was checked against both themes:

```ts
export const BAND_COLOR: Record<BandKind, string> = {
  approval: '#D95E52',   // waiting on you — an unanswered prompt
  question: '#E0A33A',   // waiting on you — an unanswered question
  idle:     '#222932',   // waiting on you — turn over
  subagent: '#7C6CBF',   // blocked on delegated work
  tool:     '#35907C',   // a process is actually running
  think:    '#5C6B80',   // residual (R20)
  compact:  '#4A80C4',
}
export const MARK_COLOR = '#FF5E5E'
```

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimelinePanel, stripHeightPx } from '../TimelinePanel'

vi.mock('../../../hooks/useSessionTimeline', () => ({ useSessionTimeline: vi.fn() }))
vi.mock('../../../context/ConfigContext', () => ({ useConfig: vi.fn() }))
import { useSessionTimeline } from '../../../hooks/useSessionTimeline'
import { useConfig } from '../../../context/ConfigContext'

const cfg = (timeline: boolean) => ({ ui: { telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true, timeline } } })

const tl = {
  t0: 0, t1: 100, partial: false, marks: [], turns: [[0, 100, true]] as [number, number, boolean][],
  bands: [
    { start: 0, end: 60, kind: 'approval' as const, name: 'exec_command', detail: 'rm -rf /tmp/x' },
    { start: 60, end: 100, kind: 'tool' as const, name: 'exec', detail: '' },
  ],
}

describe('TimelinePanel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders nothing when the config gate is off (R13)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(false) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false })
    const { container } = render(<TimelinePanel sessionId="s" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders three strips when enabled (R9)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false })
    render(<TimelinePanel sessionId="s" />)
    expect(screen.getAllByTestId('timeline-strip')).toHaveLength(3)
  })

  it('shows an explicit no-transcript state rather than an empty strip (R18, AE6)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: null, windowSec: 3600, loading: false })
    render(<TimelinePanel sessionId="marshal" />)
    expect(screen.getByText(/no transcript/i)).toBeInTheDocument()
    expect(screen.queryByTestId('timeline-strip')).not.toBeInTheDocument()
  })

  it('prints percentages from durations, not pixels (R17)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false })
    render(<TimelinePanel sessionId="s" />)
    // 60 of 100 seconds is approval
    expect(screen.getAllByText('60%').length).toBeGreaterThan(0)
  })
})

describe('stripHeightPx', () => {
  it('draws a shorter stretch of time as a shorter bar (R10)', () => {
    const session = stripHeightPx(97 * 3600, 97 * 3600)
    const turn = stripHeightPx(5.3 * 3600, 97 * 3600)
    const window = stripHeightPx(3600, 97 * 3600)
    expect(session).toBeGreaterThan(turn)
    expect(turn).toBeGreaterThan(window)
  })

  it('never collapses a short range to an unreadable sliver (R10)', () => {
    // strict proportionality would give this 1.5px
    expect(stripHeightPx(1800, 116 * 3600)).toBeGreaterThanOrEqual(60)
  })

  it('does not stretch a short range to fill the rail', () => {
    expect(stripHeightPx(3600, 97 * 3600)).toBeLessThan(260)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/components/RunWorkspaceWidget/__tests__/TimelinePanel.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `TimelineStrip.tsx`**

A `<canvas>` in a wrapper. On mount and on `bands`/size change: set `canvas.width/height` from `clientWidth * devicePixelRatio`, call `compositeColumns(bands, t0, t1, heightPx)` — **the column axis is vertical**, so columns map to y — then `runsFromColumns` and one `beginPath()`/`rect()`/`fill()` per kind. Row 0 is the earliest time, so past is at the top (R9). Give the canvas `data-testid="timeline-strip"`. Draw marks as 3px-tall bars in a 6px gutter on the right edge, clustering any within 8px into one and drawing it 5px wide (R12).

- [ ] **Step 4: Implement `TimelinePanel.tsx`**

```tsx
export function TimelinePanel({ sessionId }: { sessionId: string }) {
  const config = useConfig()
  if (!config?.ui.telemetryPanels.timeline) return null
  return <TimelinePanelInner sessionId={sessionId} />
}
```

`TimelinePanelInner` calls `useSessionTimeline(sessionId)`, returns a `— no transcript —` line when `timeline` is null, and otherwise renders three `<TimelineStrip/>` side by side in a flex row: whole session (`t0`→`t1`), trailing window (`max(t0, t1 - windowSec)`→`t1`), and current-or-last turn (from `turns[turns.length - 1]`). Header `TIME · 60m` styled like `TurnLengthPanel`'s. Below each strip print its band percentages computed from **durations** (R17).

Strip height carries meaning and must follow R10 exactly — a shorter stretch of time draws a shorter bar. Strips do **not** stretch to fill the rail:

```ts
const MAX_STRIP_PX = 260
const MIN_STRIP_PX = 60

/**
 * Length tracks real duration on a compressed curve (R10). Strict
 * proportionality would render a 30-minute turn beside a 116-hour session as a
 * sub-pixel sliver; filling the height instead would throw away the comparison
 * entirely. The 0.32 exponent is the curve the spike used.
 */
export function stripHeightPx(durationSec: number, longestOnCardSec: number): number {
  const ratio = Math.max(durationSec, 1) / Math.max(longestOnCardSec, 1)
  return Math.min(MAX_STRIP_PX, Math.max(MIN_STRIP_PX, Math.pow(ratio, 0.32) * MAX_STRIP_PX))
}
```

`longestOnCardSec` is the longest of the three ranges on this card, which is the whole-session span in every case where a session has turns.

- [ ] **Step 5: Wire it into the rail**

In `TelemetryPanel.tsx`, add `timeline: true` to the `panels` default object at line 108, and render `{panels.timeline && <TimelinePanel sessionId={sessionId} />}` after the `TurnLengthPanel` line at 159.

- [ ] **Step 6: Run tests + typecheck**

```bash
env -u NODE_ENV npx vitest run --exclude='e2e/**'
env -u NODE_ENV npm run typecheck
env -u NODE_ENV npm run lint
```

`npm run lint` catches phantom Tailwind classes; the palette is single-sourced in `tailwind.theme.js`.

- [ ] **Step 7: Commit**

```bash
git add src/components/Telemetry/TimelineStrip.tsx src/components/RunWorkspaceWidget/TimelinePanel.tsx src/components/RunWorkspaceWidget/TelemetryPanel.tsx src/components/RunWorkspaceWidget/__tests__/TimelinePanel.test.tsx
git commit -m "feat(telemetry): show where a run's time went in the rail"
```

---

## U9: Verify against real data

The unit tests use fixtures. This task checks the reconstruction against the transcripts that motivated the feature — the only way to catch a reader that is subtly wrong in a way no fixture reproduces.

**Files:**
- Create: `scripts/timeline-check.mjs`

- [ ] **Step 1: Write the script**

It should import the built reader, run it over every session in `~/.config/tinstar/sessions/`, and print per session: span, each band's total, their sum, and the count of marks. It must assert that bands sum to the span within 0.5%.

- [ ] **Step 2: Run it**

```bash
env -u NODE_ENV npx tsx scripts/timeline-check.mjs
```

Expected, per AE1 — `codexTinstar` reports approval ≈ 25.2h (26%), tool ≈ 38.8h (40%), think ≈ 17.3h (18%), sub-agent ≈ 7.9h (8%), idle ≈ 7.7h (8%), summing to its ~97h span. `enrollment` reports ≈ 73% idle. Every session's bands sum to its span.

If `codexTinstar` reports approval far above ~26%, the phantom-band regression is back — check `closeUnmatched` (R4).

- [ ] **Step 3: Commit**

```bash
git add scripts/timeline-check.mjs
git commit -m "test(timeline): check reconstruction against live transcripts"
```

- [ ] **Step 4: Hand back to the user**

The route does not go live on the standalone at :5273 until `dist` is rebuilt and the server restarted, and the user runs their own server. Report what landed and let them rebuild and look.

---

## Self-Review

**Spec coverage.** R1→U3; R2→U1; R3→U1; R4→U2; R5,R6→U2; R7,R8→U2; R9,R9a→U5,U7,U8; R10→U8; R11→U6; R12→U3,U8; R13→U5,U8; R14→U4; R15→U4 (`partial` is carried in the type and always `false` — if U4's cold parse proves too slow on the 72MB file, slicing lands as a follow-up rather than blocking this unit); R16→U6; R17→U8; R18→U4,U5,U8; R19→U3; R20→U6,U8 comments.

**Known gaps, deliberate.** R15's yielding is typed for but not implemented — the cache means a cold parse happens once per session per growth, and the spike parsed all nine sessions in 9.7s. If that proves too slow in practice it is a follow-up, not a redesign.

**Type consistency.** `Interval`/`Band` are the same shape by alias. `ParseResult` is declared in `codex.ts` and imported by `claude.ts`. `BAND_KINDS` order defines both flatten priority and the `compositeColumns` accumulator index, so it must not be reordered casually — R11's override looks kinds up by name, not position.
