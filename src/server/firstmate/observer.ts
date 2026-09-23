// The first mate observer (M1: cards). Follows each configured first mate home's
// fleet ledger and mirrors every live worker as a DOCSTORE-ONLY Run — the same
// shape simulator and plugin runs already have — rendered by the bundled
// `firstmate` plugin's card widget.
//
// HARD INVARIANT: an observed worker is never a Tinstar-owned session.
//   - No session record is ever created under ~/.config/tinstar/sessions/, so
//     reconcile, the status watcher, /stop, /start, /spawn, /send-keys … (all keyed
//     on session records) can never reach it.
//   - No tmux session, window or ttyd is created or touched (that is M2, and even
//     there it happens under a `tsview-` namespace, never `tinstar-*`).
//   - `backend` is always null; the run id is `fm-…`, not a session name.
//   - A run is skipped when a real Tinstar session record shares its name, or
//     when a non-observed run already occupies the id.
//   - Tinstar never writes to a first mate home: this module and its siblings only
//     read (`readFile`/`stat`/`open 'r'`). observer.test.ts enforces both.
//
// Dismiss: deleting the card in the UI takes the docstore-only branch of
// DELETE /api/sessions/:name. The observer sees the run vanish from the docstore
// change stream and records the dismissal under `<configRoot>/firstmate/`, so the
// worker's next ledger line does not resurrect it — only a genuinely NEWER
// dispatch of the same task id does.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { EventEmitter } from 'node:events'
import type { AttentionState, Run } from '../../domain/types'
import type { DocumentChange } from '../stores/document-store'
import { log } from '../logger'
import { LedgerWatcher, type LedgerBatch } from './ledger-watcher'
import { readTaskMeta, type TaskMeta } from './meta'
import {
  findLinkedTranscript, type LinkedTranscript,
} from './transcript-link'
import { parseNewEntriesAt, readSessionStatusDetailAt, resetOffset } from '../sessions/transcript-parser'
import {
  reduceLines, runStatusFor, type FleetState, type WorkerState,
} from './reducer'

/** `Run.view` value that selects the firstmate card widget. */
export const FIRSTMATE_VIEW = 'firstmate-worker'

/** Every Nth transcript refresh rescans project dirs for already-linked workers. */
const RELINK_TICKS = 12

/** The slice of DocumentStore the observer needs. */
export interface ObserverDocStore {
  upsertRun(id: string, data: Run): void
  getRun(id: string): Run | undefined
  getAllRuns(): Run[]
  deleteRun(id: string): void
  addRecapEntry?(runId: string, entry: import('../../domain/types').RecapEntry): void
  readonly changes: EventEmitter
  activeSpaceId: string
}

export interface FirstmateObserverOpts {
  homes: string[]
  docStore: ObserverDocStore
  /** Root under which `firstmate/dismissed.json` lives — pass `getConfigRoot()`. */
  configRoot: string
  /** True when a real Tinstar session record exists under this name. */
  hasSession: (name: string) => boolean
  readMeta?: (home: string, task: string) => Promise<TaskMeta | null>
  pollMs?: number
  /** How often linked transcripts are re-read for the status light. 0 disables. */
  transcriptPollMs?: number
  /** Test seam for the Claude project directory of a worktree. */
  projectDirFor?: (worktree: string) => string | undefined
  now?: () => number
}

/** What the card renders. Server-authored; the card must never write it back. */
export interface FirstmateCardData {
  source: 'fleet-ledger'
  runId: string
  home: string
  task: string
  kind: string | null
  project: string | null
  harness: string | null
  model: string | null
  status: string | null
  statusText: string
  statusTs: number | null
  decisions: Array<{ key: string; state: string; text: string; ts: number }>
  pr: string | null
  merged: { via: string; pr: string | null } | null
  worktree: string | null
  dispatchedAt: number | null
  /** The Claude conversation linked to this worker (display only); null until found. */
  conversationId: string | null
  conversationSource: 'auto' | 'manual' | null
  /** From the linked transcript: whether the worker's claude is mid-turn. */
  activity: 'running' | 'idle' | null
}

