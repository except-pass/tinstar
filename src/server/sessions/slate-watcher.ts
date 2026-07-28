// The Slate watcher — reads `<workspace.path>/.tinstar/slate/*.json` per watched
// run, validates through the SAME `parseA2uiContent` funnel notices use, and hands
// the whole directory to the canonical source reconciler as one EPOCH (plan U2).
//
// It used to project onto legacy Slate points via `docStore.applyRunSlateProjection`.
// It no longer does, and that is U2's central change: canonical Surfaces are now the
// write path, `Run.slate` is derived from them, and a second legacy copy of the same
// file content would be a second writable copy of one canonical Surface — exactly
// what R28 forbids. The legacy snapshot stays on disk as migration evidence and is
// not rewritten from here (KTD5).
//
// ONE EPOCH, NOT ONE EVENT. `fs.watch` gives no ordering guarantee between the
// create and the remove halves of a rename, so a per-event reconciler retracts on
// the remove-first ordering. Debouncing to a whole-directory read makes both
// orderings the same epoch — see `source-reconciler.ts` for what that buys.
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
//   - An OMISSION is no longer a retract. A dir with no files marks every binding
//     source-missing and possibly stale; the canonical records and their threads
//     survive. A torn file is not even that — it retains.
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
import { synthesizeId, type PointInput } from '../stores/slate'
import { slateEntryWatermark, type SlateSourceEntry } from '../surfaces/slate-source'
import type { SlateSourceEpoch } from '../surfaces/source-reconciler'
import { OBJECTIVE_POINT_ID, type PointAnchor, type PointAuthor, type A2uiContent } from '../../domain/types'

/** A watched run and the worktree the watcher resolves its slate dir from. */
export interface LiveRun {
  runId: string
  workdir: string
}

/** The canonical context a run's entries reconcile against. Resolved by the caller
 *  (only it knows about runs, spaces, and incarnations) so the watcher stays a
 *  filesystem component. */
export interface SlateRunContext {
  spaceId: string
  /** The run INCARNATION — half the Surface identity basis. */
  incarnation: string
  /** The canonical id of the run's compatibility root. */
  rootSurfaceId: string
}

