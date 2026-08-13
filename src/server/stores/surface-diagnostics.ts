// Human-readable diagnostics for the legacy Slate → canonical Surface migration
// (plan U1f).
//
// U1 ships INVISIBLY by design: it introduces canonical Surface identity and
// persistence without changing anything the user can see. That is a good property
// and an awkward one — the plan's Verification Contract asks an operator to run a
// "migration rehearsal" and inspect the diagnostics, and until this module existed
// there were no diagnostics to inspect. `SurfaceMigrationReport` is deliberately
// data-only with no formatting in it; this is the other half of that split.
//
// Three rules shape everything below.
//
// 1. READ-ONLY, ABSOLUTELY. This module opens no store, takes no lock, creates no
//    directory, and writes no byte. That is what makes it safe to point at a COPY
//    of a real `docstore.json`, and safe to run while the server is up. It reads
//    the sidecar through `inspectSurfaceSidecar` rather than `SurfaceSidecar.open`
//    for exactly this reason — `open` asserts the backend singleton and would
//    `mkdir` the config root out from under an inspection.
//
// 2. THE EXCEPTIONS ARE THE PRODUCT. A migration where 400 surfaces land cleanly
//    should print a headline and stop. What a human needs is the data that did NOT
//    migrate: quarantined entries with their reasons, per-point fields the
//    canonical model cannot yet carry, records whose legacy point is gone. Those
//    are never truncated away behind a count.
//
// 3. NO FORMATTING DECISIONS IN THE MIGRATION, NO NUMBERS INVENTED HERE. Every
//    figure printed comes from `SurfaceMigrationReport` or from the sidecar's own
//    load outcome. This module chooses wording and layout and nothing else, so the
//    dump cannot drift from what the server would actually do.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Point } from '../../domain/types'
import { getConfigRoot } from '../configRoot'
import {
  inspectSurfaceSidecar,
  type SurfaceSidecarInspection,
  type SurfaceSnapshotProblem,
} from './surface-persistence'
import {
  migrateLegacySlate,
  type LegacyRunSnapshot,
  type SurfaceMigrationOutcome,
  type SurfaceMigrationQuarantine,
} from './surface-migration'

// --- Reading the legacy side ---

/** A legacy point identified the way a human would grep for it. */
export interface LegacyPointRef {
  runId: string
  localId: string
}

export type LegacyDocstoreScan =
  | {
      ok: true
      path: string
      /** Migration input, one entry per run record found in the docstore. */
      runs: LegacyRunSnapshot[]
      /** Total `slatePoints` entries in the file, including unanchored ones. */
      pointCount: number
      /**
       * Points whose `runId` names no run in the docstore. They are NOT handed to
       * the migration at all: with no run record there is no `createdAt`, and
       * therefore no incarnation to derive an identity from. Reported here so the
       * loss is visible rather than silently absent from every count.
       */
      unanchored: LegacyPointRef[]
    }
  | { ok: false; path: string; problem: string }

/** Read a `docstore.json` and shape its runs and Slate points into migration
 *  input. Opens the file read-only and parses it; nothing else. */
