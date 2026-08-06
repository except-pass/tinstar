// @vitest-environment node
//
// The `slate-file` binding's two halves: the locator/watermark vocabulary the
// ingress side speaks, and the egress adapter that carries an API content edit back
// into the file so the next epoch agrees with it.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { readdir, lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore } from '../../stores/document-store'
import { SurfaceService, type SurfaceCallContext, type SurfaceResult } from '../surface-service'
import {
  parseSlateFileLocator,
  slateEntryWatermark,
  SlateFileAdapter,
  slateFileLocator,
  slateFilePath,
  SLATE_FILE_ADAPTER,
} from '../slate-source'
import { SlateWatcher, type SlateFs, type SlateTimers } from '../../sessions/slate-watcher'
import type { SlateSourceEntry } from '../slate-source'
import type { SlateSourceEpoch } from '../source-reconciler'
import type { Surface, SurfacePrincipalRef } from '../../../domain/types'

const HUMAN: SurfacePrincipalRef = { kind: 'human', id: 'actor-1' }
function ctx(at = 1_000): SurfaceCallContext { return { actor: HUMAN, at } }

/** `true` when the mutation was accepted, otherwise its refusal message — so a
 *  failed expectation names the reason instead of reading `false !== true`. */
function unwrapOk<T>(r: SurfaceResult<T>): true | string {
  return r.ok ? true : r.error.message
}

/**
 * Read a worktree's slate dir through the REAL watcher.
 *
 * The ingress half of a round trip has to be the actual reader, not a hand-built
 * entry: an entry shaped by hand is a shape nothing upstream emits, so a test using
 * one proves agreement with a contract that does not exist. Only the watch and timer
 * seams are stubbed (no inotify, no clocks) — every read hits the real temp dir.
 */
async function readEntries(worktree: string): Promise<SlateSourceEntry[]> {
  const fs: SlateFs = {
    existsSync,
    watch: () => ({ close: () => {} }),
    readdir: (d) => readdir(d),
    lstat: async (p) => { const s = await lstat(p); return { size: s.size, isFile: s.isFile() } },
    readFile: (p) => readFile(p, 'utf8'),
  }
  const timers: SlateTimers = {
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  }
  const epochs: SlateSourceEpoch[] = []
  const watcher = new SlateWatcher({
    listLiveRuns: () => [{ runId: 'run-1', workdir: worktree }],
    runContext: () => ({ spaceId: 'spc-a', incarnation: 'inc-1', rootSurfaceId: 'sf-root' }),
    applyEpoch: async (e) => { epochs.push(e); return {} },
    fs,
    timers,
  })
  await watcher.pollOnce()
  watcher.stop()
  return epochs[epochs.length - 1]?.entries ?? []
}

describe('locators', () => {
  it('round-trips a file and entry id', () => {
    expect(parseSlateFileLocator(slateFileLocator('a.json', 'blockers')))
      .toEqual({ file: 'a.json', localId: 'blockers' })
  })

  it('refuses a locator this adapter does not own', () => {
    // What migration stamps for a point that has no file at all.
    expect(parseSlateFileLocator('run:run-a/point:blockers')).toBeNull()
  })

  it('refuses a locator that would escape the slate directory', () => {
    expect(parseSlateFileLocator('file:../../evil.json#x')).toBeNull()
    expect(parseSlateFileLocator('file:sub/dir.json#x')).toBeNull()
    expect(parseSlateFileLocator('file:notjson#x')).toBeNull()
    expect(slateFilePath('/wt', '../escape.json')).toBeNull()
  })
})