/** What a route needs to read a linked worker's transcript. */
export interface ObservedTranscript {
  name: string
  conversationId: string
  path: string
  createdSec: number
}

interface HomeEntry {
  home: string
  tag: string
  fleet: FleetState
  watcher: LedgerWatcher
}

export function isObservedRun(run: Pick<Run, 'view' | 'backend'>): boolean {
  return run.view === FIRSTMATE_VIEW && run.backend === null
}

export function homeTag(home: string): string {
  return createHash('sha1').update(resolve(home)).digest('hex').slice(0, 6)
}

/** `fm--<task>` with one home; `fm-<tag>-<task>` once several are configured. */
export function observedRunId(task: string, tag: string | null): string {
  return tag ? `fm-${tag}-${task}` : `fm--${task}`
}

function attentionFor(w: WorkerState): AttentionState | undefined {
  if (runStatusFor(w) !== 'needs_attention' || !w.lastStatus) return undefined
  const label = w.lastStatus.state ?? 'needs attention'
  const text = w.lastStatus.text
  const reason = (text ? `${label}: ${text}` : label).replace(/\s+/g, ' ').slice(0, 80)
  // Stable setAt (the ledger timestamp) so an unchanged status does not re-emit.
  return { level: 'urgent', reason, setAt: new Date(w.lastStatus.ts * 1000).toISOString() }
}

export class FirstmateObserver {
  private readonly entries: HomeEntry[]
  private readonly readMeta: (home: string, task: string) => Promise<TaskMeta | null>
  private readonly now: () => number
  private readonly dismissedPath: string
  private readonly overridesPath: string
  /** run id → manually chosen conversation id. */
  private overrides: Record<string, string>
  /** run id → current link (auto or manual). */
  private readonly links = new Map<string, LinkedTranscript>()
  /** run id → worktree and spawn time, for the next-spawn upper bound of slot reuse. */
  private readonly spawns = new Map<string, { worktree: string; spawnSec: number | null }>()
  private refreshTick = 0
  private transcriptTimer: ReturnType<typeof setInterval> | null = null
  /** run id → owning home + task, for runs this process created. */
  private readonly owned = new Map<string, { home: string; task: string }>()
  /** Ids the observer is deleting itself, so they are not mistaken for a dismissal. */
  private readonly selfDeleting = new Set<string>()
  /** run id → unix seconds of the dismissal. */
  private dismissed: Record<string, number>
  private readonly onChange: (c: DocumentChange) => void
  private started = false

  constructor(private readonly opts: FirstmateObserverOpts) {
    this.readMeta = opts.readMeta ?? readTaskMeta
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.dismissedPath = join(opts.configRoot, 'firstmate', 'dismissed.json')
    this.dismissed = this.loadDismissed()
    this.overridesPath = join(opts.configRoot, 'firstmate', 'conversation-overrides.json')
    this.overrides = this.loadStringMap(this.overridesPath)
    const homes = [...new Set(opts.homes.map(h => resolve(h)))]
    const multi = homes.length > 1
    this.entries = homes.map(home => ({
      home,
      tag: multi ? homeTag(home) : '',
      fleet: new Map(),
      watcher: new LedgerWatcher({
        home,
        pollMs: opts.pollMs,
        onBatch: (h, batch) => this.onBatch(h, batch),
      }),
    }))
    this.onChange = (c: DocumentChange) => this.onDocChange(c)
  }

