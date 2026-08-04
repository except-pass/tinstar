// SlateWatcher. Reads `.tinstar/slate/*.json`, validates through the notices
// `parseA2uiContent` funnel, and hands the whole directory to the canonical source
// reconciler as one epoch (plan U2). What the epoch then DOES is
// `source-reconciler.test.ts`; this file is about what the filesystem produces.
//
// The tests use a real temp dir for file I/O (so the read/stat/JSON path is exercised
// end-to-end) but inject the fs.watch + timer seams so events and the debounce are
// driven deterministically — no real inotify, no real clocks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { readdir, lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SlateWatcher, type SlateFs, type SlateTimers, type LiveRun } from '../slate-watcher'
import type { SlateSourceEpoch } from '../../surfaces/source-reconciler'
import { log } from '../../logger'
import { synthesizeId } from '../../stores/slate'
import { parseA2uiContent } from '../../../a2ui/schema'

const validContent = {
  root: 'root',
  components: [{ id: 'root', component: 'Text', text: 'hi' }],
}

function makeHarness(runs?: LiveRun[]) {
  const root = mkdtempSync(join(tmpdir(), 'slate-watch-'))
  const runId = 'run-1'
  const workdir = join(root, 'wt')
  const slateDir = join(workdir, '.tinstar', 'slate')
  mkdirSync(slateDir, { recursive: true })

  // fs.watch is captured (no real inotify); everything else hits the real temp dir.
  const watchCbs: Array<() => void> = []
  let openWatches = 0
  const fs: SlateFs = {
    existsSync,
    watch: (_dir, onChange) => {
      watchCbs.push(onChange)
      openWatches++
      return { close: () => { openWatches-- } }
    },
    readdir: (d) => readdir(d),
    lstat: async (p) => {
      const s = await lstat(p)
      return { size: s.size, isFile: s.isFile() }
    },
    readFile: (p) => readFile(p, 'utf8'),
  }

  // Capturing timer seam: setTimeout stores the callback for the test to fire.
  let timeoutCb: (() => void) | null = null
  const timers: SlateTimers = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { timeoutCb = fn; return 1 },
    clearTimeout: () => { timeoutCb = null },
  }
  const fireDebounce = () => { const cb = timeoutCb; timeoutCb = null; cb?.() }

  const epochs: SlateSourceEpoch[] = []
  const applyEpoch = vi.fn<(e: SlateSourceEpoch) => Promise<unknown>>(async (e) => {
    epochs.push(e)
    return { observed: e.entries.length, created: 0, updated: 0, missing: 0, duplicates: [], refusals: [] }
  })

  let liveRuns: LiveRun[] = runs ?? [{ runId, workdir }]
  const setLiveRuns = (r: LiveRun[]) => { liveRuns = r }
  let boundRuns: LiveRun[] = []
  const setBoundRuns = (r: LiveRun[]) => { boundRuns = r }
  let context: { spaceId: string; incarnation: string; rootSurfaceId: string } | null =
    { spaceId: 'spc-a', incarnation: 'inc-1', rootSurfaceId: 'sf-root' }
  const setContext = (c: typeof context) => { context = c }

  const watcher = new SlateWatcher({
    listLiveRuns: () => liveRuns,
    listBoundRuns: () => boundRuns,
    runContext: () => context,
    applyEpoch,
    fs,
    timers,
  })

  return {
    root, runId, workdir, slateDir, watcher, applyEpoch, epochs,
    watchCbs, fireDebounce, setLiveRuns, setBoundRuns, setContext,
    getOpenWatches: () => openWatches,
    last: () => epochs[epochs.length - 1]!,
    headlines: (i = 0) => epochs[i]!.entries.map(e => e.content.headline),
  }
}

function writeSurfaces(slateDir: string, name: string, value: unknown) {
  writeFileSync(join(slateDir, name), typeof value === 'string' ? value : JSON.stringify(value))
}