export function readLegacyDocstore(path: string): LegacyDocstoreScan {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    return { ok: false, path, problem: `could not be read — ${(e as NodeJS.ErrnoException).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, path, problem: `is not valid JSON — ${(e as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, path, problem: 'does not hold a JSON object at its root' }
  }

  const data = parsed as { runs?: unknown; slatePoints?: unknown }
  const runRecords = Array.isArray(data.runs) ? data.runs : []
  const pointRecords = Array.isArray(data.slatePoints) ? data.slatePoints : []

  const byRun = new Map<string, Point[]>()
  for (const p of pointRecords as Point[]) {
    if (!p || typeof p !== 'object') continue
    const runId = typeof p.runId === 'string' ? p.runId : ''
    const bucket = byRun.get(runId)
    if (bucket) bucket.push(p)
    else byRun.set(runId, [p])
  }

  const runs: LegacyRunSnapshot[] = []
  const claimed = new Set<string>()
  for (const r of runRecords as { id?: unknown; createdAt?: unknown; spaceId?: unknown }[]) {
    if (!r || typeof r !== 'object') continue
    // A run record with no usable id is passed through rather than dropped: the
    // migration has a `missing-run-id` quarantine for exactly this, and its
    // sentence says it better than a second opinion here would.
    const runId = typeof r.id === 'string' ? r.id : ''
    if (runId) claimed.add(runId)
    runs.push({
      runId,
      ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
      ...(typeof r.spaceId === 'string' ? { spaceId: r.spaceId } : {}),
      points: byRun.get(runId) ?? [],
    })
  }

  const unanchored: LegacyPointRef[] = []
  for (const [runId, points] of byRun) {
    if (claimed.has(runId)) continue
    for (const p of points) {
      unanchored.push({ runId, localId: typeof p.id === 'string' ? p.id : '' })
    }
  }
  unanchored.sort((a, b) => (a.runId + a.localId < b.runId + b.localId ? -1 : 1))

  return { ok: true, path, runs, pointCount: pointRecords.length, unanchored }
}

// --- Collecting ---

export interface MigrationDiagnostics {
  /** Epoch ms the inspection ran. */
  at: number
  sidecar: SurfaceSidecarInspection
  legacy: LegacyDocstoreScan
  /** Absent exactly when `legacy.ok` is false — with no legacy input there is no
   *  migration to rehearse. */
  migration?: SurfaceMigrationOutcome
}

export interface CollectOptions {
  /** Defaults to `<config root>/docstore.json`. */
  docstorePath?: string
  /** Directory holding `surfaces.json`. Defaults to the config root. */
  sidecarDir?: string
  /** Injectable clock, so a test's output is byte-stable. */
  now?: number
}

/**
 * Rehearse the migration and gather everything the dump needs.
 *
 * The rehearsal is the real `migrateLegacySlate` against the real canonical
 * records, so the counts are the counts a boot would produce — the only thing
 * thrown away is the `puts` array, which is never written anywhere.
 */
export function collectMigrationDiagnostics(opts: CollectOptions = {}): MigrationDiagnostics {
  const root = getConfigRoot()
  const at = opts.now ?? Date.now()
  const sidecar = inspectSurfaceSidecar(opts.sidecarDir ?? root)
  const legacy = readLegacyDocstore(opts.docstorePath ?? join(root, 'docstore.json'))
  if (!legacy.ok) return { at, sidecar, legacy }
  const migration = migrateLegacySlate({
    runs: legacy.runs,
    existing: sidecar.outcome.records,
    now: at,
  })
  return { at, sidecar, legacy, migration }
}

// --- Rendering ---

export interface RenderOptions {
  /** Bare ANSI when true. Callers pass `process.stdout.isTTY && !NO_COLOR`. */
  color?: boolean
  /** List every run, not just the exceptional ones plus a sample. */
  allRuns?: boolean
  /** Wrap column for prose. */
  width?: number
}

/** How many clean runs are listed before the rest are summarised as a count.
 *  Sized so that a wholly clean migration — however many surfaces it moved —
 *  still fits in a 40-line terminal without scrolling. Exceptional runs are
 *  ALWAYS listed, however many there are. */
const CLEAN_RUNS_SHOWN = 6

/** Per-group cap for the non-refusal sections (gaps, orphans, retirements).
 *  Quarantines are never capped — they are the thing the reader came for. */
const SAMPLE_LIMIT = 12

/** What each legacy `Point` field the canonical model cannot yet hold actually
 *  does, in plain words. Without this the gap section is three field names and a
 *  shrug. */
const GAP_FIELD_MEANING: Record<string, string> = {
  anchor: 'where the point pins onto a diagram (the legacy `diagram` surface kind)',
  group: 'which workbench column the point sits in (the S4 side-by-side question layout)',
  stalledAt: 'the marker the server sets when a point’s authoring process died mid-write',
}

function paint(on: boolean) {
  const c = (code: string) => (t: string) => (on ? `\u001b[${code}m${t}\u001b[0m` : t)
  return { bold: c('1'), dim: c('2'), red: c('31'), green: c('32'), yellow: c('33') }
}

/** Greedy wrap with a fixed indent on every line. Long unbreakable tokens (ids,
 *  paths) are allowed to overflow rather than being chopped — a truncated id is
 *  useless, an overflowing one is still greppable. */
function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(indent + line)
  return lines
}