  /** Start following every home. Resolves once each ledger has been read once and
   *  stale persisted cards (from a previous process) have been pruned. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.opts.docStore.changes.on('change', this.onChange)
    await Promise.all(this.entries.map(e => e.watcher.pollOnce()))
    this.pruneStale()
    for (const e of this.entries) e.watcher.start()
    const every = this.opts.transcriptPollMs ?? 5000
    if (every > 0) {
      this.transcriptTimer = setInterval(() => void this.refreshTranscripts(), every)
      this.transcriptTimer.unref?.()
    }
  }

  stop(): void {
    this.opts.docStore.changes.off('change', this.onChange)
    for (const e of this.entries) e.watcher.stop()
    if (this.transcriptTimer) clearInterval(this.transcriptTimer)
    this.transcriptTimer = null
    this.started = false
  }

  private entryFor(home: string): HomeEntry | undefined {
    return this.entries.find(e => e.home === home)
  }

  private async onBatch(home: string, batch: LedgerBatch): Promise<void> {
    const entry = this.entryFor(home)
    if (!entry) return
    let tasks: Set<string>
    if (batch.reset) {
      // Truncated ledger: forget everything derived from it and rebuild.
      tasks = new Set(entry.fleet.keys())
      for (const o of this.owned.values()) if (o.home === home) tasks.add(o.task)
      entry.fleet.clear()
    } else {
      tasks = new Set()
    }
    for (const t of reduceLines(entry.fleet, batch.lines)) tasks.add(t)
    // Learn every worker's worktree and spawn time first, so an older worker in a
    // reused slot sees the newer spawn's upper bound on its first link.
    const metas = new Map<string, TaskMeta | null>()
    await Promise.all([...tasks].map(async task => {
      const w = entry.fleet.get(task)
      if (!w) return
      const meta = await this.readMeta(entry.home, task)
      metas.set(task, meta)
      this.recordSpawn(observedRunId(task, entry.tag || null), w, meta)
    }))
    for (const task of tasks) await this.project(entry, task, true, metas.get(task))
  }

  private recordSpawn(runId: string, w: WorkerState, meta: TaskMeta | null): void {
    if (meta?.worktree) this.spawns.set(runId, { worktree: meta.worktree, spawnSec: meta.spawnGen ?? w.dispatchedAt })
  }

  /** The earliest spawn into `worktree` later than `spawnSec` by another worker. */
  private nextSpawnAfter(runId: string, worktree: string, spawnSec: number | null): number | null {
    if (spawnSec === null) return null
    let next: number | null = null
    for (const [id, s] of this.spawns) {
      if (id === runId || s.worktree !== worktree || s.spawnSec === null || s.spawnSec <= spawnSec) continue
      if (next === null || s.spawnSec < next) next = s.spawnSec
    }
    return next
  }

  /** `rediscover` false reuses an existing link instead of rescanning the project dir. */
  private async project(entry: HomeEntry, task: string, rediscover = true, prefetched?: TaskMeta | null): Promise<void> {
    const runId = observedRunId(task, entry.tag || null)
    const w = entry.fleet.get(task)
    if (!w || w.cleanedUpAt !== null) {
      if (!w) this.spawns.delete(runId)
      if (w && this.dismissed[runId] !== undefined) this.forgetDismissal(runId)
      this.removeRun(runId)
      return
    }
    const dismissedAt = this.dismissed[runId]
    if (dismissedAt !== undefined) {
      if (w.dispatchedAt !== null && w.dispatchedAt > dismissedAt) this.forgetDismissal(runId)
      else { this.removeRun(runId); return }
    }
    if (this.opts.hasSession(runId)) {
      log.warn('firstmate', `not showing ${task}: a Tinstar session named ${runId} exists`)
      return
    }
    const existing = this.opts.docStore.getRun(runId)
    if (existing && !isObservedRun(existing)) {
      log.warn('firstmate', `not showing ${task}: run ${runId} is not an observed run`)
      return
    }
    const meta = prefetched !== undefined ? prefetched : await this.readMeta(entry.home, task)
    // The await above may have raced a dismissal or a reset; re-check before writing.
    if (this.dismissed[runId] !== undefined && !(w.dispatchedAt !== null && w.dispatchedAt > this.dismissed[runId])) return
    if (entry.fleet.get(task) !== w) return
    this.recordSpawn(runId, w, meta)
    this.upsert(entry, runId, w, meta, rediscover)
  }

