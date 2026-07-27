// @vitest-environment node
//
// The migration diagnostics dump (U1f). The output IS the deliverable here, so
// these tests assert on what a human would see, not only on the numbers behind it.
//
// The scenarios this file owns:
//   · a clean migration renders SHORT — 400 clean surfaces do not produce 400 lines;
//   · a quarantined entry is always shown, with its `detail` sentence verbatim,
//     however much clean data surrounds it;
//   · preservation gaps (per-point fields the canonical model cannot carry) are
//     named, explained, and never summarised away;
//   · a faulted load is reported prominently, above the totals, and says plainly
//     what it means for the operator;
//   · THE COMMAND MUTATES NOTHING. Every input file is byte-identical afterwards
//     and no file is created — the property that makes it safe to point at a copy
//     of real data, or to run while the server is up.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectMigrationDiagnostics,
  migrationDiagnosticsJson,
  readLegacyDocstore,
  renderMigrationDiagnostics,
} from '../surface-diagnostics'
import { parseDiagnosticsArgs, runDiagnosticsCli } from '../surface-diagnostics-cli'
import { SURFACE_SIDECAR_SCHEMA_VERSION } from '../surface-persistence'
import { deriveLegacySurfaceId, deriveRunIncarnation } from '../surfaces'
import { LEGACY_RUN_ROOT_LOCAL_ID, deriveLegacyRunRootId } from '../surface-migration'
import type { Point, Surface } from '../../../domain/types'

const SPACE = 'space-main'
const NOW = 1_800_000_000_000

interface Ctx {
  dir: string
  docstore: string
  /** Write a docstore.json from runs + points. */
  write: (runs: unknown[], points: Point[]) => void
  writeSidecar: (raw: string) => void
  writeBackup: (raw: string) => void
  run: (allRuns?: boolean) => string
}