function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Quarantine reasons that refuse a WHOLE RUN rather than one point. Named so the
 *  entry line can say "whole run" only when that is actually true — a
 *  `malformed-point` also arrives without a local id, and captioning it "whole
 *  run" would tell the reader their entire run was refused when one entry was. */
const RUN_LEVEL_REASONS: ReadonlySet<string> = new Set([
  'missing-run-id', 'missing-run-created-at', 'unparsable-run-created-at', 'run-root-unavailable',
])

/** `run / point` the way a human greps for it. */
function where(runId: string, localId?: string, scope?: string): string {
  const run = runId || '(run with no id)'
  if (localId) return `${run} / ${localId}`
  return scope ? `${run}  ${scope}` : run
}

function problemLine(p: SurfaceSnapshotProblem): string {
  return `${p.path} — ${p.kind}: ${p.detail}`
}

/**
 * The dump. Returns a string rather than printing so it is assertable in a test
 * and pipeable by a caller.
 */
export function renderMigrationDiagnostics(d: MigrationDiagnostics, opts: RenderOptions = {}): string {
  const s = paint(opts.color ?? false)
  const width = opts.width ?? 92
  const out: string[] = []
  const push = (line = '') => { out.push(line) }
  const para = (text: string, indent = '  ') => { for (const l of wrap(text, width, indent)) push(l) }
  const section = (title: string) => { push(); push(s.bold(title)) }

  // --- Header ---
  push()
  push(`${s.bold('Surface migration diagnostics')} ${s.dim('· read-only rehearsal, nothing was written')}`)
  push(`  ${s.dim('legacy')}   ${d.legacy.path}`)
  push(`  ${s.dim('sidecar')}  ${d.sidecar.paths.primary}`)
  push(`  ${s.dim('ran')}      ${new Date(d.at).toISOString()}`)

  // --- Load outcome (first, always) ---
  const outcome = d.sidecar.outcome
  section('CANONICAL STORE LOAD')
  if (outcome.health === 'healthy' && outcome.from === 'empty') {
    push(`  ${s.green('✓')} healthy — no sidecar file on disk yet.`)
    para('There is no canonical snapshot to load, so everything below is what a FIRST migration would create.', '    ')
  } else if (outcome.health === 'healthy') {
    push(`  ${s.green('✓')} healthy — ${pluralize(outcome.records.length, 'canonical record')} loaded from the primary snapshot.`)
  } else if (outcome.health === 'recovered') {
    push(`  ${s.yellow('⚠')} recovered — the primary snapshot was unusable; ${pluralize(outcome.records.length, 'record')} came from the backup.`)
    para('What this means for you: the primary file is damaged and the backup is one write behind it, so anything committed after the last backup rotation is gone. The server repairs the primary on its next successful write. Read the counts below with that in mind — a record the damaged primary still holds will show up here as one that needs creating.', '    ')
    if (d.sidecar.log) para(d.sidecar.log.message.replace(/^\[surfaces\] /, 'detail: '), '    ')
  } else {
    push(`  ${s.red('✗')} ${s.bold('FAULTED (read-only)')} — neither snapshot could be read.`)
    para('What this means for you: the canonical store refuses every write for the life of the process, and both files are being preserved untouched as evidence. Nothing will migrate until a human repairs or removes them. The rehearsal below ran against an EMPTY canonical set, so its "created" numbers describe a repaired store, not today’s.', '    ')
    if (outcome.fault) {
      push(`    ${s.dim('primary')}  ${problemLine(outcome.fault.primary)}`)
      push(`    ${s.dim('backup')}   ${problemLine(outcome.fault.backup)}`)
    }
  }
  if (outcome.quarantined > 0) {
    push(`  ${s.yellow('⚠')} ${pluralize(outcome.quarantined, 'record')} in that snapshot failed the shape guard and were dropped on load.`)
    para('A dropped record has no id, no space, no home, or no revision — it cannot be addressed or indexed, so it is not in any count below.', '    ')
  }

  // --- Legacy read failure short-circuits everything else ---
  if (!d.legacy.ok || !d.migration) {
    section('LEGACY SLATE')
    push(`  ${s.red('✗')} ${d.legacy.path}`)
    para(d.legacy.ok ? 'no migration was run' : d.legacy.problem, '    ')
    para('Nothing could be rehearsed. Point --docstore at a readable docstore.json (a copy is fine).', '    ')
    push()
    return out.join('\n') + '\n'
  }

  const { report } = d.migration
  const exceptions =
    report.quarantined.length + report.preservationGaps.length +
    report.orphaned.length + report.retired.length + d.legacy.unanchored.length

  // --- Totals ---
  section('MIGRATION TOTALS')
  push(`  ${s.dim('runs      ')} ${report.runsSeen} seen · ${report.runsMigrated} migrated · ${report.runsQuarantined} left behind`)
  push(`  ${s.dim('surfaces  ')} ${report.surfacesCreated} created · ${report.surfacesUpdated} updated · ${report.surfacesUnchanged} unchanged`)
  const exceptionLine =
    `${report.quarantined.length} quarantined · ${report.preservationGaps.length} preservation gaps · ` +
    `${report.orphaned.length} orphaned · ${report.retired.length} retired`
  push(`  ${s.dim('exceptions')} ${exceptions === 0 ? exceptionLine : s.yellow(exceptionLine)}`)
  push(
    outcome.health === 'faulted-read-only'
      ? `  ${s.dim('writes    ')} ${s.red('none — the store is faulted and refuses every write')} ${s.dim(`(${pluralize(d.migration.puts.length, 'record')} once it is repaired)`)}`
      : `  ${s.dim('writes    ')} ${pluralize(d.migration.puts.length, 'record')} would be written to the sidecar`,
  )
  if (report.runsMigrated > 0) {
    para(
      `Surface counts include one hidden "compatibility root" per migrated run — scaffolding that holds a run's points together, never rendered as a card. ${report.runsMigrated} of the surfaces above ${report.runsMigrated === 1 ? 'is a root' : 'are roots'}; the rest are real points.`,
      '    ',
    )
  }
  if (report.runsQuarantined > 0) {
    para(`"Left behind" means the run has no usable canonical root, so NONE of its points were migrated this pass. Its legacy Slate is untouched and still renders — see QUARANTINED below for why.`, '    ')
  }

  // --- Quarantined: never truncated, never re-worded ---
  if (report.quarantined.length > 0) {
    section(`QUARANTINED · ${s.red(`${pluralize(report.quarantined.length, 'legacy entry', 'legacy entries')} did NOT migrate`)}`)
    para('Each one below still exists in the legacy Slate and still renders in the Run Workspace. Only the canonical copy was refused, and it was refused rather than guessed at.')
    const byReason = new Map<string, SurfaceMigrationQuarantine[]>()
    for (const q of report.quarantined) {
      const bucket = byReason.get(q.reason)
      if (bucket) bucket.push(q)
      else byReason.set(q.reason, [q])
    }
    for (const [reason, entries] of byReason) {
      push()
      push(`  ${s.bold(reason)} ${s.dim(`(${entries.length})`)}`)
      const scope = RUN_LEVEL_REASONS.has(reason) ? '(the whole run)' : '(an entry with no id)'
      for (const q of entries) {
        push(`    ${where(q.runId, q.localId, scope)}${q.surfaceId ? s.dim(`  →  ${q.surfaceId}`) : ''}`)
        for (const l of wrap(q.detail, width, '      ')) push(s.dim(l))
      }
    }
  }

  // --- Preservation gaps ---
  if (report.preservationGaps.length > 0) {
    const fields = [...new Set(report.preservationGaps.flatMap(g => g.fields))].sort()
    section(`PRESERVATION GAPS · ${s.yellow(`${pluralize(report.preservationGaps.length, 'surface')} migrated with a field left behind`)}`)
    para('These Surfaces WERE created. But the canonical record has nowhere to put the legacy fields listed below, so that one aspect did not carry across. The legacy point still holds them, and re-running migration will not recover them — a later unit has to model the field first.')
    push()
    for (const f of fields) {
      push(`    ${s.bold(f)} ${s.dim('—')} ${GAP_FIELD_MEANING[f] ?? s.dim('no description on file for this field')}`)
    }
    const byFields = new Map<string, typeof report.preservationGaps>()
    for (const g of report.preservationGaps) {
      const key = [...g.fields].sort().join(', ')
      const bucket = byFields.get(key)
      if (bucket) bucket.push(g)
      else byFields.set(key, [g])
    }
    for (const [key, entries] of byFields) {
      push()
      push(`  ${s.bold(key)} ${s.dim(`(${entries.length})`)}`)
      for (const g of entries.slice(0, opts.allRuns ? entries.length : SAMPLE_LIMIT)) {
        push(`    ${where(g.runId, g.localId)}${s.dim(`  →  ${g.surfaceId}`)}`)
      }
      if (!opts.allRuns && entries.length > SAMPLE_LIMIT) {
        push(s.dim(`    … ${entries.length - SAMPLE_LIMIT} more with the same fields (--all to list them)`))
      }
    }
  }

  // --- Orphans ---
  if (report.orphaned.length > 0) {
    section(`ORPHANED · ${pluralize(report.orphaned.length, 'canonical Surface')} whose legacy point is gone`)
    para('The legacy point was deleted, but the canonical record is still alive and still claims that run’s compatibility slot. Nothing was removed: under the plan a delete is a MOVE into the per-space recovery store, which a later unit performs. Expect these to persist across passes until then.')
    push()
    for (const o of report.orphaned.slice(0, opts.allRuns ? report.orphaned.length : SAMPLE_LIMIT)) {
      push(`    ${where(o.runId, o.localId)}${s.dim(`  →  ${o.surfaceId}`)}`)
    }
    if (!opts.allRuns && report.orphaned.length > SAMPLE_LIMIT) {
      push(s.dim(`    … ${report.orphaned.length - SAMPLE_LIMIT} more (--all to list them)`))
    }
  }

  // --- Retirements ---
  if (report.retired.length > 0) {
    section(`RETIRED · ${pluralize(report.retired.length, 'Surface')} handed over from a previous incarnation`)
    para('A run name was deleted and recreated. These Surfaces belong to the run that died, so their run alias moved to the workspace-recovery bucket and the reborn run can claim its own. Identity, thread, home, and revision history are untouched — the old discussion is still reachable.')
    push()
    for (const r of report.retired.slice(0, opts.allRuns ? report.retired.length : SAMPLE_LIMIT)) {
      push(`    ${where(r.runId, r.localId)}${s.dim(`  →  ${r.surfaceId}`)}`)
    }
    if (!opts.allRuns && report.retired.length > SAMPLE_LIMIT) {
      push(s.dim(`    … ${report.retired.length - SAMPLE_LIMIT} more (--all to list them)`))
    }
  }

  // --- Legacy points with no run ---
  if (d.legacy.unanchored.length > 0) {
    section(`POINTS WITH NO RUN · ${s.yellow(`${pluralize(d.legacy.unanchored.length, 'legacy point')} never reached the migration`)}`)
    para('Their `runId` names a run that is not in this docstore, so there is no creation stamp to derive an identity from and nothing was offered to the migration at all. They are in none of the counts above.')
    push()
    for (const p of d.legacy.unanchored.slice(0, opts.allRuns ? d.legacy.unanchored.length : SAMPLE_LIMIT)) {
      push(`    ${where(p.runId, p.localId)}`)
    }
    if (!opts.allRuns && d.legacy.unanchored.length > SAMPLE_LIMIT) {
      push(s.dim(`    … ${d.legacy.unanchored.length - SAMPLE_LIMIT} more (--all to list them)`))
    }
  }

  // --- Per-run detail ---
  const interesting = report.runs.filter(r => r.quarantined > 0 || r.retired > 0 || r.rootSurfaceId == null)
  const clean = report.runs.filter(r => !interesting.includes(r))
  const shownClean = opts.allRuns ? clean : clean.slice(0, CLEAN_RUNS_SHOWN)
  const hiddenClean = clean.length - shownClean.length
  section(`RUNS · ${report.runsSeen} seen`)
  if (report.runs.length === 0) {
    push(s.dim('  no runs in this docstore'))
  }
  for (const r of [...interesting, ...shownClean]) {
    const mark = r.rootSurfaceId == null ? s.red('✗') : r.quarantined > 0 ? s.yellow('⚠') : s.green('✓')
    push(`  ${mark} ${s.bold(r.runId || '(run with no id)')}  ${s.dim(
      `created ${r.created} · updated ${r.updated} · unchanged ${r.unchanged} · quarantined ${r.quarantined} · retired ${r.retired}`,
    )}`)
    push(s.dim(`      incarnation ${r.incarnation ?? '—'}   root ${r.rootSurfaceId ?? 'none (nothing migrated)'}   space ${r.spaceId || '—'}`))
  }
  if (hiddenClean > 0) {
    push(s.dim(`  … ${hiddenClean} more run(s) with nothing to report (--all to list them)`))
  }

  // --- Bottom line, repeated because a long dump scrolls the headline away ---
  push()
  if (outcome.health === 'faulted-read-only') {
    push(`${s.red('✗')} ${s.bold('Bottom line:')} the canonical store is faulted — nothing can migrate until its files are repaired.`)
  } else if (report.quarantined.length > 0 || d.legacy.unanchored.length > 0) {
    const missed = report.quarantined.length + d.legacy.unanchored.length
    push(`${s.red('✗')} ${s.bold('Bottom line:')} ${pluralize(missed, 'legacy entry', 'legacy entries')} did not migrate. Legacy data is intact; see the sections above.`)
  } else if (report.preservationGaps.length > 0) {
    push(`${s.yellow('⚠')} ${s.bold('Bottom line:')} everything migrated, but ${pluralize(report.preservationGaps.length, 'surface')} lost a field the canonical model cannot hold yet.`)
  } else {
    push(`${s.green('✓')} ${s.bold('Bottom line:')} clean — every legacy point has a canonical counterpart, and nothing was left behind.`)
  }
  push()
  return out.join('\n')
}