/** Minimal store surface the watcher drives — never touches the store directly. */
export interface SlateDocStore {
  /** Server-side staleness backstop (plan R19): mark process-authored surfaces whose
   *  writer went silent as stalled. Optional so a minimal test double needn't provide
   *  it; the watcher guards the call.
   *
   *  NOTE what this reaches after U2. It marks LEGACY points, and `Run.slate` is no
   *  longer derived from those, so the marker no longer reaches the rendered Slate —
   *  `stalledAt` is one of the three legacy fields the canonical model deliberately
   *  does not carry. The sweep is retained rather than deleted because retiring the
   *  legacy store is its own change; it is evidence-only bookkeeping today. */
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
  /** List the currently-live runs + worktrees. */
  listLiveRuns: () => LiveRun[] | Promise<LiveRun[]>
  /**
   * Runs that still have a PERSISTED source binding, with the worktree that binding
   * names. Unioned with the live set, which is what decouples source reconciliation
   * from live-session membership: a Surface promoted onto the Canvas keeps
   * reconciling after the session that authored it retires, for as long as the path
   * is still there. Runs in neither list are torn down.
   */
  listBoundRuns?: () => LiveRun[] | Promise<LiveRun[]>
  /** Resolve a run's canonical reconciliation context. `null` skips the run this
   *  epoch — a run whose incarnation cannot be derived has no stable Surface
   *  identity, and guessing one is unrecoverable (see `deriveRunIncarnation`). */
  runContext: (runId: string) => SlateRunContext | null
  /** Apply one reconciled epoch. Async; the watcher awaits it so a slow durable
   *  commit cannot overlap the next epoch for the same run. */
  applyEpoch: (epoch: SlateSourceEpoch) => Promise<unknown>
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

/** One directory read: what survived, and which files could not be trusted. */
interface SlateDirRead {
  entries: SlateSourceEntry[]
  unreadable: string[]
}

/** A directory with nothing in it. Built fresh per call rather than shared: three
 *  branches return it and the epoch it becomes is handed to a caller. */
function emptyRead(): SlateDirRead {
  return { entries: [], unreadable: [] }
}

/**
 * One validated file entry as a source observation.
 *
 * The local id is the whole point. An entry that names its own `id` keeps it; one
 * that does not gets the SAME synthesized content hash the legacy projection
 * assigned it (`synthesizeId`), which is what lets an id-less entry keep the
 * canonical Surface it already had across the U1→U2 upgrade instead of arriving as
 * a stranger.
 *
 * `anchor` and `group` are read by `toPointInput` and dropped here: the canonical
 * model has no card-vs-row distinction and expresses grouping as a container
 * Surface. They still ride the id hash, because changing what an entry hashes to
 * would re-identify every existing id-less surface exactly once, for nothing.
 */
function toSourceEntry(runId: string, file: string, input: PointInput): SlateSourceEntry {
  const author: PointAuthor = input.author ?? 'agent'
  const content = {
    headline: input.headline,
    ...(input.content ? { body: input.content } : {}),
    ...(input.refresh ? { recipe: input.refresh } : {}),
  }
  return {
    localId: input.id && input.id.length > 0 ? input.id : synthesizeId(runId, input),
    file,
    content,
    author,
    ...(input.createdAt != null ? { createdAt: input.createdAt } : {}),
    watermark: slateEntryWatermark({ ...content, author }),
  }
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
  /** Slate files last seen claiming the RESERVED objective id. Polling is every few
   *  seconds, so the warn is log-once-per-file (same log-on-transition posture as
   *  {@link retained}) — a lingering bad file must not turn the log into a drum. */
  private readonly warnedReservedId = new Set<string>()
  /** Runs with no resolvable canonical context, for log-once-on-transition. */
  private readonly contextless = new Set<string>()
  /** Per-run epoch complaints already logged (duplicate ids, refusals). */
  private readonly warnedEpoch = new Set<string>()

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
    this.contextless.clear()
    this.warnedEpoch.clear()
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
      // Live sessions FIRST so their worktree wins on a conflict: a persisted
      // binding records the path as it was when the Surface was last reconciled,
      // and the live session knows where the run is now.
      const runs = [...await this.opts.listLiveRuns()]
      const seen = new Set(runs.map(r => r.runId))
      for (const bound of (await this.opts.listBoundRuns?.()) ?? []) {
        if (seen.has(bound.runId)) continue
        seen.add(bound.runId)
        runs.push(bound)
      }

      // Tear down watches for runs that are neither live nor still bound (no
      // descriptor leak).
      for (const runId of [...this.watches.keys()]) {
        if (seen.has(runId)) continue
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
        await this.reconcileRun(runId, workdir)
      } catch (err) {
        log.warn('slate-watcher', `${runId}: reconciliation failed: ${(err as Error).message}`)
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
    this.contextless.delete(runId)
    this.workdirs.delete(runId)
  }

  /**
   * Read + validate a run's slate dir and reconcile it as one epoch.
   *
   * Two things short-circuit before the reconciler is called, and both mean RETAIN:
   * a run whose canonical context cannot be resolved (no derivable incarnation, so
   * no stable identity to bind to), and a torn read (nothing valid survived and
   * something tried to). Neither writes anything.
   */
  private async reconcileRun(runId: string, workdir: string): Promise<void> {
    const context = this.opts.runContext(runId)
    if (!context) {
      if (!this.contextless.has(runId)) {
        this.contextless.add(runId)
        log.warn('slate-watcher', `${runId}: no canonical context (no derivable incarnation or space) — slate not reconciled`)
      }
      return
    }
    this.contextless.delete(runId)

    const read = await this.readSlateDir(this.slateDir(workdir), runId)
    if (read === null) {
      // Torn / all-invalid read — retain every binding (do NOT mark any missing).
      if (!this.retained.has(runId)) {
        this.retained.add(runId)
        log.warn('slate-watcher', `${runId}: slate read invalid — retaining last-valid content`)
      }
      return
    }
    this.retained.delete(runId)

    const outcome = await this.opts.applyEpoch({
      runId,
      spaceId: context.spaceId,
      incarnation: context.incarnation,
      rootSurfaceId: context.rootSurfaceId,
      worktree: workdir,
      at: Date.now(),
      entries: read.entries,
      unreadable: read.unreadable,
    }) as { duplicates?: string[]; refusals?: { localId: string; reason: string }[] } | undefined
    this.reportEpoch(runId, outcome)
  }

  /** Surface what an epoch refused, log-once-per-(run, id) so a lingering mistake
   *  does not turn the log into a drum. Every refusal here is otherwise SILENT — a
   *  surface that simply never appears, with no error and no exit code for its
   *  author to find. */
  private reportEpoch(
    runId: string,
    outcome: { duplicates?: string[]; refusals?: { localId: string; reason: string }[] } | undefined,
  ): void {
    const now = new Set<string>()
    for (const localId of outcome?.duplicates ?? []) {
      now.add(`${runId}\u0000dup\u0000${localId}`)
      if (this.warnedEpoch.has(`${runId}\u0000dup\u0000${localId}`)) continue
      log.warn('slate-watcher', `${runId}: duplicate entry id ${JSON.stringify(localId)} in this slate — the first occurrence wins and the rest were dropped`)
    }
    for (const refusal of outcome?.refusals ?? []) {
      now.add(`${runId}\u0000ref\u0000${refusal.localId}`)
      if (this.warnedEpoch.has(`${runId}\u0000ref\u0000${refusal.localId}`)) continue
      log.warn('slate-watcher', `${runId}: entry ${JSON.stringify(refusal.localId)} was refused (${refusal.reason})`)
    }
    for (const key of [...this.warnedEpoch]) {
      if (key.startsWith(`${runId}\u0000`) && !now.has(key)) this.warnedEpoch.delete(key)
    }
    for (const key of now) this.warnedEpoch.add(key)
  }

  private slateDir(workdir: string): string {
    return join(workdir, '.tinstar', 'slate')
  }

  /**
   * Read all `*.json` in the slate dir (stable order: filename then array index) as
   * ONE epoch. Returns:
   *   - `{ entries, unreadable }` for a usable read — an empty `entries` is a
   *     genuinely empty directory, which marks every binding source-missing;
   *   - `null` for a TORN read (nothing valid survived and something tried to),
   *     which retains everything and writes nothing.
   *
   * `unreadable` is the load-bearing half. Any file-level OR entry-level failure
   * puts that FILENAME in it, and the reconciler leaves every binding addressed to
   * one of those files completely alone. That is what makes "mixed valid and invalid
   * entries update the valid Surfaces without erasing the invalid entry's last-valid
   * record" true: the invalid entry is absent from `entries`, and only its filename
   * keeps it from being read as an omission.
   *
   * It is deliberately conservative. An entry genuinely deleted from a file that
   * ALSO holds an invalid entry is not marked missing until the invalid one is
   * fixed. Retaining a surface too long is recoverable; marking a live one stale is
   * noise, and the failure the strict version would produce is the one U2 exists to
   * prevent.
   */
  private async readSlateDir(slateDir: string, runId: string): Promise<SlateDirRead | null> {
    if (!this.fs.existsSync(slateDir)) return emptyRead() // ENOENT is normal → no slate

    let names: string[]
    try {
      names = await this.fs.readdir(slateDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRead() // raced deletion
      return null // unexpected read error → torn → retain
    }

    const jsonNames = names
      .filter((n) => n.endsWith('.json') && basename(n) === n) // no path separators
      .sort()

    const entries: SlateSourceEntry[] = []
    const unreadable: string[] = []
    let sawUnusable = false // something INTENDED to contribute but couldn't
    const unusable = (name: string) => {
      sawUnusable = true
      if (!unreadable.includes(name)) unreadable.push(name)
    }
    // Files caught claiming the reserved objective id THIS pass — becomes the new
    // warn-once ledger below, so a file that stops offending can warn again if it
    // regresses, and one that keeps offending only ever logs once.
    const reservedNow = new Set<string>()

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
      if (stat.size > this.maxBytes) { unusable(name); continue } // oversized — skip unread
      if (stat.size === 0) { unusable(name); continue } // zero-byte — torn write

      let raw: string
      try {
        raw = await this.fs.readFile(path)
      } catch {
        unusable(name) // read failed — torn
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        unusable(name) // unparseable — torn
        continue
      }

      const rawEntries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : null
      if (rawEntries === null) { unusable(name); continue } // not an array/object — torn

      for (const rawEntry of rawEntries) {
        // `toPointInput` drops the reserved objective id too (it is the validator, and
        // the guard belongs there). Detect it here as well, purely so the drop is not
        // SILENT: an author whose surface simply never appears otherwise has nothing to
        // find — no error, no exit code, no trace.
        if (isReservedObjectiveEntry(rawEntry)) {
          reservedNow.add(path)
          if (!this.warnedReservedId.has(path)) {
            log.warn('slate-watcher', `${name}: entry id '${OBJECTIVE_POINT_ID}' is RESERVED for the user's Objective — entry dropped, pick another id`)
          }
          // Counts as UNUSABLE, deliberately — so a dir that yields nothing else RETAINS
          // the last-valid projection instead of clearing it. The alternative (treat it
          // as a skip, letting an empty result read as a genuine clear) would retract
          // every file-owned point of the run because one entry used a bad id, turning a
          // typo into data loss. Retaining is the recoverable failure: fix the id and the
          // next poll re-projects. The warn above is what makes it findable.
          unusable(name)
          continue
        }
        const input = toPointInput(rawEntry, this.parseContent)
        if (input === null) { unusable(name); continue } // schema-invalid entry — drop it
        entries.push(toSourceEntry(runId, name, input))
      }
    }

    // Refresh the warn-once ledger for THIS dir only. `readSlateDir` runs once per run,
    // so replacing the whole set would let two simultaneously-offending runs keep
    // evicting each other's entry and re-warn on every poll.
    for (const p of this.warnedReservedId) {
      if (p.startsWith(slateDir + sep) && !reservedNow.has(p)) this.warnedReservedId.delete(p)
    }
    for (const p of reservedNow) this.warnedReservedId.add(p)

    if (entries.length > 0) return { entries, unreadable } // mixed valid + invalid
    // Zero valid entries: retain if something was torn/dropped, else the directory is
    // genuinely empty and every binding it used to hold is missing.
    return sawUnusable ? null : { entries, unreadable }
  }
}

/**
 * Validate one raw surface-file entry as a `PointInput` — the gate that decides
 * whether a `.tinstar/slate/*.json` entry ever becomes a visible surface. `headline`
 * is required; `content` (when present) goes through the SAME `parseA2uiContent`
 * funnel notices use, so a hostile surface is rejected before it reaches the store.
 * Returns `null` (drop) on any failure.
 *
 * Module-level and EXPORTED rather than a private method: every rejection here is
 * silent (the surface simply never appears), so anything that ships a committed
 * example file — e.g. `docs/examples/slate/skill-progress-tracker.json` — needs to
 * assert its envelope against this function itself. A test that re-states the rules
 * by hand passes happily while the real gate has moved on.
 */
export function toPointInput(
  raw: unknown,
  parseContent: (value: unknown) => A2uiContent | null = parseA2uiContent,
): PointInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  if (typeof r.headline !== 'string' || r.headline.length === 0) return null
  const out: PointInput = { headline: r.headline }