function withDir(body: (ctx: Ctx) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'surface-diagnostics-'))
  const docstore = join(dir, 'docstore.json')
  try {
    body({
      dir,
      docstore,
      write: (runs, points) => writeFileSync(docstore, JSON.stringify({ runs, slatePoints: points }, null, 2)),
      writeSidecar: raw => writeFileSync(join(dir, 'surfaces.json'), raw),
      writeBackup: raw => writeFileSync(join(dir, 'surfaces.backup.json'), raw),
      run: allRuns =>
        renderMigrationDiagnostics(
          collectMigrationDiagnostics({ docstorePath: docstore, sidecarDir: dir, now: NOW }),
          { color: false, ...(allRuns ? { allRuns } : {}) },
        ),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(id: string, over: Record<string, unknown> = {}) {
  return { id, sessionId: `sess-${id}`, createdAt: '2026-07-20T09:00:00.000Z', spaceId: SPACE, ...over }
}

function point(runId: string, id: string, over: Partial<Point> = {}): Point {
  return {
    runId, id, author: 'agent', source: 'file',
    headline: `Should we ${id}?`,
    status: 'open', createdAt: 1_770_000_000_000, amendedAt: 1_770_000_000_100,
    ...over,
  }
}

/** Collapse wrapping so a test can assert a sentence the renderer may have broken
 *  across lines. The sentence still has to be present WORD FOR WORD. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function lineCount(text: string): number {
  return text.split('\n').length
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A canonical record shaped enough to survive the sidecar's shape guard. */
function record(id: string, runId: string, localId: string, over: Partial<Surface> = {}): Surface {
  return {
    id,
    spaceId: SPACE,
    home: { kind: 'canvas', spaceId: SPACE },
    content: { headline: localId },
    contentAuthority: 'canonical-direct',
    provenance: { runId },
    author: 'agent',
    thread: { replies: [], status: 'open' },
    freshness: { phase: 'current', overdue: false },
    aliases: [{ bucket: { kind: 'run', runId }, localId, visible: true }],
    rev: 2,
    homeRev: 1,
    createdAt: 1_769_000_000_000,
    amendedAt: 1_769_000_000_000,
    ...over,
  }
}

function sidecarFile(records: Surface[]): string {
  return JSON.stringify({ version: SURFACE_SIDECAR_SCHEMA_VERSION, records, idempotency: [] }, null, 2)
}

describe('a clean migration', () => {
  it('leads with the load outcome and the totals', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective'), point('CLD-a', 'blockers')])
      const out = ctx.run()
      const load = out.indexOf('CANONICAL STORE LOAD')
      const totals = out.indexOf('MIGRATION TOTALS')
      const runs = out.indexOf('RUNS ·')
      expect(load).toBeGreaterThan(-1)
      expect(load).toBeLessThan(totals)
      expect(totals).toBeLessThan(runs)
      // 2 points + the run's hidden compatibility root.
      expect(flat(out)).toContain('3 created · 0 updated · 0 unchanged')
      expect(flat(out)).toContain('healthy — no sidecar file on disk yet')
      expect(out).toContain('Bottom line: clean')
    })
  })

  it('stays short when hundreds of surfaces migrate cleanly', () => {
    withDir(ctx => {
      const runs = [], points: Point[] = []
      for (let r = 0; r < 40; r++) {
        const id = `CLD-run-${String(r).padStart(2, '0')}`
        runs.push(run(id, { createdAt: `2026-07-20T09:0${r % 10}:00.000Z` }))
        for (let p = 0; p < 10; p++) points.push(point(id, `q-${p}`))
      }
      ctx.write(runs, points)
      const out = ctx.run()
      // 440 surfaces in, and the dump still fits on one screen-and-a-bit.
      expect(flat(out)).toContain('440 created')
      expect(lineCount(out)).toBeLessThan(40)
      expect(out).toContain('34 more run(s) with nothing to report')
      // --all is the escape hatch, and it really does list them.
      expect(lineCount(ctx.run(true))).toBeGreaterThan(80)
    })
  })

  it('says nothing about sections that have nothing in them', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      const out = ctx.run()
      expect(out).not.toContain('QUARANTINED')
      expect(out).not.toContain('PRESERVATION GAPS')
      expect(out).not.toContain('ORPHANED')
      expect(out).not.toContain('RETIRED')
      expect(out).not.toContain('POINTS WITH NO RUN')
    })
  })
})

describe('entries that did not migrate', () => {
  it('shows a quarantined entry and its detail sentence verbatim, buried in clean data', () => {
    withDir(ctx => {
      const runs = [], points: Point[] = []
      for (let r = 0; r < 30; r++) {
        const id = `CLD-run-${String(r).padStart(2, '0')}`
        runs.push(run(id, { createdAt: `2026-07-20T09:0${r % 10}:00.000Z` }))
        for (let p = 0; p < 10; p++) points.push(point(id, `q-${p}`))
      }
      // One bad apple: a point with no headline.
      points.push(point('CLD-run-00', 'no-headline', { headline: '' }))
      ctx.write(runs, points)

      const d = collectMigrationDiagnostics({ docstorePath: ctx.docstore, sidecarDir: ctx.dir, now: NOW })
      const quarantine = d.migration!.report.quarantined[0]!
      const out = renderMigrationDiagnostics(d, { color: false })

      expect(out).toContain('QUARANTINED')
      expect(out).toContain('missing-headline')
      expect(out).toContain('CLD-run-00 / no-headline')
      // The report's own sentence, not a re-worded one.
      expect(flat(out)).toContain(flat(quarantine.detail))
      // And the run it belongs to is listed even though 29 clean runs are hidden.
      expect(out).toContain('… 23 more run(s) with nothing to report')
      expect(flat(out)).toContain('1 legacy entry did not migrate')
    })
  })

  it('never truncates the quarantine list, however long it is', () => {
    withDir(ctx => {
      const runs = [], points: Point[] = []
      for (let r = 0; r < 25; r++) {
        const id = `CLD-run-${String(r).padStart(2, '0')}`
        runs.push(run(id, { createdAt: `2026-07-20T09:0${r % 10}:00.000Z` }))
        points.push(point(id, 'ok'))
        points.push(point(id, 'bad', { headline: '' }))
      }
      ctx.write(runs, points)
      const out = ctx.run()
      for (let r = 0; r < 25; r++) expect(out).toContain(`CLD-run-${String(r).padStart(2, '0')} / bad`)
      expect(out).not.toContain('more with the same fields')
    })
  })

  it('says "the whole run" only when the whole run was refused', () => {
    withDir(ctx => {
      ctx.write(
        [run('CLD-nodate', { createdAt: undefined }), run('CLD-broken')],
        [point('CLD-nodate', 'lost'), { ...point('CLD-broken', 'x'), id: '' } as Point],
      )
      const out = ctx.run()
      expect(out).toContain('CLD-nodate  (the whole run)')
      expect(out).toContain('CLD-broken  (an entry with no id)')
      // A run that migrated nothing is flagged in the run list too.
      expect(out).toContain('root none (nothing migrated)')
    })
  })

  it('reports legacy points whose run is not in the docstore at all', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective'), point('CLD-ghost', 'orphan-question')])
      const out = ctx.run()
      expect(out).toContain('POINTS WITH NO RUN')
      expect(out).toContain('CLD-ghost / orphan-question')
      expect(flat(out)).toContain('never reached the migration')
    })
  })
})

