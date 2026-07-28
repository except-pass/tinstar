// The Surface sidecar — crash-safe durable storage for the canonical Surface store
// (plan KTD5/KTD7).
//
// This is deliberately NOT the persistence posture `DocumentStore` uses. That one
// is a 500ms-debounced whole-file `writeFileSync` of every entity it owns, with no
// fsync and no atomic rename (`document-store.ts` `schedulePersist`/`persistNow`),
// and its load path swallows a corrupt file and silently starts empty — which the
// very next mutation then writes over the user's unreadable-but-recoverable data.
// For run metadata that is a survivable trade. For canonical Surfaces it is not:
// a Surface owns a human's thread and arrangement, and there is no source file to
// re-derive it from. So this module is:
//
//   · a SEPARATE file from `docstore.json`, so the two stores can never replace
//     each other's snapshots (a Surface commit rewrites only Surface bytes);
//   · schema-versioned, so a future shape change is a decision rather than a
//     misparse;
//   · written through one serialized transaction queue, so two concurrent commits
//     cannot interleave and produce a snapshot neither of them intended;
//   · durable in a specific ORDER — validate a complete candidate, fsync the temp
//     file, rotate the last-known-good backup, rename temp over primary, fsync the
//     containing directory. The directory fsync is the step that makes the rename
//     itself survive power loss; without it the file contents are durable but the
//     name may still point at the old inode;
//   · explicit about load health. `healthy` | `recovered` | `faulted-read-only` is
//     returned SYNCHRONOUSLY from `open`, so the caller has it in hand before any
//     session rehydration could start writing.
//
// The faulted path is the one that matters most. When neither snapshot is usable
// this store refuses every mutation AND every write, and leaves both files byte
// untouched. A bug there does not make data unreadable — it DESTROYS it, by
// persisting an empty store over the evidence a human could otherwise have
// recovered by hand. Hence: no repair-by-truncation, no "start fresh", no write of
// any kind while faulted.
//
// Interface constraint from KTD5: callers see a REVISION-CHECKED TRANSACTION OVER
// RECORDS and never the whole-snapshot shape. `SidecarSnapshot` is private on
// purpose. JSON is ratified as the engine for this release, but it must remain an
// implementation detail so that swapping to an embedded store later does not touch
// U2-U8.
//
// NOTHING CALLS THIS YET. U1 introduces the store and its persistence; wiring it
// into `DocumentStore`, SSE, boot, and the legacy migration are separate units. A
// reviewer should observe zero runtime change.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Surface } from '../../domain/types'
import { getConfigRoot } from '../configRoot'
import { backendSingletonOwner } from '../infra/lock'

/** Bumped whenever the persisted shape changes in a way this build cannot read as
 *  written. An UNRECOGNISED version is treated as unreadable rather than
 *  best-effort parsed: guessing at a shape written by a different build is how a
 *  downgrade quietly drops the fields it did not know about. */
export const SURFACE_SIDECAR_SCHEMA_VERSION = 1

/** How many idempotency receipts survive in the snapshot. Bounded because KTD5
 *  requires the sidecar to stay bounded and a receipt is only useful for the
 *  window between a lost response and its retry — measured in seconds, not days.
 *  Oldest are evicted first. */
const MAX_IDEMPOTENCY_ENTRIES = 256

/** Anything `JSON.stringify` round-trips unchanged. The caller's idempotency
 *  result is opaque to this module — it is whatever that caller needs to hand back
 *  on a retry — but it has to survive the snapshot, so it cannot be arbitrary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

/** Where the sidecar's three files live. Exported so a caller (and a test) can
 *  name them without re-deriving the convention. */
export interface SurfaceSidecarPaths {
  dir: string
  primary: string
  backup: string
  /** Same directory as `primary` — a cross-device rename is not atomic, so the
   *  temp file may never live in the OS temp dir. */
  temp: string
  backupTemp: string
}

export function surfaceSidecarPaths(dir: string = getConfigRoot()): SurfaceSidecarPaths {
  const primary = join(dir, 'surfaces.json')
  const backup = join(dir, 'surfaces.backup.json')
  return { dir, primary, backup, temp: `${primary}.tmp`, backupTemp: `${backup}.tmp` }
}

/** Result of hydrating the sidecar (KTD5).
 *  · `healthy` — the primary snapshot was read, or there is nothing on disk yet;
 *  · `recovered` — the primary was unusable and the backup supplied the records;
 *  · `faulted-read-only` — nothing usable, and both files are being preserved as
 *    evidence. Mutations and persistence are refused for the process lifetime. */
export type SurfaceStoreHealth = 'healthy' | 'recovered' | 'faulted-read-only'

/** Why a snapshot could not be used. Reported rather than logged-and-forgotten,
 *  because the degraded marker the UI shows has to say what actually happened. */
export interface SurfaceSnapshotProblem {
  path: string
  /** `missing` is not a fault on its own — a first boot has no primary. It only
   *  becomes one when the OTHER file is corrupt rather than absent. */
  kind: 'missing' | 'unparsable' | 'unknown-version' | 'malformed'
  detail: string
}

