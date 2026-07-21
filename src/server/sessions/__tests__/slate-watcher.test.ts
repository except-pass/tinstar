// U4 — SlateWatcher. Reads `.tinstar/slate/*.json`, validates through the notices
// `parseA2uiContent` funnel, and projects onto the run via applyRunSlateProjection.
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
import type { PointInput } from '../../stores/slate'
import { log } from '../../logger'

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

  const applyRunSlateProjection = vi.fn<(runId: string, inputs: PointInput[], now?: number) => void>()
  const docStore = { applyRunSlateProjection }

  let liveRuns: LiveRun[] = runs ?? [{ runId, workdir }]
  const setLiveRuns = (r: LiveRun[]) => { liveRuns = r }

  const watcher = new SlateWatcher({
    docStore,
    listLiveRuns: () => liveRuns,
    fs,
    timers,
  })

  return {
    root, runId, workdir, slateDir, watcher, applyRunSlateProjection,
    watchCbs, fireDebounce, setLiveRuns, getOpenWatches: () => openWatches,
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

  it('projects a valid surface file onto the run', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'Ship it?', content: validContent }])

    await harness.watcher.pollOnce()

    expect(harness.applyRunSlateProjection).toHaveBeenCalledTimes(1)
    const [runId, inputs] = harness.applyRunSlateProjection.mock.calls[0]!
    expect(runId).toBe(harness.runId)
    expect(inputs).toEqual([{ headline: 'Ship it?', content: validContent }])
  })

  it('flattens multiple files by filename then array index (stable order)', async () => {
    writeSurfaces(harness.slateDir, 'b.json', [{ headline: 'B1' }, { headline: 'B2' }])
    writeSurfaces(harness.slateDir, 'a.json', { headline: 'A1' }) // single object → one entry

    await harness.watcher.pollOnce()

    const inputs = harness.applyRunSlateProjection.mock.calls[0]![1]
    expect(inputs.map((p) => p.headline)).toEqual(['A1', 'B1', 'B2'])
  })

  it('retains the prior projection on invalid JSON and logs once (R10)', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'valid' }])
    await harness.watcher.pollOnce()
    expect(harness.applyRunSlateProjection).toHaveBeenCalledTimes(1)

    writeSurfaces(harness.slateDir, 'a.json', '{ this is not json')
    await harness.watcher.pollOnce() // torn → retain (no new projection), log once
    await harness.watcher.pollOnce() // still torn → still retain, but do NOT log again

    expect(harness.applyRunSlateProjection).toHaveBeenCalledTimes(1) // retained, not cleared
    const retainWarns = warn.mock.calls.filter(
      ([tag, msg]) => tag === 'slate-watcher' && /retaining last-valid/.test(String(msg)),
    )
    expect(retainWarns).toHaveLength(1)
  })

  it('drops a schema-invalid entry but keeps the valid ones (R10)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [
      { headline: 'good', content: validContent },
      { headline: 'bad', content: { root: 'root', components: [] } }, // fails parseA2uiContent
      { content: validContent }, // missing headline → dropped
    ])

    await harness.watcher.pollOnce()

    const inputs = harness.applyRunSlateProjection.mock.calls[0]![1]
    expect(inputs.map((p) => p.headline)).toEqual(['good'])
  })

  it('skips an oversized file by stat but keeps the valid siblings (R10)', async () => {
    const big = 'x'.repeat(40 * 1024)
    writeSurfaces(harness.slateDir, 'big.json', JSON.stringify([{ headline: 'huge', misc: big }]))
    writeSurfaces(harness.slateDir, 'small.json', [{ headline: 'kept' }])

    await harness.watcher.pollOnce()

    const inputs = harness.applyRunSlateProjection.mock.calls[0]![1]
    expect(inputs.map((p) => p.headline)).toEqual(['kept'])
  })

  it('clears when files are unlinked (R11)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'present' }])
    await harness.watcher.pollOnce()
    expect(harness.applyRunSlateProjection.mock.calls[0]![1]).toHaveLength(1)

    rmSync(join(harness.slateDir, 'a.json'))
    await harness.watcher.pollOnce()

    expect(harness.applyRunSlateProjection).toHaveBeenLastCalledWith(harness.runId, [])
  })

  it('clears on an explicit empty array (R11)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [])
    await harness.watcher.pollOnce()
    expect(harness.applyRunSlateProjection).toHaveBeenLastCalledWith(harness.runId, [])
  })

  it('retains on a zero-byte file — a torn write is not a clear (R11)', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'present' }])
    await harness.watcher.pollOnce()
    expect(harness.applyRunSlateProjection).toHaveBeenCalledTimes(1)

    writeSurfaces(harness.slateDir, 'a.json', '') // zero-byte torn write
    await harness.watcher.pollOnce()

    // Retained: the mutator was NOT called again (last-valid kept), NOT cleared with [].
    expect(harness.applyRunSlateProjection).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of fs.watch events into one projection', async () => {
    writeSurfaces(harness.slateDir, 'a.json', [{ headline: 'x' }])
    // First poll registers the watch (and does the poll-floor projection).
    await harness.watcher.pollOnce()
    harness.applyRunSlateProjection.mockClear()

    expect(harness.watchCbs.length).toBeGreaterThan(0)
    const onChange = harness.watchCbs[0]!
    // A storm of writes fires the watch many times before the debounce elapses.
    for (let i = 0; i < 8; i++) onChange()
    expect(harness.applyRunSlateProjection).not.toHaveBeenCalled() // nothing yet — debounced

    harness.fireDebounce() // one debounce flush
    await vi.waitFor(() => expect(harness.applyRunSlateProjection).toHaveBeenCalledTimes(1))
  })

  it('tears down the watch when a run is no longer live (no descriptor leak)', async () => {
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

    const inputs = harness.applyRunSlateProjection.mock.calls[0]![1]
    expect(inputs.map((p) => p.headline)).toEqual(['real']) // symlink ignored
  })

  it('treats a missing slate dir as no error (ENOENT is normal)', async () => {
    rmSync(join(harness.workdir, '.tinstar'), { recursive: true, force: true })
    await expect(harness.watcher.pollOnce()).resolves.toBeUndefined()
    // Missing dir → empty projection (clear), never a thrown error.
    expect(harness.applyRunSlateProjection).toHaveBeenLastCalledWith(harness.runId, [])
  })
})