describe('preservation gaps', () => {
  it('names every uncarried field, explains what it does, and lists the surfaces', () => {
    withDir(ctx => {
      ctx.write(
        [run('CLD-a')],
        [
          point('CLD-a', 'diagram-q', { anchor: { kind: 'surface', ref: 'svc' } }),
          point('CLD-a', 'banded-q', { group: 'launch-review', stalledAt: 1_770_000_900_000 }),
        ],
      )
      const out = ctx.run()
      expect(out).toContain('PRESERVATION GAPS')
      expect(flat(out)).toContain('2 surfaces migrated with a field left behind')
      // The field names, each with a plain-words gloss.
      expect(flat(out)).toContain('anchor — where the point pins onto a diagram')
      expect(flat(out)).toContain('group — which workbench column the point sits in')
      expect(flat(out)).toContain('stalledAt — the marker the server sets')
      expect(out).toContain('CLD-a / diagram-q')
      expect(out).toContain('CLD-a / banded-q')
      // And the reader is told it is not recoverable by re-running.
      expect(flat(out)).toContain('re-running migration will not recover them')
      expect(out).toContain('Bottom line:')
    })
  })
})

describe('the canonical store load outcome', () => {
  it('reports a faulted load prominently, above the totals, in plain words', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      ctx.writeSidecar('{"version":1,"records":[{"id":')
      ctx.writeBackup('not json at all')
      const out = ctx.run()

      expect(out.indexOf('FAULTED (read-only)')).toBeLessThan(out.indexOf('MIGRATION TOTALS'))
      expect(flat(out)).toContain('refuses every write for the life of the process')
      expect(flat(out)).toContain('both files are being preserved untouched as evidence')
      // Both files are named with their own diagnosis.
      expect(out).toContain(join(ctx.dir, 'surfaces.json'))
      expect(out).toContain(join(ctx.dir, 'surfaces.backup.json'))
      // The write count must not read as a promise.
      expect(flat(out)).toContain('none — the store is faulted and refuses every write')
      expect(out).toContain('Bottom line: the canonical store is faulted')
    })
  })

  it('explains a recovered load and what the operator has lost', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      ctx.writeSidecar('truncated{')
      ctx.writeBackup(sidecarFile([record('sf-lg-kept000000000000000000', 'CLD-a', 'objective')]))
      const out = ctx.run()
      expect(flat(out)).toContain('recovered — the primary snapshot was unusable')
      expect(flat(out)).toContain('anything committed after the last backup rotation is gone')
      expect(flat(out)).toContain('1 record came from the backup')
    })
  })

  it('counts records the snapshot dropped on load', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      ctx.writeSidecar(JSON.stringify({
        version: SURFACE_SIDECAR_SCHEMA_VERSION,
        records: [{ id: 'sf-lg-nohome00000000000000000', spaceId: SPACE, rev: 1, homeRev: 1 }],
        idempotency: [],
      }))
      const out = ctx.run()
      expect(flat(out)).toContain('1 record in that snapshot failed the shape guard')
    })
  })

  it('runs without the backend singleton lock held — the server may be up', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      // No server.lock in this directory at all. `SurfaceSidecar.open` would throw;
      // an inspection must not, or it is unusable in the one situation it is for.
      expect(readdirSync(ctx.dir)).not.toContain('server.lock')
      expect(() => ctx.run()).not.toThrow()
    })
  })
})