export interface SurfaceStoreFault {
  primary: SurfaceSnapshotProblem
  backup: SurfaceSnapshotProblem
}

export interface SurfaceLoadOutcome {
  health: SurfaceStoreHealth
  /** Which file the records came from. `empty` means neither file exists yet. */
  from: 'primary' | 'backup' | 'empty' | 'none'
  /** The flat record set, for the caller to hand to `SurfaceStore.load`. Record
   *  level, never the snapshot shape — see the KTD5 interface constraint above. */
  records: Surface[]
  /** Records dropped for failing the shape guard. Non-zero means the file is
   *  partly damaged: the readable records were kept, the rest are reported rather
   *  than silently discarded. */
  quarantined: number
  /** spaceId → persisted topology revision. Empty for a snapshot written before
   *  U3, which carried no counter; the store then starts from the floor its records
   *  imply (see `buildTopologyIndex`). */
  topologyRevs: Record<string, number>
  /** Present exactly when `health === 'faulted-read-only'`. */
  fault?: SurfaceStoreFault
}

/** What a read-only inspection of the sidecar files found. See
 *  {@link inspectSurfaceSidecar}. */
export interface SurfaceSidecarInspection {
  paths: SurfaceSidecarPaths
  outcome: SurfaceLoadOutcome
  /** The line the server WOULD have logged for this outcome (recovery warning,
   *  fault error). Present only when the outcome is not plainly healthy — an
   *  inspection returns it instead of printing it, so the caller decides. */
  log?: { level: 'warn' | 'error'; message: string }
}

/**
 * Read the sidecar files and report what a boot would make of them — WITHOUT
 * opening the store.
 *
 * `SurfaceSidecar.open` asserts the backend singleton and creates its directory.
 * Both are wrong for a diagnostics tool, which has to be runnable while the
 * server is up and must not leave a trace. This runs exactly the load half of
 * `hydrate` — same files, same order, same verdict — and returns it. It creates
 * nothing, writes nothing, and consults no lock.
 */
export function inspectSurfaceSidecar(dir: string = getConfigRoot()): SurfaceSidecarInspection {
  const paths = surfaceSidecarPaths(dir)
  const h = hydrateSidecarFiles(paths)
  return { paths, outcome: h.outcome, ...(h.log ? { log: h.log } : {}) }
}

/** The steps of the atomic write, in execution order. Named as a type so tests can
 *  simulate a crash at an exact point instead of racing a timer. */
export type SidecarWriteStep =
  | 'write-temp'
  | 'fsync-temp'
  | 'rotate-backup'
  | 'rename-primary'
  | 'fsync-dir'

/**
 * The filesystem operations the atomic write depends on.
 *
 * Injected for the same reason `SurfaceStore` takes an injected `emit`: the two
 * fsyncs have NO in-process observable effect, so without a seam here the only
 * thing a test can assert about them is that the code announced a step it might
 * not have performed. Since surviving power loss is the entire reason this module
 * exists, "the fsync happened" has to be assertable. Defaults to `node:fs`.
 */
export interface SidecarIo {
  open(path: string, flags: 'w' | 'r'): number
  writeString(fd: number, data: string): void
  writeBuffer(fd: number, data: Buffer): void
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  readFile(path: string): Buffer
  exists(path: string): boolean
}

export const nodeSidecarIo: SidecarIo = {
  open: (path, flags) => openSync(path, flags),
  writeString: (fd, data) => { writeSync(fd, data) },
  writeBuffer: (fd, data) => { writeSync(fd, data) },
  fsync: fd => { fsyncSync(fd) },
  close: fd => { closeSync(fd) },
  rename: (from, to) => { renameSync(from, to) },
  readFile: path => readFileSync(path),
  exists: path => existsSync(path),
}

export interface SidecarHooks {
  /** Awaited immediately BEFORE `step` executes. Throwing from it simulates a
   *  crash or an IO error at exactly that point; returning a promise lets a test
   *  hold a transaction open and prove the queue serializes the next one. */
  beforeStep?: (step: SidecarWriteStep) => void | Promise<void>
}

export interface SurfaceSidecarOptions {
  /** Directory holding the sidecar. Defaults to `getConfigRoot()` — server-side
   *  config paths never go through `homedir()` (docs/conventions.md). */
  dir?: string
  /** The backend singleton lock to ASSERT. Defaults to the same
   *  `<configRoot>/server.lock` `standalone.ts` acquires. */
  lockPath?: string
  hooks?: SidecarHooks
  /** Defaults to {@link nodeSidecarIo}. */
  io?: SidecarIo
}

/** Why a transaction was refused. Returned rather than thrown for the same reason
 *  `SurfaceStore` returns `SurfaceRejection`: a stale revision is an ordinary race
 *  between two authors, not a programming error. */