// --- Machine-readable form ---

/** The same facts as a plain object, for `--json`. The human form is the point of
 *  this module; this exists so a rehearsal script can assert on the numbers
 *  without parsing prose. */
export function migrationDiagnosticsJson(d: MigrationDiagnostics): unknown {
  return {
    at: d.at,
    readOnly: true,
    sidecar: {
      primary: d.sidecar.paths.primary,
      backup: d.sidecar.paths.backup,
      health: d.sidecar.outcome.health,
      from: d.sidecar.outcome.from,
      records: d.sidecar.outcome.records.length,
      recordsDroppedOnLoad: d.sidecar.outcome.quarantined,
      ...(d.sidecar.outcome.fault ? { fault: d.sidecar.outcome.fault } : {}),
    },
    legacy: d.legacy.ok
      ? {
          path: d.legacy.path,
          runs: d.legacy.runs.length,
          points: d.legacy.pointCount,
          unanchored: d.legacy.unanchored,
        }
      : { path: d.legacy.path, error: d.legacy.problem },
    ...(d.migration
      ? { migration: { wouldWrite: d.migration.puts.length, report: d.migration.report } }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Refresh diagnostics (plan U7, R1-R19).
//
// WHAT AN OPERATOR NEEDS TO SEE, and it is not "is refresh working". It is whether
// the thing this architecture was built to prevent has come back. The retired design
// failed quietly and expensively: 110 of 121 completed refreshes changed nothing and
// one session accumulated 43 tmux panes, and nothing on any screen said so. So these
// counts are chosen to make the failure mode legible BEFORE somebody notices their
// machine is busy — how many Surfaces are dirty and waiting, how much machine work is
// actually running, how often a provider budget deferred something, and how many
// checks came back unable to answer.
//
// THE INVARIANT IS THE POINT. `refreshCreatedSessions` has an expected value of zero
// and any other value is CORRUPTION, not a metric to watch trend upward. A refresh
// may not create a managed session; a record saying one did means either a job
// written by the removed architecture survived reconciliation, or something
// reintroduced the capability.
// ---------------------------------------------------------------------------

/** What one look at the refresh engine's state found. */
export interface RefreshDiagnostics {
  at: number
  /** Surfaces the host believes may no longer reflect their sources. */
  dirty: number
  /** Dirty Surfaces whose recipe the HOST can run by itself — the ones that will
   *  come back on their own. The remainder are waiting for a person. */
  dirtyHostMaintained: number
  /** Dirty Surfaces waiting for a human to reach them. A number that only grows is
   *  not a bug: it is a Slate nobody has visited. */
  dirtyAwaitingHuman: number
  /** Attempts in flight, by executor. */
  activeHostAttempts: number
  activeOwnerAttempts: number
  /** Surfaces whose LAST COMPLETED CHECK ended each way. `unavailable` growing while
   *  `failed` does not usually means agents are exiting, not that anything broke. */
  checks: Record<'succeeded' | 'failed' | 'unavailable' | 'superseded' | 'never', number>
  /** Jobs the boot reconciled out of the removed background-worker architecture.
   *  Terminal history, not live fleet — see {@link LEGACY_WORKER_RECONCILED}. */
  legacyReconciled: number
  /**
   * Managed sessions any refresh record claims to have created.
   *
   * EXPECTED ZERO, ALWAYS. Not a gauge to watch: a refresh cannot create a session,
   * so a nonzero value is a corrupt record or a reintroduced capability, and it is
   * reported as corruption rather than as load.
   */
  refreshCreatedSessions: number
  /** Every corruption this pass found, in words. Empty is the healthy answer. */
  corruption: string[]
}

/** The job fields this reads. Declared structurally so the diagnostics module does
 *  not import the job store — it inspects records, including ones written by a build
 *  that no longer exists. */
export interface RefreshJobLike {
  id: string
  surfaceId: string
  state: string
  execution?: string
  intentAt?: number
  dispatch?: { kind?: string; target?: string } | undefined
  result?: { ok: boolean; message?: string } | undefined
}

/** The Surface fields this reads. */
export interface RefreshSurfaceLike {
  id: string
  /** Truthy when the Surface is in the recovery store. Typed loosely because the
   *  canonical record carries a deletion RECORD here rather than a flag, and this
   *  module only asks whether there is one. */
  readonly deleted?: unknown
  content: { readonly recipe?: { readonly kind: string } | undefined }
  freshness: {
    readonly phase: string
    readonly lastCheck?: { readonly outcome: string } | null | undefined
  }
}

/** The dispatch value the removed architecture wrote. Recognised so a survivor is
 *  reported as corruption instead of counted as ordinary history. */
const RETIRED_BACKGROUND_DISPATCH = 'worker'

export function collectRefreshDiagnostics(input: {
  surfaces: readonly RefreshSurfaceLike[]
  jobs: readonly RefreshJobLike[]
  now?: number
}): RefreshDiagnostics {
  const at = input.now ?? Date.now()
  const checks: RefreshDiagnostics['checks'] = {
    succeeded: 0, failed: 0, unavailable: 0, superseded: 0, never: 0,
  }
  let dirty = 0
  let dirtyHostMaintained = 0
  let dirtyAwaitingHuman = 0

  for (const s of input.surfaces) {
    if (s.deleted) continue
    const outcome = s.freshness.lastCheck?.outcome
    if (outcome === 'succeeded' || outcome === 'failed'
      || outcome === 'unavailable' || outcome === 'superseded') checks[outcome]++
    else checks.never++
    if (s.freshness.phase === 'current') continue
    dirty++
    if (s.content.recipe?.kind === 'host') dirtyHostMaintained++
    // A Surface with no runnable recipe is not "awaiting a human" in the sense that
    // matters — nobody's visit will rebuild it either — so it is counted in `dirty`
    // and nowhere else. Rolling it in here would make the number that measures unseen
    // work grow for a reason no human action can shrink.
    else if (s.content.recipe?.kind === 'agent') dirtyAwaitingHuman++
  }

  let activeHostAttempts = 0
  let activeOwnerAttempts = 0
  let legacyReconciled = 0
  let refreshCreatedSessions = 0
  const corruption: string[] = []

  for (const job of input.jobs) {
    const active = job.state === 'queued' || job.state === 'running'
    if (active) {
      if (job.execution === 'host') activeHostAttempts++
      else activeOwnerAttempts++
    }
    if (job.result?.message?.includes('background-worker architecture')) legacyReconciled++

    // THE INVARIANT. A dispatch naming a background session means a refresh created
    // one, which this architecture makes impossible — so seeing it is evidence about
    // the BUILD, not about load.
    if (job.dispatch?.kind === RETIRED_BACKGROUND_DISPATCH) {
      refreshCreatedSessions++
      if (active) {
        corruption.push(
          `job ${job.id} is still ${job.state} and names a background session `
          + `(${job.dispatch.target ?? 'unnamed'}); refresh cannot create one, so this record `
          + 'survived reconciliation or the capability was reintroduced',
        )
      }
    }
    // An owner attempt with no human stamp had nobody's permission. Terminal ones are
    // history from a build that predates the stamp; an ACTIVE one is happening now.
    if (active && job.execution === 'owner' && job.intentAt === undefined) {
      corruption.push(
        `job ${job.id} is ${job.state} against surface ${job.surfaceId} with no record of a human `
        + 'asking for it; agent work requires a discrete human action',
      )
    }
  }

  return {
    at, dirty, dirtyHostMaintained, dirtyAwaitingHuman,
    activeHostAttempts, activeOwnerAttempts,
    checks, legacyReconciled, refreshCreatedSessions, corruption,
  }
}

/** The human-readable dump. Corruption first, because it is the only part that means
 *  somebody has to do something. */
export function renderRefreshDiagnostics(d: RefreshDiagnostics): string {
  const out: string[] = []
  out.push('Refresh engine')
  out.push(`  ran            ${new Date(d.at).toISOString()}`)
  if (d.corruption.length === 0) {
    out.push('  ✓ no refresh-created sessions, and every active agent attempt was asked for by a human')
  } else {
    out.push(`  ✗ CORRUPTION — ${d.corruption.length} finding(s):`)
    for (const line of d.corruption) out.push(`      ${line}`)
  }
  out.push('')
  out.push(`  dirty                ${d.dirty}`)
  out.push(`    host-maintained    ${d.dirtyHostMaintained}   (these come back on their own)`)
  out.push(`    awaiting a human   ${d.dirtyAwaitingHuman}   (these refresh when somebody explicitly requests it)`)
  out.push(`  active host checks   ${d.activeHostAttempts}`)
  out.push(`  active agent work    ${d.activeOwnerAttempts}`)
  out.push('')
  out.push('  last completed check, by outcome')
  out.push(`    succeeded    ${d.checks.succeeded}`)
  out.push(`    failed       ${d.checks.failed}`)
  out.push(`    unavailable  ${d.checks.unavailable}   (nothing could look — often an agent that exited)`)
  out.push(`    superseded   ${d.checks.superseded}   (it looked, and the world had already moved)`)
  out.push(`    never        ${d.checks.never}`)
  if (d.legacyReconciled > 0) {
    out.push('')
    out.push(`  ${d.legacyReconciled} job(s) reconciled out of the removed background-worker architecture.`)
    out.push('  Terminal history, not a live fleet — their Surfaces kept their content and went dirty.')
  }
  return out.join('\n')
}