describe('watermarks', () => {
  it('ignores everything but the authored fields', () => {
    const a = slateEntryWatermark({ headline: 'h', author: 'agent' })
    const b = slateEntryWatermark({ headline: 'h', author: 'agent' })
    expect(a).toBe(b)
    expect(slateEntryWatermark({ headline: 'h', author: 'user' })).not.toBe(a)
    expect(slateEntryWatermark({ headline: 'h', recipe: { kind: 'agent' as const, prompt: 'r' }, author: 'agent' })).not.toBe(a)
  })

  // A claim DECLARATION is author meaning — it says what would prove this surface
  // wrong — so editing one has to move the evidence, or the reconciler sees an
  // unchanged watermark, commits nothing, and keeps checking the old statement.
  it('moves when a claim declaration is edited, in every part of it', () => {
    const claim = { id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' } as const
    const base = slateEntryWatermark({ headline: 'h', claims: [claim], author: 'agent' })

    expect(slateEntryWatermark({ headline: 'h', claims: [{ ...claim, id: 'u2' }], author: 'agent' })).not.toBe(base)
    expect(slateEntryWatermark({ headline: 'h', claims: [{ ...claim, witness: 'http-status' }], author: 'agent' })).not.toBe(base)
    expect(slateEntryWatermark({ headline: 'h', claims: [{ ...claim, params: { unit: 'U2' } }], author: 'agent' })).not.toBe(base)
    expect(slateEntryWatermark({ headline: 'h', claims: [{ ...claim, locus: 'infra' }], author: 'agent' })).not.toBe(base)
    expect(slateEntryWatermark({ headline: 'h', claims: [claim, claim], author: 'agent' })).not.toBe(base)
    // And it is stable for an identical declaration — otherwise every epoch is an edit.
    expect(slateEntryWatermark({ headline: 'h', claims: [{ ...claim }], author: 'agent' })).toBe(base)
  })

  it('tells an absent claims list from an empty one', () => {
    const silent = slateEntryWatermark({ headline: 'h', author: 'agent' })
    const checked = slateEntryWatermark({ headline: 'h', claims: [], author: 'agent' })
    expect(checked).not.toBe(silent)
  })

  // KTD2's split, asserted from the only side U1 can assert it from: the basis is
  // built from AUTHORED fields, so nothing the host writes near the entry is in it.
  // U3 puts the observed values on `SurfaceFreshness`; if they ever land on
  // `SurfaceContent` or on the file entry instead, this is the property that breaks
  // — and the symptom is a watermark that moves every time the host looks.
  it('is not moved by a key the author did not write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    const claims = [{ id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }]
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{ id: 'r', headline: 'Roadmap', claims }]))
    const before = (await readEntries(dir))[0]!.watermark

    // A host-shaped sibling key on the same entry. It is preserved by the adapter
    // (unknown keys always are) but it is not authored content, so it must not be
    // evidence that the author changed anything.
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{
      id: 'r', headline: 'Roadmap', claims, lastObservedByTheHost: { u1: 'landed', at: 1_700_000 },
    }]))

    expect((await readEntries(dir))[0]!.watermark).toBe(before)
    rmSync(dir, { recursive: true, force: true })
  })

  it('covers the author CLAIM by meaning but never by its host timestamp', () => {
    // `proposal.at` is host-stamped on every read. Hashing it would move the
    // watermark on every epoch forever — a revision per surface per tick, on a file
    // nobody edited. Hashing its MEANING is required, or an author who changes only
    // their claim gets an unchanged watermark and the host commits nothing.
    const base = { headline: 'D6', author: 'agent' as const }
    const working = slateEntryWatermark({ ...base, proposal: { state: 'working', at: 1 } })
    expect(slateEntryWatermark({ ...base, proposal: { state: 'working', at: 999_999 } })).toBe(working)
    expect(slateEntryWatermark({ ...base, proposal: { state: 'resolved', at: 1 } })).not.toBe(working)
    expect(slateEntryWatermark({ ...base, proposal: { state: 'working', detail: 'half a day', at: 1 } }))
      .not.toBe(working)
    expect(slateEntryWatermark(base)).not.toBe(working)
  })
})