export type SurfaceCommitRejection =
  /** The store is faulted. Nothing was written and nothing will be. */
  | 'faulted-read-only'
  /** A `put` was not newer than the persisted record, or an `expectedRevs` entry
   *  did not match. */
  | 'stale-revision'
  /** A `drop` named a record that is not persisted. */
  | 'unknown-record'
  /** A record failed the shape guard, or the candidate did not survive a
   *  serialize/parse round trip. Caught BEFORE any file is touched. */
  | 'invalid-record'
  /** The caller's own {@link SurfaceTransaction.precommit} re-validation refused,
   *  from inside the queue and before any file was touched. `detail` carries the
   *  caller's reason verbatim — this module deliberately does not interpret it. */
  | 'precommit-refused'
  /** The durable write failed. Live state is unchanged — see `commit`. */
  | 'write-failed'

export type SurfaceCommitResult =
  | {
      committed: true
      /** True when this key was already durable and the transaction was NOT
       *  re-applied; `result` is the one persisted by the original commit. */
      replayed: boolean
      /** False when the candidate was byte-identical to what is already on disk,
       *  so no write was needed. */
      wrote: boolean
      /** The records this transaction wrote, for the caller to install and emit. */
      records: Surface[]
      result?: JsonValue
    }
  | { committed: false; reason: SurfaceCommitRejection; detail?: string }

/**
 * One revision-checked transaction over records.
 *
 * `puts` are whole records (the same shape `SurfaceStore.upsertSurface` takes), so
 * the durable layer never has to understand field-level semantics. Topology
 * validation — cycles, cross-space parentage, sibling order — belongs to
 * `SurfaceStore`; what belongs HERE is only what durability needs: is this write
 * newer than what is on disk, and can the whole candidate be made durable at once.
 */
export interface SurfaceTransaction {
  puts?: Surface[]
  /** Records to remove from the snapshot entirely. Note KTD15: an ordinary user
   *  "delete" is a MOVE into the recovery store and therefore a `put`, not a drop.
   *  Drops exist for the lifecycle cascade (`clearSpace`, `clear`), where the
   *  owning run or space no longer exists at all. */
  drops?: string[]
  /** Compare-and-swap against the PERSISTED revisions. `0` means "expect this
   *  record to be absent", which is how a create states that it is a create. An id
   *  the caller omits is not checked — the migration and boot paths are
   *  single-writer and have nothing to race. */
  expectedRevs?: Record<string, number>
  /** Makes the transaction replayable. A retry with the same key returns the
   *  persisted `result` and re-applies NOTHING (KTD7's "crash after SSE but before
   *  response"). */
  idempotencyKey?: string
  /** Persisted alongside the records IN THE SAME snapshot write, so a receipt can
   *  never exist for a transaction whose records did not land, or vice versa. */
  result?: JsonValue
  /**
   * Re-validate, from INSIDE the transaction queue, immediately before the durable
   * write — and optionally replace what is written.
   *
   * This is the plan/apply seam's serialization point. The caller validates a
   * candidate against ITS live state before calling `commit`; between that
   * validation and this write, live state is free to move, and the whole-file
   * rewrite this module performs is not a short window. Running the caller's own
   * re-validation here puts it in the same serialized domain as the write without
   * dragging the caller's planning into the queue — which would serialize every
   * mutation in a space behind a file write and was rejected for that reason.
   *
   * Returning `ok: false` aborts with `precommit-refused` and touches nothing.
   * Returning `puts`/`topologyRevs`/`result` replaces the transaction's own, which
   * is how a caller allocates a revision at COMMIT time rather than at plan time —
   * and then reports the revision it actually allocated rather than the one it
   * proposed. The replacement goes through every check the originals would have:
   * shape guard, `expectedRevs`, and the newer-revision rule.
   *
   * NOT called on a replayed retry: a replay applies nothing, so there is nothing
   * to re-validate.
   */
  precommit?: () =>
    | { ok: true; puts?: Surface[]; topologyRevs?: Record<string, number>; result?: JsonValue }
    | { ok: false; reason: string }
  /** spaceId → topology revision to persist with this transaction. Merged
   *  monotonically into the stored counters — the sidecar never lowers one. */
  topologyRevs?: Record<string, number>
  /**
   * Invoked exactly once, AFTER the durable write and after the sidecar's own
   * record set is updated — the "install in memory, then emit one batch" half of
   * KTD7's ordering. Taking it as a callback is what lets this module enforce the
   * order rather than document it: a write failure returns before `onDurable` can
   * run, so live state and clients cannot observe a transaction that did not
   * commit. It is NOT called on a replayed retry.
   */
  onDurable?: (records: Surface[]) => void
}

/** The persisted shape. PRIVATE by design (KTD5): callers transact over records
 *  and must never see the snapshot, so that the engine stays swappable. */
interface SidecarSnapshot {
  version: number
  records: Surface[]
  idempotency: IdempotencyEntry[]
  /**
   * spaceId → topology revision. PERSISTED rather than derived from the records,
   * which is the KTD5 amendment U3 forced: `purge` erases records, so a revision
   * reconstructed as `max(homeRev)` over the survivors runs backwards and stops
   * being a usable compare-and-swap token.
   *
   * OPTIONAL on read, deliberately, and NOT a schema-version bump: a snapshot
   * written by U1/U1e has no counter, and treating that as an unreadable version
   * would fault an existing install into read-only on the strength of a field it
   * predates. Absent, the store starts each space at the floor its records imply,
   * which is exactly the old behaviour.
   */
  topologyRevs?: Record<string, number>
}