  private upsert(entry: HomeEntry, runId: string, w: WorkerState, meta: TaskMeta | null, rediscover: boolean): void {
    const { docStore } = this.opts
    const existing = docStore.getRun(runId)
    const project = w.project ?? meta?.project ?? null
    const worktree = meta?.worktree ?? null
    const link = this.linkFor(runId, worktree, meta?.spawnGen ?? w.dispatchedAt, rediscover)
    const activity = link ? readSessionStatusDetailAt(link.path)?.state ?? null : null
    const card: FirstmateCardData = {
      source: 'fleet-ledger',
      runId,
      home: entry.home,
      task: w.task,
      kind: w.kind,
      project,
      harness: w.harness,
      model: w.model,
      status: w.lastStatus?.state ?? null,
      statusText: w.lastStatus?.text ?? '',
      statusTs: w.lastStatus?.ts ?? null,
      decisions: Object.values(w.openDecisions).sort((a, b) => a.ts - b.ts),
      pr: w.pr,
      merged: w.merged ? { via: w.merged.via, pr: w.merged.pr } : null,
      worktree,
      dispatchedAt: w.dispatchedAt,
      conversationId: link?.conversationId ?? null,
      conversationSource: link?.source ?? null,
      activity,
    }
    const viewData = { firstmate: card }
    // Reuse the previous object when nothing changed: runShallowEqual compares
    // `viewData` by reference, so a fresh-but-equal object would re-emit every poll.
    const sameView = existing && JSON.stringify(existing.viewData) === JSON.stringify(viewData)
    const attention = attentionFor(w)
    const startedAt = w.dispatchedAt ?? w.updatedAt
    const run: Run = {
      ...(existing ?? {}),
      id: runId,
      name: w.task,
      status: runStatusFor(w),
      background: false,
      blocked: false,
      sessionId: runId,
      scope: project ? { project, worktree: w.task } : undefined,
      taskId: '',
      initiative: '',
      epic: '',
      task: '',
      repo: project ?? '',
      worktree: '',
      touchedFiles: existing?.touchedFiles ?? [],
      recapEntries: existing?.recapEntries ?? [],
      rawLogs: '',
      port: null,
      backend: null,
      view: FIRSTMATE_VIEW,
      viewData: sameView ? existing.viewData : viewData,
      attention,
      worktreeId: '',
      createdAt: existing?.createdAt ?? new Date(startedAt * 1000).toISOString(),
      spaceId: existing?.spaceId || docStore.activeSpaceId,
    }
    if (!attention) delete run.attention
    // Keep the same scope object when unchanged is unnecessary: runShallowEqual
    // compares scope by its string members.
    this.owned.set(runId, { home: entry.home, task: w.task })
    docStore.upsertRun(runId, run)
    if (link) this.feedRecap(runId, link, activity)
  }

  /** Resolve (and remember) the worker's conversation. A changed link restarts the
   *  recap parser so the new conversation is read from its beginning. */
  private linkFor(runId: string, worktree: string | null, spawnSec: number | null, rediscover: boolean): LinkedTranscript | null {
    const prev = this.links.get(runId)
    if (!rediscover && prev && worktree) {
      try { return { ...prev, mtimeMs: statSync(prev.path).mtimeMs } } catch { /* gone: rediscover */ }
    }
    let link: LinkedTranscript | null = null
    if (worktree) {
      try {
        link = findLinkedTranscript({
          worktree, spawnSec, override: this.overrides[runId] ?? null,
          nextSpawnSec: this.nextSpawnAfter(runId, worktree, spawnSec),
          projectDir: this.opts.projectDirFor?.(worktree),
        })
      } catch (err) {
        log.debug('firstmate', `transcript link failed for ${runId}: ${(err as Error).message}`)
      }
    }
    if (prev && prev.path !== link?.path) resetOffset(runId)
    if (link) this.links.set(runId, link)
    else this.links.delete(runId)
    return link
  }

  private feedRecap(runId: string, link: LinkedTranscript, activity: 'running' | 'idle' | null): void {
    const { docStore } = this.opts
    if (!docStore.addRecapEntry) return
    try {
      for (const entry of parseNewEntriesAt(runId, link.path, activity ?? 'idle')) docStore.addRecapEntry(runId, entry)
    } catch (err) {
      log.debug('firstmate', `recap parse failed for ${runId}: ${(err as Error).message}`)
    }
  }

