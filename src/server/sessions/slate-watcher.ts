// The Slate watcher — reads `<workspace.path>/.tinstar/slate/*.json` per live run,
// validates through the SAME `parseA2uiContent` funnel notices use, and projects the
// result onto the run's store points via `docStore.applyRunSlateProjection`.
//
// Structure mirrors `status-watcher.ts` (start/stop, a per-tick loop over live runs,
// error isolation via try/catch + `log.warn`, never throw out of the loop), but adds
// two things the poll-only status watcher doesn't need (plan KTD4):
//
//   1. `fs.watch` on each run's slate dir (dir-level, created lazily when the dir first
//      appears) for LATENCY — a `tinstar-run` progress amend shows up in well under the
//      poll cadence.
//   2. A slow poll floor (~3s, reusing the status-watcher cadence) as a BACKSTOP for
//      missed inotify events on network mounts / container overlayfs. The store mutator
//      short-circuits on unchanged content, so a redundant poll re-projection is cheap.
//
// Events coalesce: a burst of writes marks the run dirty (a Set) and arms ONE debounce
// timer, so N rapid writes yield ONE `applyRunSlateProjection` per run.
//
// Failure model (plan R10/R11):
//   - A FILE-level failure (zero-byte, unreadable, unparseable JSON, non-array/object)
//     is a TORN write → RETAIN the last-valid projection (don't call the mutator), and
//     log ONCE on transition-into-invalid (not every tick).
//   - An ENTRY-level failure (a surface whose `content` fails `parseA2uiContent`, or a
//     missing headline) DROPS that entry but keeps the valid ones.
//   - Oversized files are skipped by `stat().size` BEFORE reading (never slurped).
//   - Clear (R11): a dir with no files / an explicit empty array projects `[]` (retract).
//     A torn file is NOT a clear — it retains.
//
// Path safety: only regular files directly inside the slate dir are read; `lstat`
// (not `stat`) means a symlink resolves to `isFile() === false` and is ignored, so a
// symlink escape can't smuggle a file from outside the worktree. ENOENT on the dir is
// normal (a run that never authored a slate) — no error.
//
// Server-only (rides the server esbuild bundle) and React-free.