describe('SlateWatcher', () => {
  let harness: ReturnType<typeof makeHarness>

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = makeHarness()
  })

  afterEach(() => {
    harness.watcher.stop()
    rmSync(harness.root, { recursive: true, force: true })
  })

  it('reconciles a valid surface file as one epoch, with a binding address per entry', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'ship', headline: 'Ship it?', content: validContent }])

    await harness.watcher.pollOnce()

    expect(harness.applyEpoch).toHaveBeenCalledTimes(1)
    const epoch = harness.last()
    expect(epoch.runId).toBe(harness.runId)
    expect(epoch.worktree).toBe(harness.workdir)
    expect(epoch.incarnation).toBe('inc-1')
    expect(epoch.rootSurfaceId).toBe('sf-root')
    expect(epoch.unreadable).toEqual([])
    expect(epoch.entries).toHaveLength(1)
    expect(epoch.entries[0]).toMatchObject({
      localId: 'ship',
      file: 'a.json',
      author: 'agent',
      content: { headline: 'Ship it?', body: validContent },
    })
    expect(epoch.entries[0]!.watermark).toMatch(/^sha256:/)
  })

  it('reads the author proposal off a file entry, host-stamping its time (fix 4)', async () => {
    // The file→canonical ingress leg. An unusable claim leaves the surface WITHOUT
    // one rather than dropping the entry — same drop-don't-fail posture as every
    // other optional field.
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'good', headline: 'D6', proposal: { state: 'working', detail: 'half a day' } },
      { id: 'bogus', headline: 'D7', proposal: { state: 'shipped' } },
      { id: 'none', headline: 'D8' },
    ])

    await harness.watcher.pollOnce()

    const byId = new Map(harness.last().entries.map(e => [e.localId, e]))
    expect(byId.get('good')!.content.proposal).toMatchObject({ state: 'working', detail: 'half a day' })
    // Host-stamped, never author-supplied: a card renders an elapsed time from this.
    expect(typeof byId.get('good')!.content.proposal!.at).toBe('number')
    expect(byId.get('bogus')!.content.proposal).toBeUndefined()
    expect(byId.get('bogus')!.content.headline).toBe('D7')   // the entry still projects
    expect(byId.get('none')!.content.proposal).toBeUndefined()
  })

  it('synthesizes the SAME local id the legacy projection did for an id-less entry', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'no id here', content: validContent }])

    await harness.watcher.pollOnce()

    // Identity continuity across the U1->U2 upgrade depends on this exactly matching
    // what `SlateStore.applyProjection` assigned, or every id-less surface arrives as
    // a stranger with no thread. Hashed over the PARSED content, as the legacy path
    // also was — it ran the same `toPointInput` gate first.
    expect(harness.last().entries[0]!.localId).toBe(synthesizeId(harness.runId, {
      headline: 'no id here',
      content: parseA2uiContent(validContent)!,
    }))
  })

  it('skips a run whose canonical context cannot be resolved, and says so once', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    harness.setContext(null)
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'x' }])

    await harness.watcher.pollOnce()
    await harness.watcher.pollOnce()

    expect(harness.applyEpoch).not.toHaveBeenCalled()
    expect(warn.mock.calls.filter(c => /no canonical context/.test(String(c[1])))).toHaveLength(1)
    warn.mockRestore()
  })

  it('keeps watching a run that is no longer live but still has a persisted binding', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'x', headline: 'x' }])
    harness.setLiveRuns([])
    harness.setBoundRuns([{ runId: harness.runId, workdir: harness.workdir }])

    await harness.watcher.pollOnce()

    expect(harness.applyEpoch).toHaveBeenCalledTimes(1)
    expect(harness.getOpenWatches()).toBe(1)
  })

  it('flattens multiple files by filename then array index (stable order)', async () => {
    writeSurfaces(harness.slateDir, 'b.json', [{ headline: 'B1' }, { headline: 'B2' }])
    writeSurfaces(harness.slateDir, 'a.json', { headline: 'A1' }) // single object → one entry

    await harness.watcher.pollOnce()

    expect(harness.headlines()).toEqual(['A1', 'B1', 'B2'])
  })

  it('reconciles nothing on invalid JSON and logs once (R10)', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'valid' }])
    await harness.watcher.pollOnce()
    expect(harness.applyEpoch).toHaveBeenCalledTimes(1)

    writeSurfaces(harness.slateDir, 'a.json', '{ this is not json')
    await harness.watcher.pollOnce() // torn → retain (no epoch at all), log once
    await harness.watcher.pollOnce() // still torn → still retain, but do NOT log again

    expect(harness.applyEpoch).toHaveBeenCalledTimes(1) // no epoch: nothing marked missing
    const retainWarns = warn.mock.calls.filter(
      ([tag, msg]) => tag === 'slate-watcher' && /retaining last-valid/.test(String(msg)),
    )
    expect(retainWarns).toHaveLength(1)
    warn.mockRestore()
  })

  it('names a file it could not read so its bindings are not treated as omitted', async () => {
    writeSurfaces(harness.slateDir, 'good.json', [{ id: 'kept', headline: 'kept' }])
    writeSurfaces(harness.slateDir, 'torn.json', '{ nope')

    await harness.watcher.pollOnce()

    const epoch = harness.last()
    expect(epoch.entries.map(e => e.localId)).toEqual(['kept'])
    expect(epoch.unreadable).toEqual(['torn.json'])
  })

  it('names the file of a schema-invalid ENTRY too, so its last-valid record survives', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'good', headline: 'good' },
      { id: 'bad', headline: 'bad', content: { root: 'root', components: [] } },
    ])

    await harness.watcher.pollOnce()

    expect(harness.last().entries.map(e => e.localId)).toEqual(['good'])
    expect(harness.last().unreadable).toEqual(['a.json'])
  })

  it('drops a schema-invalid entry but keeps the valid ones (R10)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { headline: 'good', content: validContent },
      { headline: 'bad', content: { root: 'root', components: [] } }, // fails parseA2uiContent
      { content: validContent }, // missing headline → dropped
    ])

    await harness.watcher.pollOnce()

    expect(harness.headlines()).toEqual(['good'])
  })

  // The Objective (S2) is USER-owned and lives at a RESERVED id. The file-in channel
  // is the AGENT's; letting it author that id would let a repo file hijack the user's
  // goal — and, since file points are retractable, delete it on the next projection.
  it('DROPS a file entry claiming the reserved `objective` id, keeping its siblings', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'objective', headline: 'I am the goal now', content: validContent },
      { id: 'real', headline: 'an ordinary surface' },
    ])

    await harness.watcher.pollOnce()

    expect(harness.last().entries.map(e => e.localId)).toEqual(['real'])
  })

  it('treats a file of ONLY an objective entry as unusable — retains, never reconciles it', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'seeded', id: 'seeded' }])
    await harness.watcher.pollOnce()
    expect(harness.applyEpoch).toHaveBeenCalledTimes(1)

    // Zero valid entries + something dropped ⇒ the same retain path a torn file takes,
    // and no `objective` Surface is ever created.
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'objective', headline: 'hijack' }])
    await harness.watcher.pollOnce()

    expect(harness.applyEpoch).toHaveBeenCalledTimes(1) // no second epoch
  })

  // The drop must not be SILENT: an author whose surface simply never appears has no
  // error, no exit code, nothing to find. But polling is every few seconds, so the warn
  // is once-per-file, not once-per-poll.
  it('WARNS about the reserved id — once, not on every poll', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      writeSurfaces(harness.slateDir, 'a.json', [
        { id: 'objective', headline: 'hijack' },
        { id: 'real', headline: 'an ordinary surface' },
      ])

      await harness.watcher.pollOnce()
      await harness.watcher.pollOnce()
      await harness.watcher.pollOnce()

      const reserved = warn.mock.calls.filter(c => String(c[1]).includes('RESERVED'))
      expect(reserved).toHaveLength(1)
      expect(String(reserved[0]![1])).toContain('a.json')

      // Fixing the file and regressing warns again — the ledger tracks the CURRENT state.
      writeSurfaces(harness.slateDir, 'a.json', [{ id: 'real', headline: 'an ordinary surface' }])
      await harness.watcher.pollOnce()
      writeSurfaces(harness.slateDir, 'a.json', [
        { id: 'objective', headline: 'hijack again' },
        { id: 'real', headline: 'an ordinary surface' },
      ])
      await harness.watcher.pollOnce()

      expect(warn.mock.calls.filter(c => String(c[1]).includes('RESERVED'))).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('skips an oversized file by stat but keeps the valid siblings (R10)', async () => {
    const big = 'x'.repeat(40 * 1024)
    writeSurfaces(harness.slateDir, 'big.json', JSON.stringify([{ headline: 'huge', misc: big }]))
    writeSurfaces(harness.slateDir, 'small.json', [{ headline: 'kept' }])

    await harness.watcher.pollOnce()

    expect(harness.headlines()).toEqual(['kept'])
    expect(harness.last().unreadable).toEqual(['big.json'])
  })

  it('reports an EMPTY epoch when files are unlinked — the omission signal (R11)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'present' }])
    await harness.watcher.pollOnce()
    expect(harness.epochs[0]!.entries).toHaveLength(1)

    rmSync(join(harness.slateDir, 'a.json'))
    await harness.watcher.pollOnce()

    // An epoch IS applied, with nothing in it and nothing unreadable — which is what
    // lets the reconciler tell "the file went away" from "the file would not read".
    expect(harness.last().entries).toEqual([])
    expect(harness.last().unreadable).toEqual([])
  })

  it('reports an empty epoch on an explicit empty array (R11)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [])
    await harness.watcher.pollOnce()
    expect(harness.last().entries).toEqual([])
    expect(harness.last().unreadable).toEqual([])
  })

  it('retains on a zero-byte file — a torn write is not an omission (R11)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'present' }])
    await harness.watcher.pollOnce()
    expect(harness.applyEpoch).toHaveBeenCalledTimes(1)

    writeSurfaces(harness.slateDir, 'a.json', '') // zero-byte torn write
    await harness.watcher.pollOnce()

    // Retained: no epoch at all, so nothing can be marked missing.
    expect(harness.applyEpoch).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of fs.watch events into one epoch', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'x' }])
    // First poll registers the watch (and does the poll-floor epoch).
    await harness.watcher.pollOnce()
    harness.applyEpoch.mockClear()

    expect(harness.watchCbs.length).toBeGreaterThan(0)
    const onChange = harness.watchCbs[0]!
    // A storm of writes fires the watch many times before the debounce elapses.
    for (let i = 0; i < 8; i++) onChange()
    expect(harness.applyEpoch).not.toHaveBeenCalled() // nothing yet — debounced

    harness.fireDebounce() // one debounce flush
    await vi.waitFor(() => expect(harness.applyEpoch).toHaveBeenCalledTimes(1))
  })

  // A rename arrives as {create, remove} or {remove, create} depending on platform
  // and debounce boundary. Both collapse into ONE directory read, so the reconciler
  // never sees the half-state where the entry only exists as a removal.
  it('presents a rename as one epoch regardless of event order', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'ship', headline: 'Ship it?' }])
    await harness.watcher.pollOnce()
    expect(harness.last().entries[0]!.file).toBe('a.json')

    rmSync(join(harness.slateDir, 'a.json'))
    writeSurfaces(harness.slateDir, 'b.json', [{ id: 'ship', headline: 'Ship it?' }])
    const onChange = harness.watchCbs[0]!
    onChange() // remove
    onChange() // create
    harness.fireDebounce()

    await vi.waitFor(() => expect(harness.applyEpoch).toHaveBeenCalledTimes(2))
    expect(harness.last().entries).toHaveLength(1)
    expect(harness.last().entries[0]).toMatchObject({ localId: 'ship', file: 'b.json' })
  })

  it('tears down the watch when a run is neither live nor bound (no descriptor leak)', async () => {
    await harness.watcher.pollOnce()
    expect(harness.getOpenWatches()).toBe(1)

    harness.setLiveRuns([])
    await harness.watcher.pollOnce()

    expect(harness.getOpenWatches()).toBe(0)
  })

  it('ignores a symlink (isFile false) — no escape out of the worktree', async () => {
    // A secret file outside the slate dir, reachable only via a symlink inside it.
    const secret = join(harness.root, 'secret.json')
    writeFileSync(secret, JSON.stringify([{ headline: 'leaked' }]))
    symlinkSync(secret, join(harness.slateDir, 'link.json'))
    writeSurfaces(harness.slateDir, 'real.json', [{ headline: 'real' }])

    await harness.watcher.pollOnce()

    expect(harness.headlines()).toEqual(['real']) // symlink ignored
  })

  // `anchor` and `group` are still PARSED (a malformed one still drops the entry, and
  // both still ride the synthesized-id hash) but they no longer reach the canonical
  // model: the author ruled that the card-vs-row distinction `anchor` encodes does
  // not exist in the target model, and that grouping is a container Surface rather
  // than a field. A grouped set therefore renders as ordinary rows after U2.
  it('does not carry `group` or `anchor` into the canonical entry, and drops neither entry', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'q1', headline: 'Which path?', group: 'launch-qs' },
      { id: 'q2', headline: 'Who owns it?', anchor: { kind: 'surface', ref: 'diagram' } },
    ])

    await harness.watcher.pollOnce()

    const entries = harness.last().entries
    expect(entries.map(e => e.localId)).toEqual(['q1', 'q2'])
    expect(entries.every(e => !('group' in e) && !('anchor' in e))).toBe(true)
    expect(entries.every(e => Object.keys(e.content).join() === 'headline')).toBe(true)
  })

  it('still refuses a malformed `anchor` outright (the validation gate is unchanged)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'q1', headline: 'ok' },
      { id: 'q2', headline: 'bad anchor', anchor: { kind: 'nonsense' } },
    ])

    await harness.watcher.pollOnce()

    expect(harness.last().entries.map(e => e.localId)).toEqual(['q1'])
  })

  // --- Claims (plan U1, R1) ------------------------------------------------
  //
  // Everything here goes through the REAL file → `toPointInput` → source-entry
  // path. A test that handed the parser a pre-parsed claim would be asserting a
  // contract nothing upstream can produce.

  it('carries a well-formed claims array onto the source entry', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{
      id: 'roadmap',
      headline: 'Roadmap',
      claims: [
        { id: 'u1', witness: 'unit-landed', params: { unit: 'U1', plan: 'docs/plans/x.md' }, locus: 'repo' },
        { id: 'up', witness: 'http-status', params: { url: 'https://example.test/health' }, locus: 'infra' },
      ],
    }])

    await harness.watcher.pollOnce()

    expect(harness.last().entries[0]!.content.claims).toEqual([
      // Params come back key-sorted: reordering them in the file is a formatting
      // change, and the watermark hashes this structure.
      { id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' },
      { id: 'up', witness: 'http-status', params: { url: 'https://example.test/health' }, locus: 'infra' },
    ])
  })

  it('keeps `claims: []` and an absent `claims` as different answers', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'silent', headline: 'never said' },
      { id: 'checked', headline: 'checked, nothing witnessable', claims: [] },
    ])

    await harness.watcher.pollOnce()

    const [silent, checked] = harness.last().entries
    // Not `toBeUndefined()` on both: the key must be genuinely ABSENT on one and an
    // empty array on the other, because the egress adapter writes this field back
    // into the author's own file and the two mean opposite things there.
    expect('claims' in silent!.content).toBe(false)
    expect(checked!.content.claims).toEqual([])
    expect(silent!.watermark).not.toBe(checked!.watermark)
  })

  it('clears claims when a later write of the file omits them', async () => {
    const claims = [{ id: 'u1', witness: 'unit-landed', locus: 'repo', params: { plan: 'docs/plans/x.md', unit: 'U1' } }]
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'roadmap', headline: 'Roadmap', claims }])
    await harness.watcher.pollOnce()
    expect(harness.last().entries[0]!.content.claims).toHaveLength(1)

    // The file is the authority for authored content, so an omission is a deletion
    // — the same rule `recipe` and `refreshPolicy` already follow.
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'roadmap', headline: 'Roadmap' }])
    await harness.watcher.pollOnce()

    expect('claims' in harness.last().entries[0]!.content).toBe(false)
  })

  it('REFUSES an oversized claims list whole rather than truncating it', async () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ id: `c${i}`, witness: 'http-status', locus: 'infra' }))
    writeSurfaces(harness.slateDir, 'a.json', [{ id: 'big', headline: 'Too many claims', claims: many }])

    await harness.watcher.pollOnce()

    // The surface still projects (a bad declaration is not worth a missing card),
    // and it declares NOTHING — a prefix of 32 would have it report witnessed
    // against a list its author did not write.
    const entry = harness.last().entries[0]!
    expect(entry.localId).toBe('big')
    expect('claims' in entry.content).toBe(false)
  })

  it('drops an unusable claim, keeps its siblings, and keeps the surface', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{
      id: 'mixed',
      headline: 'Mixed',
      claims: [
        { id: 'ok', witness: 'http-status', params: { url: 'https://example.test' }, locus: 'infra' },
        { id: 'no-locus', witness: 'http-status' },
        { id: 'bad-locus', witness: 'http-status', locus: 'slate' },
        { id: 'nested', witness: 'http-status', locus: 'infra', params: { headers: { a: 'b' } } },
        { witness: 'http-status', locus: 'infra' },
        'not even an object',
        { id: 'ok', witness: 'http-status', locus: 'repo' }, // duplicate id — first wins
      ],
    }])

    await harness.watcher.pollOnce()

    const entry = harness.last().entries[0]!
    expect(entry.localId).toBe('mixed')
    expect(entry.content.claims).toEqual([
      { id: 'ok', witness: 'http-status', params: { url: 'https://example.test' }, locus: 'infra' },
    ])
  })

  // --- Claim refusals (plan U6, R3) ----------------------------------------

  it('carries the refusal for a mistyped witness kind onto the entry, with the surface intact', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{
      id: 'roadmap',
      headline: 'Roadmap — 3 of 8 landed',
      claims: [
        { id: 'u1', witness: 'unit-lands', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' },
        { id: 'up', witness: 'http-status', params: { url: 'https://example.test/health' }, locus: 'infra' },
      ],
    }])

    await harness.watcher.pollOnce()

    const entry = harness.last().entries[0]!
    // The NEW content, with the bad claim absent and its sibling kept (KTD5).
    expect(entry.content.headline).toBe('Roadmap — 3 of 8 landed')
    expect(entry.content.claims).toEqual([
      { id: 'up', witness: 'http-status', params: { url: 'https://example.test/health' }, locus: 'infra' },
    ])
    expect(entry.claimRefusals).toHaveLength(1)
    expect(entry.claimRefusals![0]).toMatch(/unit-lands/)
    // NOT unreadable. That path retains an entry's LAST-VALID projection, which is
    // the opposite of what a refused claim gets — the file is fine, one claim is not.
    expect(harness.last().unreadable).toEqual([])
  })

  it('refuses a claim whose parameters do not fit its kind, and drops the refusal when they do', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{
      id: 'roadmap', headline: 'Roadmap',
      claims: [{ id: 'u1', witness: 'unit-landed', params: { unit: 'U1' }, locus: 'repo' }],
    }])
    await harness.watcher.pollOnce()
    expect(harness.last().entries[0]!.claimRefusals![0]).toMatch(/params\.plan must be/)

    writeSurfaces(harness.slateDir, 'a.json', [{
      id: 'roadmap', headline: 'Roadmap',
      claims: [{ id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }],
    }])
    await harness.watcher.pollOnce()

    const fixed = harness.last().entries[0]!
    // Absent, not empty: an entry with nothing refused carries no refusal key at all.
    expect('claimRefusals' in fixed).toBe(false)
    expect(fixed.content.claims).toHaveLength(1)
  })

  it('marks only the entry that declared the bad claim', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { id: 'bad', headline: 'Bad', claims: [{ id: 'c', witness: 'nope', locus: 'repo' }] },
      { id: 'good', headline: 'Good', claims: [{ id: 'up', witness: 'http-status', params: { url: 'https://x.test/' }, locus: 'infra' }] },
      { id: 'silent', headline: 'Silent' },
    ])

    await harness.watcher.pollOnce()

    const [bad, good, silent] = harness.last().entries
    expect(bad!.claimRefusals).toHaveLength(1)
    expect('claimRefusals' in good!).toBe(false)
    expect('claimRefusals' in silent!).toBe(false)
  })

  it('treats a missing slate dir as no error (ENOENT is normal)', async () => {
    rmSync(join(harness.workdir, '.tinstar'), { recursive: true, force: true })
    await expect(harness.watcher.pollOnce()).resolves.toBeUndefined()
    // Missing dir → an empty epoch, never a thrown error.
    expect(harness.last().entries).toEqual([])
  })
})