interface IdempotencyEntry {
  key: string
  /** Epoch ms of the commit, used only for eviction order. */
  at: number
  /** Ids the transaction wrote, so a replay can say WHAT it applied without
   *  duplicating whole records into the receipt. */
  ids: string[]
  result?: JsonValue
}

/** The guard every persisted record must pass. Deliberately structural and
 *  minimal: it checks the fields the store INDEXES by (`SurfaceStore.load` skips
 *  on the same three) plus the two revisions the reload contract rebuilds topology
 *  from. A record failing it cannot be addressed, indexed, or repaired. */
function isUsableRecord(r: unknown): r is Surface {
  if (!r || typeof r !== 'object') return false
  const s = r as Partial<Surface>
  if (typeof s.id !== 'string' || s.id.length === 0) return false
  if (typeof s.spaceId !== 'string' || s.spaceId.length === 0) return false
  if (!s.home || typeof s.home !== 'object') return false
  // All three home kinds, `recovery` included. It is not optional: under KTD15 a
  // deleted subtree's root IS a record whose home is the recovery store, so a
  // guard that knew only two kinds would reject every delete at the durable
  // boundary — and, worse, would quarantine an already-persisted deleted record
  // on the next boot, erasing the one copy of work the recovery store exists to
  // keep.
  if (s.home.kind === 'canvas' || s.home.kind === 'recovery') {
    if (typeof s.home.spaceId !== 'string') return false
  } else if (s.home.kind === 'surface') {
    if (typeof s.home.surfaceId !== 'string') return false
  } else return false
  // Both revisions must be real finite numbers. `NaN` matters specifically because
  // JSON turns it into `null`, so a NaN revision that reached the file would come
  // back as an unusable record on the next boot instead of failing here.
  if (typeof s.rev !== 'number' || !Number.isFinite(s.rev)) return false
  if (typeof s.homeRev !== 'number' || !Number.isFinite(s.homeRev)) return false
  return true
}

type ReadResult =
  | {
      ok: true
      records: Surface[]
      idempotency: IdempotencyEntry[]
      quarantined: number
      topologyRevs: Record<string, number>
    }
  | { ok: false; problem: SurfaceSnapshotProblem }

/** Keep only finite numeric entries. A hand-edited snapshot is a ratified property
 *  of the JSON sidecar, so a counter someone typed `"3"` into must not become the
 *  space's revision — it would compare unequal to every real token forever. */
function readTopologyRevs(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [spaceId, rev] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rev === 'number' && Number.isFinite(rev)) out[spaceId] = rev
  }
  return out
}

/** Read and validate one snapshot file. Never repairs, never writes. */
function readSnapshotFile(path: string): ReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const kind = err.code === 'ENOENT' ? 'missing' : 'unparsable'
    return { ok: false, problem: { path, kind, detail: err.message } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, problem: { path, kind: 'unparsable', detail: (e as Error).message } }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problem: { path, kind: 'malformed', detail: 'snapshot root is not an object' } }
  }
  const snap = parsed as Partial<SidecarSnapshot>
  if (snap.version !== SURFACE_SIDECAR_SCHEMA_VERSION) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'unknown-version',
        detail: `expected schema ${SURFACE_SIDECAR_SCHEMA_VERSION}, found ${String(snap.version)}`,
      },
    }
  }
  if (!Array.isArray(snap.records)) {
    return { ok: false, problem: { path, kind: 'malformed', detail: 'records is not an array' } }
  }
  // Individual bad records are QUARANTINED rather than condemning the whole file.
  // The alternative — treating one damaged record as a corrupt snapshot — would
  // throw away every newer record around it and fall back to a strictly older
  // backup. Losing one unreadable record beats losing an hour of good ones, and
  // the count is reported so the loss is never invisible.
  const records: Surface[] = []
  let quarantined = 0
  const seen = new Set<string>()
  for (const r of snap.records) {
    if (!isUsableRecord(r) || seen.has(r.id)) { quarantined++; continue }
    seen.add(r.id)
    records.push(r)
  }
  const idempotency = Array.isArray(snap.idempotency)
    ? snap.idempotency.filter(
        (e): e is IdempotencyEntry =>
          !!e && typeof e === 'object' && typeof (e as IdempotencyEntry).key === 'string',
      )
    : []
  return { ok: true, records, idempotency, quarantined, topologyRevs: readTopologyRevs(snap.topologyRevs) }
}

interface SidecarHydration {
  outcome: SurfaceLoadOutcome
  idempotency: IdempotencyEntry[]
  primaryIsKnownGood: boolean
  log?: { level: 'warn' | 'error'; message: string }
}