describe('re-entrancy, as the operator sees it', () => {
  it('shows a second pass over unchanged data as unchanged, not as churn', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective'), point('CLD-a', 'blockers')])
      const first = collectMigrationDiagnostics({ docstorePath: ctx.docstore, sidecarDir: ctx.dir, now: NOW })
      // Commit the first pass by hand — the diagnostics tool never writes.
      ctx.writeSidecar(sidecarFile(first.migration!.puts))
      const out = ctx.run()
      expect(flat(out)).toContain('0 created · 0 updated · 3 unchanged')
      expect(flat(out)).toContain('0 records would be written to the sidecar')
      expect(out).toContain('Bottom line: clean')
    })
  })

  it('reports a canonical record whose legacy point was deleted as orphaned', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      const inc = deriveRunIncarnation('CLD-a', '2026-07-20T09:00:00.000Z')!
      ctx.writeSidecar(sidecarFile([
        record(deriveLegacyRunRootId(inc), 'CLD-a', LEGACY_RUN_ROOT_LOCAL_ID, { compatibilityOnly: true }),
        record(deriveLegacySurfaceId(inc, 'deleted-q'), 'CLD-a', 'deleted-q'),
      ]))
      const out = ctx.run()
      expect(out).toContain('ORPHANED')
      expect(out).toContain('CLD-a / deleted-q')
      expect(flat(out)).toContain('Nothing was removed')
    })
  })
})

describe('read-only', () => {
  it('leaves every input file byte-identical and creates nothing', () => {
    withDir(ctx => {
      ctx.write(
        [run('CLD-a'), run('CLD-b')],
        [point('CLD-a', 'objective'), point('CLD-a', 'bad', { headline: '' }), point('CLD-b', 'q')],
      )
      ctx.writeSidecar(sidecarFile([record('sf-lg-existing0000000000000', 'CLD-a', 'objective')]))
      ctx.writeBackup(sidecarFile([]))

      const before = readdirSync(ctx.dir).sort()
      const digests = Object.fromEntries(before.map(f => [f, digest(join(ctx.dir, f))]))

      const out = ctx.run()
      expect(out).toContain('QUARANTINED')

      expect(readdirSync(ctx.dir).sort()).toEqual(before)
      for (const f of before) expect(digest(join(ctx.dir, f))).toBe(digests[f])
    })
  })

  it('does not create a sidecar, a backup, or a config directory that was absent', () => {
    withDir(ctx => {
      const nested = join(ctx.dir, 'not-created-yet')
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      renderMigrationDiagnostics(
        collectMigrationDiagnostics({ docstorePath: ctx.docstore, sidecarDir: nested, now: NOW }),
      )
      expect(readdirSync(ctx.dir)).toEqual(['docstore.json'])
    })
  })
})

describe('unreadable input', () => {
  it('refuses to guess when the docstore is not there', () => {
    withDir(ctx => {
      const out = renderMigrationDiagnostics(
        collectMigrationDiagnostics({ docstorePath: join(ctx.dir, 'nope.json'), sidecarDir: ctx.dir, now: NOW }),
      )
      expect(out).toContain('LEGACY SLATE')
      expect(out).toContain('could not be read')
      expect(out).toContain('Nothing could be rehearsed')
      expect(out).not.toContain('MIGRATION TOTALS')
    })
  })

  it('reports a corrupt docstore rather than throwing', () => {
    withDir(ctx => {
      writeFileSync(ctx.docstore, '{"runs": [')
      expect(ctx.run()).toContain('is not valid JSON')
    })
  })

  it('tolerates a docstore with no slate at all', () => {
    withDir(ctx => {
      writeFileSync(ctx.docstore, JSON.stringify({ spaces: [] }))
      const scan = readLegacyDocstore(ctx.docstore)
      expect(scan.ok && scan.runs).toEqual([])
      expect(ctx.run()).toContain('no runs in this docstore')
    })
  })
})