describe('claims across a full file round trip (U1)', () => {
  it('keeps absent, empty, and declared apart from read to record to write to re-read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    const claim = { id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }
    writeFileSync(join(slate, 'a.json'), JSON.stringify([
      { id: 'silent', headline: 'never said' },
      { id: 'checked', headline: 'nothing witnessable', claims: [] },
      { id: 'declared', headline: 'one claim', claims: [claim] },
    ], null, 2))

    // READ — through the real watcher.
    const entries = await readEntries(dir)
    expect(entries.map(e => e.localId)).toEqual(['silent', 'checked', 'declared'])
    expect('claims' in entries[0]!.content).toBe(false)
    expect(entries[1]!.content.claims).toEqual([])
    expect(entries[2]!.content.claims).toEqual([claim])

    // RECORD — each entry becomes a source-bound canonical Surface.
    const docStore = new DocumentStore()
    let n = 0
    const svc = new SurfaceService(docStore, {
      newId: () => `sf-${++n}`,
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    for (const entry of entries) {
      expect(unwrapOk(await svc.create({
        spaceId: 'spc-a',
        home: { kind: 'canvas', spaceId: 'spc-a' },
        content: entry.content,
        contentAuthority: 'source-binding',
        source: {
          adapter: SLATE_FILE_ADAPTER,
          locator: slateFileLocator('a.json', entry.localId),
          worktree: dir,
          watermark: entry.watermark,
        },
      }, ctx()))).toBe(true)
    }
    expect(docStore.getSurface('sf-1')!.content).not.toHaveProperty('claims')
    expect(docStore.getSurface('sf-2')!.content.claims).toEqual([])
    expect(docStore.getSurface('sf-3')!.content.claims).toEqual([claim])

    // WRITE — a headline edit on each, carried back into the file by the adapter.
    for (const [i, entry] of entries.entries()) {
      const id = `sf-${i + 1}`
      const r = await svc.updateContent(
        id,
        { headline: `${entry.content.headline} (edited)`, expectedRev: 1, expectedWatermark: entry.watermark },
        ctx(2_000),
      )
      expect(unwrapOk(r)).toBe(true)
    }

    // RE-READ — the file still says three different things, and the watermark the
    // egress side persisted is the one the ingress side computes from what it wrote.
    const raw = JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[]
    expect('claims' in raw[0]!).toBe(false)
    expect(raw[1]!.claims).toEqual([])
    expect(raw[2]!.claims).toEqual([claim])

    const reread = await readEntries(dir)
    expect('claims' in reread[0]!.content).toBe(false)
    expect(reread[1]!.content.claims).toEqual([])
    expect(reread[2]!.content.claims).toEqual([claim])
    for (const [i, entry] of reread.entries()) {
      expect(docStore.getSurface(`sf-${i + 1}`)!.source!.watermark).toBe(entry.watermark)
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('a refused claim across a full file round trip (U6)', () => {
  it('drops the claim from the record, keeps it in the author\'s file, and moves no evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    const bad = { id: 'u1', witness: 'unit-lands', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }
    const good = { id: 'up', witness: 'http-status', params: { url: 'https://example.test/' }, locus: 'infra' as const }
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{ id: 'road', headline: 'Roadmap', claims: [bad, good] }], null, 2))

    // READ — the bad claim is gone from the entry and named in its refusals.
    const entry = (await readEntries(dir))[0]!
    expect(entry.content.claims).toEqual([good])
    expect(entry.claimRefusals).toHaveLength(1)
    expect(entry.claimRefusals![0]).toMatch(/unit-lands/)
    // The refusal is host knowledge, so it is not evidence the author changed
    // anything: the same file with the bad claim absent hashes the same way.
    expect(entry.watermark).toBe(slateEntryWatermark({ headline: 'Roadmap', claims: [good], author: 'agent' }))

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    expect(unwrapOk(await svc.create({
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: entry.content,
      contentAuthority: 'source-binding',
      source: {
        adapter: SLATE_FILE_ADAPTER,
        locator: slateFileLocator('a.json', 'road'),
        worktree: dir,
        watermark: entry.watermark,
      },
    }, ctx()))).toBe(true)

    // WRITE — an API edit carries the record's claims back into the file. The
    // record never held the refused claim, so a plain write-back would delete it
    // from the author's own file and the refusal would vanish with it.
    expect(unwrapOk(await svc.updateContent(
      'sf-1', { headline: 'Roadmap — edited', expectedRev: 1, expectedWatermark: entry.watermark }, ctx(2_000),
    ))).toBe(true)

    const written = (JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[])[0]!
    expect(written.claims).toEqual([good, bad])

    // RE-READ — the refusal is still derivable, and the watermark the egress side
    // persisted is the one the ingress side computes from what it wrote.
    const reread = (await readEntries(dir))[0]!
    expect(reread.content.claims).toEqual([good])
    expect(reread.claimRefusals).toHaveLength(1)
    expect(docStore.getSurface('sf-1')!.source!.watermark).toBe(reread.watermark)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the egress adapter', () => {
  let dir: string
  const bound = (over: Partial<Surface['source']> = {}) => ({
    source: { adapter: SLATE_FILE_ADAPTER, locator: slateFileLocator('a.json', 'blockers'), generation: 1, worktree: dir, ...over },
  })

  function seed(entries: unknown): void {
    dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), JSON.stringify(entries, null, 2))
  }
  function read(): unknown {
    return JSON.parse(readFileSync(join(dir, '.tinstar', 'slate', 'a.json'), 'utf8'))
  }

  it('replaces the addressed entry and preserves its siblings and unknown fields', async () => {
    seed([
      { id: 'blockers', headline: 'Two blockers', content: { root: 'x', components: {} }, someFutureField: 7 },
      { id: 'plan', headline: 'The plan' },
    ])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'One blocker' },
    })

    expect(r.ok).toBe(true)
    const after = read() as Record<string, unknown>[]
    expect(after).toHaveLength(2)
    expect(after[0]).toEqual({ id: 'blockers', headline: 'One blocker', someFutureField: 7 })
    expect(after[1]).toEqual({ id: 'plan', headline: 'The plan' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a watermark the ingress side reproduces from the same file', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers' }])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'One blocker', recipe: { kind: 'agent' as const, prompt: 'rebuild me' } },
    })

    expect(r.ok && r.watermark).toBe(slateEntryWatermark({ headline: 'One blocker', recipe: { kind: 'agent' as const, prompt: 'rebuild me' }, author: 'agent' }))
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses when the entry changed since it was read', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers' }])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'One blocker' },
      expectedWatermark: 'sha256:not-the-current-one',
    })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/changed since it was read/)
    expect((read() as Record<string, unknown>[])[0]!.headline).toBe('Two blockers')
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses rather than overwriting a file it cannot merge into', async () => {
    dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), '{ not json')
    const r = await new SlateFileAdapter().write({ surface: bound() as never, content: { headline: 'x' } })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/not valid JSON/)
    expect(readFileSync(join(slate, 'a.json'), 'utf8')).toBe('{ not json')
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a Surface whose binding names no file', async () => {
    const r = await new SlateFileAdapter().write({
      surface: { source: { adapter: 'legacy-slate-point', locator: 'run:r/point:p', generation: 0 } } as never,
      content: { headline: 'x' },
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/not bound to a Slate source file/)
  })

  it('carries the author claim back into the file WITHOUT the host stamp', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers' }])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'D6', proposal: { state: 'resolved', detail: 'shipped in #163', at: 7_777 } },
    })
    expect(r.ok).toBe(true)
    // No `at`. It is the host's observation of when it READ the claim; writing it
    // back would put a host value under the author's byline and leave the file and
    // the record disagreeing about a field neither of them owns.
    expect((read() as Record<string, unknown>[])[0]!.proposal)
      .toEqual({ state: 'resolved', detail: 'shipped in #163' })
  })

  it('clears the claim when the content no longer carries one', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers', proposal: { state: 'working' } }])
    const r = await new SlateFileAdapter().write({ surface: bound() as never, content: { headline: 'D6' } })
    expect(r.ok).toBe(true)
    expect((read() as Record<string, unknown>[])[0]!.proposal).toBeUndefined()
  })

  // The compare-and-swap hashes the CURRENT file entry through `authoredFieldsOf`,
  // so that function has to see every field ingress sees. A field missing from it
  // makes the two sides hash differently, and then every write to an entry carrying
  // that field is refused as stale against a watermark nothing can ever produce.
  it('reproduces the ingress watermark for an entry that carries a proposal', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers', proposal: { state: 'working', detail: 'half a day' } }])
    const entry = (await readEntries(dir))[0]!
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { ...entry.content, headline: 'One blocker' },
      expectedWatermark: entry.watermark,
    })
    expect(r.ok).toBe(true)
    // And what it persisted is what the NEXT ingress read computes, so the epoch
    // after this write sees an unchanged entry rather than a phantom author edit.
    expect(r.ok && r.watermark).toBe((await readEntries(dir))[0]!.watermark)
  })
})