import { existsSync, watch as fsWatch } from 'node:fs'
import { readdir, lstat, readFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { log } from '../logger'
import { parseA2uiContent } from '../../a2ui/schema'
import type { PointInput } from '../stores/slate'
import type { PointAnchor, PointAuthor, A2uiContent } from '../../domain/types'

/** A live run and the worktree the watcher resolves its slate dir from. */
export interface LiveRun {
  runId: string
  workdir: string
}

/** Minimal store surface the watcher drives — never touches the store directly. */
export interface SlateDocStore {
  applyRunSlateProjection(runId: string, inputs: PointInput[], now?: number): void
  /** Server-side staleness backstop (plan R19): mark process-authored surfaces whose
   *  writer went silent as stalled. Optional so a minimal test double needn't provide
   *  it; the watcher guards the call. */
  markStalledSlatePoints?(now?: number, thresholdMs?: number): void
}

/** A watch handle the watcher can tear down. */
export interface SlateWatchHandle {
  close(): void
}

/** Filesystem seam — injectable so tests are deterministic against a temp/fake fs. */
export interface SlateFs {
  existsSync(dir: string): boolean
  watch(dir: string, onChange: () => void): SlateWatchHandle
  readdir(dir: string): Promise<string[]> | string[]
  /** `size` + `isFile` from an `lstat` (NOT `stat`): a symlink reports `isFile:false`. */
  lstat(path: string): Promise<{ size: number; isFile: boolean }> | { size: number; isFile: boolean }
  readFile(path: string): Promise<string> | string
}

/** Timer seam — injectable so tests drive the poll/debounce without real clocks. */
export interface SlateTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SlateWatcherOpts {
  docStore: SlateDocStore
  /** List the currently-live runs + worktrees. Runs absent from a tick are torn down. */
  listLiveRuns: () => LiveRun[] | Promise<LiveRun[]>
  /** Poll-floor cadence in ms (default 3000 — the status-watcher cadence). */
  intervalMs?: number
  /** Debounce window for coalescing fs.watch bursts in ms (default 100). */
  debounceMs?: number
  /** Per-file size cap in bytes; larger files are skipped unread (default 32 KiB). */
  maxFileBytes?: number
  /** Staleness threshold in ms for the R19 sweep — a process-authored surface with no
   *  file update for this long is marked stalled (default 10 min). */
  stalenessMs?: number
  /** How often the staleness sweep runs, in ms (default 60s — low-frequency backstop). */
  stalenessSweepMs?: number
  fs?: SlateFs
  timers?: SlateTimers
  /** Content validator — the notices funnel by default; injectable for tests. */
  parseContent?: (value: unknown) => A2uiContent | null
}

const DEFAULT_INTERVAL_MS = 3000
const DEFAULT_DEBOUNCE_MS = 100
const DEFAULT_MAX_FILE_BYTES = 32 * 1024
const DEFAULT_STALENESS_MS = 10 * 60_000
const DEFAULT_STALENESS_SWEEP_MS = 60_000

const defaultFs: SlateFs = {
  existsSync,
  watch: (dir, onChange) => {
    const w = fsWatch(dir, { persistent: false }, () => onChange())
    // A deleted dir / overlayfs hiccup surfaces as an 'error' event; swallow it so the
    // process doesn't crash — the next poll re-arms the watch when the dir reappears.
    w.on('error', () => {})
    return { close: () => w.close() }
  },
  readdir: (dir) => readdir(dir),
  lstat: async (p) => {
    const s = await lstat(p)
    return { size: s.size, isFile: s.isFile() }
  },
  readFile: (p) => readFile(p, 'utf8'),
}

const defaultTimers: SlateTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class SlateWatcher {
  private readonly opts: SlateWatcherOpts
  private readonly fs: SlateFs
  private readonly timers: SlateTimers
  private readonly interval: number
  private readonly debounce: number
  private readonly maxBytes: number
  private readonly stalenessMs: number
  private readonly stalenessSweepMs: number
  private readonly parseContent: (value: unknown) => A2uiContent | null

  private pollTimer: unknown = null
  private debounceTimer: unknown = null
  private sweepTimer: unknown = null

  /** Active fs.watch handles keyed by runId, remembering which dir each watches. */
  private readonly watches = new Map<string, { dir: string; handle: SlateWatchHandle }>()
  /** Last-known worktree per live run (so a debounce flush between ticks has a path). */
  private readonly workdirs = new Map<string, string>()
  /** Runs pending re-projection — a Set so a burst coalesces to one flush per run. */
  private readonly dirty = new Set<string>()
  /** Runs currently in the retain (invalid) state, for log-once-on-transition. */
  private readonly retained = new Set<string>()

  constructor(opts: SlateWatcherOpts) {
    this.opts = opts
    this.fs = opts.fs ?? defaultFs
    this.timers = opts.timers ?? defaultTimers
    this.interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.debounce = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS
    this.stalenessSweepMs = opts.stalenessSweepMs ?? DEFAULT_STALENESS_SWEEP_MS
    this.parseContent = opts.parseContent ?? parseA2uiContent
  }

  start(): void {
    if (this.pollTimer) return
    void this.tick() // run immediately
    this.pollTimer = this.timers.setInterval(() => void this.tick(), this.interval)
    // A low-frequency backstop, independent of the fs-watch cadence: a SIGKILL'd
    // wrapper never fires its finalize trap, so only a server sweep can retire its
    // fake-live spinner (plan R19).
    this.sweepTimer = this.timers.setInterval(() => this.sweepStale(), this.stalenessSweepMs)
  }

  stop(): void {
    if (this.pollTimer) {
      this.timers.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.sweepTimer) {
      this.timers.clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.debounceTimer) {
      this.timers.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    for (const { handle } of this.watches.values()) {
      try { handle.close() } catch { /* already closed */ }
    }
    this.watches.clear()
    this.dirty.clear()
    this.workdirs.clear()
    this.retained.clear()
  }

  /** Run one poll tick now — the backstop cadence exposed for tests / manual triggering. */
  async pollOnce(): Promise<void> {
    await this.tick()
  }

  /** Run one staleness sweep now — exposed for tests / manual triggering. Error-isolated
   *  (a sweep failure must never take down the watcher). */
  sweepStale(): void {
    try {
      this.opts.docStore.markStalledSlatePoints?.(Date.now(), this.stalenessMs)
    } catch (err) {
      log.warn('slate-watcher', `staleness sweep failed: ${(err as Error).message}`)
    }
  }

  /**
   * One poll tick: refresh the live-run set, tear down watches for runs that ended,
   * (re)arm a watch per live run, and re-project every live run (the poll floor).
   * Never throws — a failure is logged and the loop continues.
   */
  private async tick(): Promise<void> {
    try {
      const runs = await this.opts.listLiveRuns()
      const live = new Set(runs.map((r) => r.runId))

      // Tear down watches for runs no longer live (no descriptor leak).
      for (const runId of [...this.watches.keys()]) {
        if (live.has(runId)) continue
        this.teardownRun(runId)
      }

      this.workdirs.clear()
      for (const { runId, workdir } of runs) {
        this.workdirs.set(runId, workdir)
        this.ensureWatch(runId, workdir)
        this.dirty.add(runId) // poll floor: re-project every live run this tick
      }

      await this.flushDirty()
    } catch (err) {
      log.warn('slate-watcher', `tick failed: ${(err as Error).message}`)
    }
  }

  /** fs.watch callback: mark the run dirty and arm ONE debounce timer (coalesce). */
  private markDirty(runId: string): void {
    this.dirty.add(runId)
    if (this.debounceTimer) return // already armed — this event coalesces into it
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = null
      void this.flushDirty()
    }, this.debounce)
  }

  /** Project every dirty run once, then clear the dirty set. Error-isolated per run. */
  private async flushDirty(): Promise<void> {
    if (this.debounceTimer) {
      this.timers.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    const runIds = [...this.dirty]
    this.dirty.clear()
    for (const runId of runIds) {
      const workdir = this.workdirs.get(runId)
      if (!workdir) continue // no longer live
      try {
        await this.projectRun(runId, workdir)
      } catch (err) {
        log.warn('slate-watcher', `${runId}: projection failed: ${(err as Error).message}`)
      }
    }
  }

  /** (Re)arm the fs.watch for a run's slate dir, lazily — only once the dir exists. */
  private ensureWatch(runId: string, workdir: string): void {
    const slateDir = this.slateDir(workdir)
    const existing = this.watches.get(runId)

    if (!this.fs.existsSync(slateDir)) {
      // Dir gone (or never created): drop any stale watch so it re-arms when it returns.
      if (existing) {
        try { existing.handle.close() } catch { /* noop */ }
        this.watches.delete(runId)
      }
      return
    }

    if (existing) {
      if (existing.dir === slateDir) return // already watching the right dir
      try { existing.handle.close() } catch { /* noop */ }
      this.watches.delete(runId)
    }

    try {
      const handle = this.fs.watch(slateDir, () => this.markDirty(runId))
      this.watches.set(runId, { dir: slateDir, handle })
    } catch (err) {
      log.debug('slate-watcher', `${runId}: fs.watch(${slateDir}) failed: ${(err as Error).message}`)
    }
  }

  private teardownRun(runId: string): void {
    const existing = this.watches.get(runId)
    if (existing) {
      try { existing.handle.close() } catch { /* noop */ }
      this.watches.delete(runId)
    }
    this.dirty.delete(runId)
    this.retained.delete(runId)
    this.workdirs.delete(runId)
  }

  /**
   * Read + validate a run's slate dir and project. On a valid read (possibly empty →
   * clear) call the mutator. On a torn read RETAIN (skip the mutator) and log once.
   */
  private async projectRun(runId: string, workdir: string): Promise<void> {
    const inputs = await this.readSlateDir(this.slateDir(workdir))
    if (inputs === null) {
      // Torn / all-invalid read — retain the last-valid projection (do NOT clear).
      if (!this.retained.has(runId)) {
        this.retained.add(runId)
        log.warn('slate-watcher', `${runId}: slate read invalid — retaining last-valid projection`)
      }
      return
    }
    this.retained.delete(runId)
    this.opts.docStore.applyRunSlateProjection(runId, inputs)
  }

  private slateDir(workdir: string): string {
    return join(workdir, '.tinstar', 'slate')
  }

  /**
   * Read all `*.json` in the slate dir (stable order: filename then array index),
   * flatten to `PointInput[]`. Returns:
   *   - `PointInput[]` (possibly empty) for a valid read — empty means CLEAR.
   *   - `null` for a TORN read (a file-level failure with no usable entries) — RETAIN.
   *
   * A mix of valid + invalid keeps the valid ones. Only when ZERO valid entries survive
   * do we distinguish clear (a genuinely-empty dir) from retain (something was torn).
   */
  private async readSlateDir(slateDir: string): Promise<PointInput[] | null> {
    if (!this.fs.existsSync(slateDir)) return [] // ENOENT is normal → no slate → clear

    let names: string[]
    try {
      names = await this.fs.readdir(slateDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] // raced deletion → clear
      return null // unexpected read error → torn → retain
    }

    const jsonNames = names
      .filter((n) => n.endsWith('.json') && basename(n) === n) // no path separators
      .sort()

    const inputs: PointInput[] = []
    let sawUnusable = false // a file that INTENDED to contribute but couldn't

    for (const name of jsonNames) {
      const path = join(slateDir, name)
      // Resolve strictly within the slate dir (defense-in-depth against `..` names).
      if (!path.startsWith(slateDir + sep)) continue

      let stat: { size: number; isFile: boolean }
      try {
        stat = await this.fs.lstat(path)
      } catch {
        continue // vanished mid-scan — ignore
      }
      if (!stat.isFile) continue // dir / socket / symlink escape — ignore
      if (stat.size > this.maxBytes) { sawUnusable = true; continue } // oversized — skip unread
      if (stat.size === 0) { sawUnusable = true; continue } // zero-byte — torn write

      let raw: string
      try {
        raw = await this.fs.readFile(path)
      } catch {
        sawUnusable = true // read failed — torn
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        sawUnusable = true // unparseable — torn
        continue
      }

      const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : null
      if (entries === null) { sawUnusable = true; continue } // not an array/object — torn

      for (const rawEntry of entries) {
        const entry = this.toPointInput(rawEntry)
        if (entry === null) { sawUnusable = true; continue } // schema-invalid entry — drop it
        inputs.push(entry)
      }
    }

    if (inputs.length > 0) return inputs // keep the valid ones (mixed valid + invalid)
    // Zero valid entries: retain if something was torn/dropped, else it's a genuine clear.
    return sawUnusable ? null : []
  }

  /**
   * Validate one raw file entry as a `PointInput`. `headline` is required; `content`
   * (when present) goes through the SAME `parseA2uiContent` funnel notices use, so a
   * hostile surface is rejected before it ever reaches the store. Returns `null` (drop)
   * on any failure.
   */
  private toPointInput(raw: unknown): PointInput | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>

    if (typeof r.headline !== 'string' || r.headline.length === 0) return null
    const out: PointInput = { headline: r.headline }

    if (typeof r.id === 'string' && r.id.length > 0) out.id = r.id

    if (r.author !== undefined) {
      if (r.author !== 'agent' && r.author !== 'user' && r.author !== 'process') return null
      out.author = r.author as PointAuthor
    }

    if (r.anchor !== undefined) {
      const anchor = toAnchor(r.anchor)
      if (anchor === null) return null
      out.anchor = anchor
    }

    if (r.content !== undefined) {
      const content = this.parseContent(r.content)
      if (content === null) return null // schema-invalid A2UI — drop this surface
      out.content = content
    }

    if (typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)) {
      out.createdAt = r.createdAt
    }

    return out
  }
}

function toAnchor(raw: unknown): PointAnchor | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (a.kind !== 'none' && a.kind !== 'decision' && a.kind !== 'surface') return null
  const anchor: PointAnchor = { kind: a.kind }
  if (typeof a.ref === 'string') anchor.ref = a.ref
  return anchor
}