  // The Objective (S2) is USER-owned and lives at a RESERVED id. A file claiming it
  // would merge into the user's objective — and, as a file point, become retractable
  // by the next projection that omits it. Drop the entry entirely (same posture as a
  // schema-invalid one) so the file-in channel can neither hijack nor delete it.
  if (r.id === OBJECTIVE_POINT_ID) return null

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
    const content = parseContent(r.content)
    if (content === null) return null // schema-invalid A2UI — drop this surface
    out.content = content
  }

  // File-owned refresh recipe (plan U3): carried through verbatim. A non-string or
  // empty recipe is simply dropped (the surface still refreshes via the bare nudge).
  if (typeof r.refresh === 'string' && r.refresh.length > 0) out.refresh = r.refresh

  // File-owned workbench set id (S4): points sharing a non-empty `group` render
  // side-by-side as one multi-question workbench. A non-string or empty value is
  // simply ignored (the point still renders as an ordinary row) — never an error,
  // matching the `refresh` posture.
  if (typeof r.group === 'string' && r.group.length > 0) out.group = r.group

  if (typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)) {
    out.createdAt = r.createdAt
  }

  return out
}

/** True when a raw file entry claims the RESERVED objective id (S2). Mirrors the drop
 *  inside `toPointInput` — this one exists so the drop can be LOGGED with the file it
 *  came from, which `toPointInput` (a pure per-entry validator) has no way to name. */
function isReservedObjectiveEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return (raw as Record<string, unknown>).id === OBJECTIVE_POINT_ID
}

function toAnchor(raw: unknown): PointAnchor | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (a.kind !== 'none' && a.kind !== 'decision' && a.kind !== 'surface') return null
  const anchor: PointAnchor = { kind: a.kind }
  if (typeof a.ref === 'string') anchor.ref = a.ref
  return anchor
}