describe('registered on the service', () => {
  it('carries a source-bound API content edit into the file instead of refusing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{ id: 'blockers', headline: 'Two blockers' }]))

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    const created = await svc.create({
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: { headline: 'Two blockers' },
      contentAuthority: 'source-binding',
      source: { adapter: SLATE_FILE_ADAPTER, locator: slateFileLocator('a.json', 'blockers'), worktree: dir },
    }, ctx())
    expect(created.ok).toBe(true)

    const edited = await svc.updateContent('sf-1', { headline: 'One blocker', expectedRev: 1 }, ctx(2_000))
    expect(edited.ok).toBe(true)
    // Both halves moved: the file, and the watermark persisted on the binding.
    const after = JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[]
    expect(after[0]!.headline).toBe('One blocker')
    expect(docStore.getSurface('sf-1')!.source!.watermark)
      .toBe(slateEntryWatermark({ headline: 'One blocker', author: 'agent' }))
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a record byte-identical to what the next epoch rebuilds for it', async () => {
    // The store's storm guard is `JSON.stringify` equality, so it is not enough for
    // the two content builders to carry the same fields — they have to emit them in
    // the same ORDER. When they do not, every API edit of a file-bound Surface is
    // followed by an epoch that sees a "changed" record, commits a revision, and
    // fans out an SSE for content nobody touched. Cheap to assert, invisible
    // otherwise, and it regresses the moment a field is added in the wrong place.
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{
      id: 'road',
      headline: 'Roadmap',
      content: { root: 'r', components: [{ component: 'Text', id: 'r', text: 'hi' }] },
      refresh: 'Re-derive it.',
      refreshPolicy: { policy: 'automatic', triggers: ['git-revision'] },
      claims: [{ id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }],
    }]))
    const entry = (await readEntries(dir))[0]!

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    // Seeded exactly as `observeSource` records it — through `create` it could not
    // be, because `parseContent` carries no `refreshPolicy` (an API-created Surface
    // cannot declare one at all).
    docStore.loadSurfaces([{
      id: 'sf-1',
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: entry.content,
      contentAuthority: 'source-binding',
      author: 'agent',
      source: {
        adapter: SLATE_FILE_ADAPTER,
        locator: slateFileLocator('a.json', 'road'),
        worktree: dir,
        generation: 1,
        watermark: entry.watermark,
        state: 'present',
      },
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false, observedGeneration: 1 },
      rev: 1, homeRev: 1, createdAt: 1_000, amendedAt: 1_000,
    }])

    expect(unwrapOk(await svc.updateContent(
      'sf-1', { headline: 'Roadmap — edited', expectedRev: 1, expectedWatermark: entry.watermark }, ctx(2_000),
    ))).toBe(true)

    const rebuilt = (await readEntries(dir))[0]!
    expect(JSON.stringify(docStore.getSurface('sf-1')!.content)).toBe(JSON.stringify(rebuilt.content))
    rmSync(dir, { recursive: true, force: true })
  })

  it('a completed REFRESH leaves the file still holding its CLAIMS', async () => {
    // Same hazard as the recipe below, one field over: a rebuild that dropped the
    // claims would leave a just-rebuilt surface with nothing saying what would
    // prove it wrong — and would delete the declaration from the author's own file.
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    const claims = [{ id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }]
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{
      id: 'road', headline: 'Roadmap', refresh: 'Re-derive the roadmap.', claims,
    }]))
    const entry = (await readEntries(dir))[0]!

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    expect(unwrapOk(await svc.create({
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: entry.content,
      contentAuthority: 'source-binding',
      source: {
        adapter: SLATE_FILE_ADAPTER,
        locator: slateFileLocator('a.json', 'road'),
        worktree: dir,
        watermark: entry.watermark,
      },
    }, ctx()))).toBe(true)

    // A host-owned freshness write moves no evidence: the binding's watermark is
    // the author's, and nothing the coordinator does may look like an author edit.
    const watermarkBefore = docStore.getSurface('sf-1')!.source!.watermark
    await svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx(2_000))
    expect(docStore.getSurface('sf-1')!.source!.watermark).toBe(watermarkBefore)

    await svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: docStore.getSurface('sf-1')!.rev }, ctx(2_100))
    // Exactly what a worker can emit: a headline, no more.
    expect(unwrapOk(await svc.completeRefresh('sf-1', {
      jobId: 'job-1',
      expectedRev: docStore.getSurface('sf-1')!.rev,
      observedGeneration: docStore.getSurface('sf-1')!.source!.generation,
      content: { headline: 'Roadmap — 3 of 8 landed' },
    }, ctx(3_000)))).toBe(true)

    expect(docStore.getSurface('sf-1')!.content.claims).toEqual(claims)
    const written = (JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[])[0]!
    expect(written.headline).toBe('Roadmap — 3 of 8 landed')
    expect(written.claims).toEqual(claims)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a completed REFRESH leaves the file still holding its recipe and policy', async () => {
    // The file is the author's own `.tinstar/slate/*.json`, and `SlateFileAdapter`
    // treats an absent recipe as an instruction to DROP it. So a barrier that wrote
    // the worker's content wholesale did not merely forget the recipe on the record
    // — it deleted it from the user's source file, leaving a Surface nothing could
    // ever rebuild and an edit to their file they never made.
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    const policy = { policy: 'automatic', triggers: ['git-revision'] }
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{
      id: 'cov', headline: 'Coverage', refresh: 'Re-run coverage.', refreshPolicy: policy,
    }]))

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    // Seeded onto the record rather than built through `create`, because
    // `parseContent` does not carry `refreshPolicy` — an API-created Surface cannot
    // declare one at all. File-authored Surfaces (the ones this is about) get theirs
    // from `observeSource`, which builds content itself.
    docStore.loadSurfaces([{
      id: 'sf-1',
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: { headline: 'Coverage', recipe: { kind: 'agent' as const, prompt: 'Re-run coverage.' }, refreshPolicy: policy as never },
      contentAuthority: 'source-binding',
      author: 'agent',
      source: {
        adapter: SLATE_FILE_ADAPTER,
        locator: slateFileLocator('a.json', 'cov'),
        worktree: dir,
        generation: 1,
        watermark: slateEntryWatermark({
          headline: 'Coverage', recipe: { kind: 'agent' as const, prompt: 'Re-run coverage.' },
          refreshPolicy: policy as never, author: 'agent',
        }),
        state: 'present',
      },
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'possibly-stale', overdue: false, observedGeneration: 1 },
      rev: 1, homeRev: 1, createdAt: 1_000, amendedAt: 1_000,
    }])
    await svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx(2_000))
    await svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: docStore.getSurface('sf-1')!.rev }, ctx(2_100))

    // Exactly what `parseStagedResult` can emit for a worker: a headline, no more.
    const done = await svc.completeRefresh('sf-1', {
      jobId: 'job-1',
      expectedRev: docStore.getSurface('sf-1')!.rev,
      observedGeneration: docStore.getSurface('sf-1')!.source!.generation,
      content: { headline: 'Coverage 92%' },
    }, ctx(3_000))
    expect(done.ok).toBe(true)

    const entry = (JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[])[0]!
    expect(entry.headline).toBe('Coverage 92%')
    expect(entry.refresh).toBe('Re-run coverage.')
    expect(entry.refreshPolicy).toEqual(policy)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a refresh whose source entry moved underneath it is SUPERSEDED, not committed', async () => {
    // The adapter's watermark check is "what makes a lost update visible rather
    // than silent" — and `completeRefresh` was not passing `expectedWatermark`, so
    // it never ran. A stale refusal is a supersession (one successor against what
    // the file says now), not a failure.
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{ id: 'cov', headline: 'Coverage' }]))

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    await svc.create({
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: { headline: 'Coverage' },
      contentAuthority: 'source-binding',
      source: {
        adapter: SLATE_FILE_ADAPTER,
        locator: slateFileLocator('a.json', 'cov'),
        worktree: dir,
        watermark: slateEntryWatermark({ headline: 'Coverage', author: 'agent' }),
      },
    }, ctx())
    await svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx(2_000))
    await svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: docStore.getSurface('sf-1')!.rev }, ctx(2_100))

    // The author edits the file while the worker runs. The host has not re-read it,
    // so the binding still carries the OLD watermark.
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{ id: 'cov', headline: 'Coverage — I rewrote this' }]))

    const done = await svc.completeRefresh('sf-1', {
      jobId: 'job-1',
      expectedRev: docStore.getSurface('sf-1')!.rev,
      observedGeneration: docStore.getSurface('sf-1')!.source!.generation,
      content: { headline: 'Coverage 92%' },
    }, ctx(3_000))

    expect(done.ok).toBe(false)
    expect(!done.ok && done.error.reason).toBe('superseded')
    // The author's edit is untouched, and the Surface is pending rather than failed.
    const entry = (JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[])[0]!
    expect(entry.headline).toBe('Coverage — I rewrote this')
    expect(docStore.getSurface('sf-1')!.freshness.phase).toBe('possibly-stale')
    rmSync(dir, { recursive: true, force: true })
  })
})