  /** Re-project every unfinished (or still-running) worker so transcript activity shows without a
   *  ledger line. Linked workers rescan their project dir only every RELINK_TICKS. */
  private async refreshTranscripts(): Promise<void> {
    const rediscover = ++this.refreshTick % RELINK_TICKS === 0
    for (const entry of this.entries) {
      for (const [task, w] of [...entry.fleet]) {
        if ((w.merged || w.lastStatus?.state === 'done') && this.lastActivity(entry, task) !== 'running') continue
        try { await this.project(entry, task, rediscover) } catch (err) {
          log.debug('firstmate', `refresh failed for ${task}: ${(err as Error).message}`)
        }
      }
    }
  }

  private lastActivity(entry: HomeEntry, task: string): FirstmateCardData['activity'] {
    const run = this.opts.docStore.getRun(observedRunId(task, entry.tag || null))
    return (run?.viewData as { firstmate?: FirstmateCardData } | undefined)?.firstmate?.activity ?? null
  }

  /** The transcript behind a card, for the timeline route. Null when not observed
   *  or not linked yet. */
  resolveTranscript(runId: string): ObservedTranscript | null {
    const link = this.links.get(runId)
    const run = this.opts.docStore.getRun(runId)
    if (!link || !run || !this.owned.has(runId)) return null
    return {
      name: runId,
      conversationId: link.conversationId,
      path: link.path,
      createdSec: Date.parse(run.createdAt) / 1000,
    }
  }

  /** Point a card at a specific conversation id (or clear with null → back to the
   *  heuristic). Display-only; returns false for an unknown card, or an id with no
   *  transcript in the worker's project dir. */
  async setConversationOverride(runId: string, conversationId: string | null): Promise<boolean> {
    const owner = this.owned.get(runId)
    if (!owner) return false
    if (conversationId !== null) {
      const worktree = this.spawns.get(runId)?.worktree
      if (!worktree || !findLinkedTranscript({
        worktree, spawnSec: null, override: conversationId, projectDir: this.opts.projectDirFor?.(worktree),
      })) return false
    }
    if (conversationId === null) delete this.overrides[runId]
    else this.overrides[runId] = conversationId
    this.saveStringMap(this.overridesPath, this.overrides)
    const entry = this.entryFor(owner.home)
    if (entry) await this.project(entry, owner.task)
    return true
  }

  private removeRun(runId: string): void {
    this.owned.delete(runId)
    if (this.links.delete(runId)) resetOffset(runId)
    if (!this.opts.docStore.getRun(runId)) return
    this.selfDeleting.add(runId)
    try { this.opts.docStore.deleteRun(runId) } finally { this.selfDeleting.delete(runId) }
  }

  /** Drop persisted observed runs that no ledger currently backs (previous process,
   *  truncated ledger, home no longer configured). */
  private pruneStale(): void {
    for (const run of this.opts.docStore.getAllRuns()) {
      if (isObservedRun(run) && !this.owned.has(run.id)) this.removeRun(run.id)
    }
  }

  private onDocChange(c: DocumentChange): void {
    if (c.entity !== 'run' || c.data !== null) return
    if (!this.owned.has(c.id) || this.selfDeleting.has(c.id)) return
    // Someone else (the UI's delete) removed a card we own: that is a dismissal.
    this.owned.delete(c.id)
    this.dismissed[c.id] = this.now()
    this.saveDismissed()
  }

  private forgetDismissal(runId: string): void {
    delete this.dismissed[runId]
    this.saveDismissed()
  }

  private loadStringMap(path: string): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
      return out
    } catch {
      return {}
    }
  }

  private saveStringMap(path: string, map: Record<string, string>): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(map))
      renameSync(tmp, path)
    } catch (err) {
      log.warn('firstmate', `could not persist ${path}: ${(err as Error).message}`)
    }
  }

  private loadDismissed(): Record<string, number> {
    try {
      const parsed = JSON.parse(readFileSync(this.dismissedPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number') out[k] = v
      return out
    } catch {
      return {}
    }
  }

  /** Writes only under Tinstar's own config root — never into a first mate home. */
  private saveDismissed(): void {
    try {
      mkdirSync(dirname(this.dismissedPath), { recursive: true })
      const tmp = `${this.dismissedPath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.dismissed))
      renameSync(tmp, this.dismissedPath)
    } catch (err) {
      log.warn('firstmate', `could not persist dismissed cards: ${(err as Error).message}`)
    }
  }
}