/**
 * Decide the load outcome from the two snapshot files. PURE with respect to the
 * store: it reads, it never writes, and it never logs — the caller does both.
 * Shared by `SurfaceSidecar.hydrate` and {@link inspectSurfaceSidecar} so a
 * diagnostics dump can never disagree with what the server would actually do.
 */
function hydrateSidecarFiles(paths: SurfaceSidecarPaths): SidecarHydration {
  const primary = readSnapshotFile(paths.primary)
  if (primary.ok) {
    return {
      outcome: {
        health: 'healthy', from: 'primary', records: primary.records,
        quarantined: primary.quarantined, topologyRevs: primary.topologyRevs,
      },
      idempotency: primary.idempotency,
      primaryIsKnownGood: true,
    }
  }

  const backup = readSnapshotFile(paths.backup)
  if (backup.ok) {
    // Covers both "primary is corrupt" and "we crashed after rotation but before
    // the rename" — in either case the backup is the newest readable snapshot.
    return {
      outcome: {
        health: 'recovered', from: 'backup', records: backup.records,
        quarantined: backup.quarantined, topologyRevs: backup.topologyRevs,
      },
      idempotency: backup.idempotency,
      primaryIsKnownGood: false,
      log: {
        level: 'warn',
        message:
          `[surfaces] primary snapshot unusable (${primary.problem.kind}: ${primary.problem.detail}); ` +
          `recovered ${backup.records.length} record(s) from ${paths.backup}`,
      },
    }
  }

  if (primary.problem.kind === 'missing' && backup.problem.kind === 'missing') {
    // First boot. Not a fault: there is no evidence to preserve, so persistence
    // stays enabled and the first commit creates the file.
    return {
      outcome: { health: 'healthy', from: 'empty', records: [], quarantined: 0, topologyRevs: {} },
      idempotency: [],
      primaryIsKnownGood: false,
    }
  }

  // At least one file exists and neither can be read. Refuse everything and keep
  // both files exactly as they are — a human (or a later repair tool) can still
  // salvage them, and nothing this process does may make that harder.
  return {
    outcome: {
      health: 'faulted-read-only',
      from: 'none',
      records: [],
      quarantined: 0,
      topologyRevs: {},
      fault: { primary: primary.problem, backup: backup.problem },
    },
    idempotency: [],
    primaryIsKnownGood: false,
    log: {
      level: 'error',
      message:
        `[surfaces] canonical Surface store is FAULTED (read-only): ` +
        `primary ${primary.problem.kind} — ${primary.problem.detail}; ` +
        `backup ${backup.problem.kind} — ${backup.problem.detail}`,
    },
  }
}

/**
 * The durable half of the canonical Surface store.
 *
 * Holds the last DURABLY COMMITTED record set. That is a second copy of what
 * `SurfaceStore` holds live, and it is the point: a candidate is built from the
 * durable set without touching live state, so a failed write is a no-op rather
 * than a partial apply, and "install in memory" happens strictly after the bytes
 * are on disk.
 */
export class SurfaceSidecar {
  private readonly paths: SurfaceSidecarPaths
  private readonly hooks: SidecarHooks | undefined
  private readonly io: SidecarIo
  private readonly loadOutcome: SurfaceLoadOutcome

  private records = new Map<string, Surface>()
  private idempotency = new Map<string, IdempotencyEntry>()
  /** The persisted monotonic topology counters. Held here rather than derived from
   *  `records` because `drops` erase records — see `SidecarSnapshot.topologyRevs`. */
  private topologyRevs = new Map<string, number>()

  /** The serialized form of what is on disk, for the no-op short-circuit. */
  private lastSerialized: string | null = null

  /**
   * Whether the PRIMARY file currently holds a snapshot we know is good.
   *
   * False after a `recovered` load, and that is load-bearing rather than
   * bookkeeping: backup rotation copies the current primary into the backup slot,
   * so rotating on the first write after a recovery would copy the CORRUPT primary
   * over the only readable snapshot — turning a recovered boot into total loss.
   * When the primary is not known good, rotation is skipped: the existing backup
   * already IS the last known good, and the write about to happen replaces the
   * corrupt primary anyway.
   */
  private primaryIsKnownGood = false