describe('the command', () => {
  it('parses its flags, and refuses ones it does not know', () => {
    expect(parseDiagnosticsArgs(['--docstore', '/a/b.json', '--all', '--json'])).toEqual({
      ok: true,
      options: { docstorePath: '/a/b.json', all: true, json: true, color: false, help: false },
    })
    expect(parseDiagnosticsArgs(['--docstore'])).toEqual({ ok: false, error: '--docstore needs a path' })
    expect(parseDiagnosticsArgs(['--wat'])).toEqual({ ok: false, error: 'unknown option: --wat' })
    // Colour is on for a terminal and off the moment output is redirected.
    const tty = parseDiagnosticsArgs([], true)
    const piped = parseDiagnosticsArgs([], false)
    const optedOut = parseDiagnosticsArgs(['--no-color'], true)
    expect(tty.ok && tty.options.color).toBe(true)
    expect(piped.ok && piped.options.color).toBe(false)
    expect(optedOut.ok && optedOut.options.color).toBe(false)
  })

  it('exits 0 on a readable store, 1 on a faulted one, 2 on bad usage', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      const lines: string[] = []
      const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) }
      const args = ['--docstore', ctx.docstore, '--sidecar-dir', ctx.dir]

      expect(runDiagnosticsCli(args, io)).toBe(0)
      expect(runDiagnosticsCli(['--nope'], io)).toBe(2)
      expect(runDiagnosticsCli(['--help'], io)).toBe(0)
      expect(lines.some(l => l.includes('usage: npm run surfaces:diagnose'))).toBe(true)

      ctx.writeSidecar('{{{')
      ctx.writeBackup('}}}')
      expect(runDiagnosticsCli(args, io)).toBe(1)
    })
  })

  it('emits machine-readable JSON under --json, with the human form still the default', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective'), point('CLD-a', 'bad', { headline: '' })])
      const lines: string[] = []
      const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) }
      expect(runDiagnosticsCli(['--docstore', ctx.docstore, '--sidecar-dir', ctx.dir, '--json'], io)).toBe(0)
      const parsed = JSON.parse(lines[0]!)
      expect(parsed.readOnly).toBe(true)
      expect(parsed.sidecar.health).toBe('healthy')
      expect(parsed.migration.report.quarantined).toHaveLength(1)
      expect(parsed.migration.wouldWrite).toBe(2)

      lines.length = 0
      expect(runDiagnosticsCli(['--docstore', ctx.docstore, '--sidecar-dir', ctx.dir], io)).toBe(0)
      expect(lines[0]).toContain('Surface migration diagnostics')
    })
  })

  it('carries no ANSI escapes unless colour was asked for', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      const d = collectMigrationDiagnostics({ docstorePath: ctx.docstore, sidecarDir: ctx.dir, now: NOW })
      const ansi = /\u001b\[/
      expect(ansi.test(renderMigrationDiagnostics(d, { color: false }))).toBe(false)
      expect(ansi.test(renderMigrationDiagnostics(d, { color: true }))).toBe(true)
    })
  })

  it('keeps the JSON payload free of prose', () => {
    withDir(ctx => {
      ctx.write([run('CLD-a')], [point('CLD-a', 'objective')])
      const json = migrationDiagnosticsJson(
        collectMigrationDiagnostics({ docstorePath: ctx.docstore, sidecarDir: ctx.dir, now: NOW }),
      ) as { legacy: { runs: number; points: number } }
      expect(json.legacy).toMatchObject({ runs: 1, points: 1 })
    })
  })
})