  /** The serialized transaction queue (KTD5). One chain, so two concurrent commits
   *  run one after the other and the second builds its candidate on the first's
   *  committed base rather than on a stale snapshot. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(opts: SurfaceSidecarOptions) {
    const dir = opts.dir ?? getConfigRoot()
    const lockPath = opts.lockPath ?? join(dir, 'server.lock')
    this.paths = surfaceSidecarPaths(dir)
    this.hooks = opts.hooks
    this.io = opts.io ?? nodeSidecarIo

    // Assert single-writer BEFORE touching the sidecar. Not a second lock: the
    // backend singleton already guards exactly this invariant (one backend per
    // config root), and two locks over one invariant is a synchronization bug
    // waiting to happen. This only READS the marker — acquiring here would let a
    // boot that forgot to take the guard pass silently, which is the whole failure
    // this assertion exists to catch.
    const owner = backendSingletonOwner(lockPath)
    if (owner === null) {
      throw new Error(
        `refusing to open the Surface sidecar in ${dir}: the backend singleton at ${lockPath} is not held. ` +
        `Acquire it with acquireBackendSingleton() before opening any store.`,
      )
    }
    if (owner !== process.pid) {
      throw new Error(
        `another tinstar backend is already running on ${dir} (pid ${owner}). ` +
        `Stop it first, or run a second instance under a different TINSTAR_CONFIG_HOME.`,
      )
    }

    mkdirSync(dir, { recursive: true })
    this.loadOutcome = this.hydrate()
  }

  /**
   * Open the sidecar and hydrate it. SYNCHRONOUS on purpose: KTD5 requires the
   * load outcome to be in the caller's hands before session rehydration could
   * begin, and the simplest way to guarantee "before" is to leave no await point
   * where rehydration could be scheduled.
   *
   * Throws only for the singleton assertion — a failure to READ is a load outcome,
   * not an exception, because `faulted-read-only` is a state the server runs in
   * (degraded, evidence preserved) rather than a reason to refuse to boot.
   */
  static open(opts: SurfaceSidecarOptions = {}): SurfaceSidecar {
    return new SurfaceSidecar(opts)
  }

  get outcome(): SurfaceLoadOutcome {
    return this.loadOutcome
  }

  get health(): SurfaceStoreHealth {
    return this.loadOutcome.health
  }

  get fault(): SurfaceStoreFault | undefined {
    return this.loadOutcome.fault
  }

  /** The last durably committed record set. */
  durableRecords(): Surface[] {
    return [...this.records.values()]
  }

  /**
   * Run one transaction: validate a candidate, make it durable, install it, and
   * only then let the caller emit and acknowledge.
   *
   * The ordering guarantees, in the words of KTD7:
   *   · "Failure before durable commit changes nothing" — every rejection and
   *     every write error returns BEFORE the durable record set is replaced and
   *     before `onDurable` runs, so live state and clients never see it;
   *   · "a crash after commit is recovered from the snapshot" — the records are on
   *     disk (and fsynced) before `onDurable` is called, so a crash between the
   *     two reloads the new topology;
   *   · "a crash after SSE but before response is resolved by the persisted
   *     idempotency result" — the receipt is in the same snapshot write, so a
   *     retry with the same key returns it without re-applying.
   */
  commit(tx: SurfaceTransaction): Promise<SurfaceCommitResult> {
    // Settle-either-way on the tail: a transaction that rejects (an `onDurable`
    // that threw, say) must not poison the queue for every later commit.
    const run = this.queue.then(() => this.runCommit(tx), () => this.runCommit(tx))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  // --- Internals ---

  private hydrate(): SurfaceLoadOutcome {
    const h = hydrateSidecarFiles(this.paths)
    if (h.log) (h.log.level === 'warn' ? console.warn : console.error)(h.log.message)
    // Only a snapshot that actually supplied records is installed. An `empty` or
    // `faulted` load deliberately leaves `lastSerialized` null, so the no-op
    // short-circuit cannot mistake "we have never written" for "the file already
    // says this".
    if (h.outcome.from === 'primary' || h.outcome.from === 'backup') {
      this.install(h.outcome.records, h.idempotency, h.outcome.topologyRevs)
    }
    this.primaryIsKnownGood = h.primaryIsKnownGood
    return h.outcome
  }

  private install(
    records: Surface[],
    idempotency: IdempotencyEntry[],
    topologyRevs: Record<string, number>,
  ): void {
    this.records = new Map(records.map(r => [r.id, r]))
    this.idempotency = new Map(idempotency.map(e => [e.key, e]))
    this.topologyRevs = new Map(Object.entries(topologyRevs))
    // Recomputed from the record maps rather than kept as the bytes we read: a
    // quarantined record or a legacy key order would make the file's bytes differ
    // from what we would write for identical state, and the no-op short-circuit
    // must compare like with like.
    this.lastSerialized = serialize(this.snapshot())
  }

  private snapshot(): SidecarSnapshot {
    return {
      version: SURFACE_SIDECAR_SCHEMA_VERSION,
      records: [...this.records.values()],
      idempotency: [...this.idempotency.values()],
      topologyRevs: Object.fromEntries(this.topologyRevs),
    }
  }

  private async runCommit(tx: SurfaceTransaction): Promise<SurfaceCommitResult> {
    if (this.loadOutcome.health === 'faulted-read-only') {
      return { committed: false, reason: 'faulted-read-only' }
    }

    // Replay check first: a retry must not be revision-checked against a store
    // that has already moved past it. The whole point of the receipt is that the
    // caller lost the response, not the race.
    if (tx.idempotencyKey) {
      const prior = this.idempotency.get(tx.idempotencyKey)
      if (prior) {
        const records = prior.ids.map(id => this.records.get(id)).filter((r): r is Surface => !!r)
        return { committed: true, replayed: true, wrote: false, records, ...(prior.result !== undefined ? { result: prior.result } : {}) }
      }
    }

    // The caller's own re-validation, inside the queue and before anything is
    // touched. Nothing between here and the durable write can install a competing
    // transaction — they are all behind this same chain — so what it asserts is
    // still true when the bytes land. See `SurfaceTransaction.precommit`.
    const rechecked = tx.precommit?.()
    if (rechecked && !rechecked.ok) {
      return { committed: false, reason: 'precommit-refused', detail: rechecked.reason }
    }

    const puts = (rechecked?.ok ? rechecked.puts : undefined) ?? tx.puts ?? []
    const drops = tx.drops ?? []
    const revisions = { ...tx.topologyRevs, ...(rechecked?.ok ? rechecked.topologyRevs : undefined) }
    // The receipt describes what was ACTUALLY committed, so re-validation may
    // replace it too — otherwise a response would report the revision the caller
    // proposed rather than the one this transaction allocated.
    const result = (rechecked?.ok ? rechecked.result : undefined) ?? tx.result

    for (const r of puts) {
      if (!isUsableRecord(r)) {
        // Identified by id rather than by serializing the record: the thing that
        // failed the guard may also be the thing `JSON.stringify` chokes on, and
        // a diagnostic that throws is worse than no diagnostic.
        const id = r && typeof r === 'object' && 'id' in r ? String((r as { id: unknown }).id) : String(r)
        return { committed: false, reason: 'invalid-record', detail: `unusable record: ${id}` }
      }
    }

    if (tx.expectedRevs) {
      for (const [id, expected] of Object.entries(tx.expectedRevs)) {
        const prior = this.records.get(id)
        const actual = prior?.rev ?? 0
        if (actual !== expected) {
          return { committed: false, reason: 'stale-revision', detail: `${id}: expected rev ${expected}, durable rev ${actual}` }
        }
      }
    }

    const next = new Map(this.records)
    for (const id of drops) {
      if (!next.delete(id)) {
        return { committed: false, reason: 'unknown-record', detail: `drop names an unpersisted record: ${id}` }
      }
    }
    for (const r of puts) {
      const prior = next.get(r.id)
      // Mirrors `SurfaceStore.upsertSurface`: an equal-or-older revision is a
      // stale intent. Rejecting it keeps the newest intent authoritative
      // regardless of arrival order, which is what makes a retried write safe.
      if (prior && r.rev <= prior.rev) {
        return { committed: false, reason: 'stale-revision', detail: `${r.id}: rev ${r.rev} is not newer than durable rev ${prior.rev}` }
      }
      next.set(r.id, r)
    }

    const nextIdempotency = new Map(this.idempotency)
    if (tx.idempotencyKey) {
      nextIdempotency.set(tx.idempotencyKey, {
        key: tx.idempotencyKey,
        at: Date.now(),
        ids: puts.map(r => r.id),
        ...(result !== undefined ? { result } : {}),
      })
    }

    // Monotonic merge, never assignment: the counters outlive the records they were
    // allocated against (that is the point — a purge erases records), so a
    // transaction may only ever raise one.
    const nextTopologyRevs = new Map(this.topologyRevs)
    for (const [spaceId, rev] of Object.entries(revisions)) {
      if (typeof rev !== 'number' || !Number.isFinite(rev)) continue
      if (rev > (nextTopologyRevs.get(spaceId) ?? 0)) nextTopologyRevs.set(spaceId, rev)
    }

    const candidate: SidecarSnapshot = {
      version: SURFACE_SIDECAR_SCHEMA_VERSION,
      records: [...next.values()],
      idempotency: evict([...nextIdempotency.values()]),
      topologyRevs: Object.fromEntries(nextTopologyRevs),
    }

    let serialized: string
    try {
      serialized = serialize(candidate)
      // Reparse the exact bytes we are about to persist. Cheap, and it catches the
      // class of bug where a value serializes but does not survive the round trip
      // (a NaN revision becomes `null`, an undefined becomes a hole) — which would
      // otherwise surface as a quarantined record on the NEXT boot, long after the
      // commit that caused it was acknowledged as successful.
      const reparsed = readSnapshotFromString(serialized)
      if (!reparsed.ok || reparsed.records.length !== candidate.records.length) {
        return {
          committed: false,
          reason: 'invalid-record',
          detail: reparsed.ok
            ? `candidate lost ${candidate.records.length - reparsed.records.length} record(s) in serialization`
            : `candidate did not survive serialization: ${reparsed.problem.detail}`,
        }
      }
    } catch (e) {
      return { committed: false, reason: 'invalid-record', detail: (e as Error).message }
    }

    const written = puts.slice()

    // Nothing to make durable. Skipped only when the primary is known good — after
    // a recovery the on-disk primary is corrupt, so an "identical" candidate still
    // has to be written to repair it.
    if (this.primaryIsKnownGood && serialized === this.lastSerialized) {
      return { committed: true, replayed: false, wrote: false, records: written, ...(result !== undefined ? { result } : {}) }
    }

    try {
      await this.writeAtomically(serialized)
    } catch (e) {
      // Live state untouched: `this.records` is still the pre-transaction map, the
      // caller's `onDurable` never runs, and the primary on disk is whatever it
      // was — either the prior snapshot (rename never happened) or, if we died
      // after the rename, the new one, which is equally consistent.
      return { committed: false, reason: 'write-failed', detail: (e as Error).message }
    }

    this.records = next
    this.idempotency = new Map(candidate.idempotency.map(e => [e.key, e]))
    this.topologyRevs = nextTopologyRevs
    this.lastSerialized = serialized
    this.primaryIsKnownGood = true

    // Durable first, THEN install and emit (KTD7). Anything thrown from here on is
    // the caller's; the transaction has committed and a restart will reload it.
    tx.onDurable?.(written)

    return { committed: true, replayed: false, wrote: true, records: written, ...(result !== undefined ? { result } : {}) }
  }

  /**
   * The atomic write, in the exact order KTD5 specifies. Every step matters:
   *
   *   1. write the complete candidate to a temp file in the SAME directory (a
   *      cross-device rename is a copy, and a copy is not atomic);
   *   2. fsync the temp file — otherwise the rename can land while the contents
   *      are still in the page cache, and a crash leaves the primary NAME pointing
   *      at zero-length or half-written data;
   *   3. rotate the last-known-good primary into the backup slot, itself via a
   *      temp+rename so the backup is never the thing that is half-written;
   *   4. rename the temp over the primary — the atomic swap;
   *   5. fsync the containing directory, which is what makes the rename itself
   *      durable. Skipping it is the classic "I fsynced the file, why did the
   *      rename disappear" bug.
   */
  private async writeAtomically(serialized: string): Promise<void> {
    await this.step('write-temp')
    // The fd is held across the `fsync-temp` await deliberately: the hook has to
    // land BETWEEN the write and the fsync to simulate "bytes issued, never
    // flushed", and the transaction queue guarantees nobody else is writing.
    const fd = this.io.open(this.paths.temp, 'w')
    try {
      this.io.writeString(fd, serialized)
      await this.step('fsync-temp')
      this.io.fsync(fd)
    } finally {
      this.io.close(fd)
    }

    await this.step('rotate-backup')
    if (this.primaryIsKnownGood && this.io.exists(this.paths.primary)) {
      // The backup temp is fsynced too: a backup that is itself half-written is
      // worse than no rotation at all, because it looks recoverable.
      const good = this.io.readFile(this.paths.primary)
      const bfd = this.io.open(this.paths.backupTemp, 'w')
      try {
        this.io.writeBuffer(bfd, good)
        this.io.fsync(bfd)
      } finally {
        this.io.close(bfd)
      }
      this.io.rename(this.paths.backupTemp, this.paths.backup)
    }

    await this.step('rename-primary')
    this.io.rename(this.paths.temp, this.paths.primary)

    await this.step('fsync-dir')
    this.fsyncDir()
  }

  /** fsync the directory so the RENAME is durable, not just the file contents.
   *  Skipping this is the classic "I fsynced the file, why did the rename
   *  disappear" bug. Windows has no directory fsync and `open` on a directory
   *  fails there; NTFS journals the rename instead. Any other platform failing
   *  this is a real durability failure and fails the transaction. */
  private fsyncDir(): void {
    let fd: number | undefined
    try {
      fd = this.io.open(this.paths.dir, 'r')
      this.io.fsync(fd)
    } catch (e) {
      if (process.platform !== 'win32') throw e
    } finally {
      if (fd !== undefined) {
        try { this.io.close(fd) } catch { /* already gone */ }
      }
    }
  }

  private async step(step: SidecarWriteStep): Promise<void> {
    if (this.hooks?.beforeStep) await this.hooks.beforeStep(step)
  }
}

/** Stable, human-inspectable bytes. Two-space indent matches `docstore.json`, and
 *  "plain-text inspectable and hand-editable" is a ratified property of the JSON
 *  sidecar (KTD5), not an accident of formatting. */
function serialize(snapshot: SidecarSnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}

function readSnapshotFromString(raw: string): ReadResult {
  try {
    const parsed = JSON.parse(raw) as Partial<SidecarSnapshot>
    if (!Array.isArray(parsed.records)) {
      return { ok: false, problem: { path: '<candidate>', kind: 'malformed', detail: 'records is not an array' } }
    }
    const records = parsed.records.filter(isUsableRecord)
    return {
      ok: true, records, idempotency: [], topologyRevs: {},
      quarantined: parsed.records.length - records.length,
    }
  } catch (e) {
    return { ok: false, problem: { path: '<candidate>', kind: 'unparsable', detail: (e as Error).message } }
  }
}

/** Keep the newest receipts. Oldest-first eviction, because a receipt matters only
 *  for the seconds between a lost response and its retry. */
function evict(entries: IdempotencyEntry[]): IdempotencyEntry[] {
  if (entries.length <= MAX_IDEMPOTENCY_ENTRIES) return entries
  return [...entries].sort((a, b) => a.at - b.at).slice(entries.length - MAX_IDEMPOTENCY_ENTRIES)
}

