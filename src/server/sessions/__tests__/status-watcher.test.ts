import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findNewestUnclaimedJsonl } from '../status-watcher'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tinstar-watcher-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function writeJsonl(convId: string, mtimeMs: number): string {
  const path = join(scratch, `${convId}.jsonl`)
  writeFileSync(path, '{}\n')
  const t = new Date(mtimeMs)
  utimesSync(path, t, t)
  return path
}

describe('findNewestUnclaimedJsonl', () => {
  it('returns null for missing dir', () => {
    expect(findNewestUnclaimedJsonl(join(scratch, 'nope'), new Set())).toBeNull()
  })

  it('returns null when dir has no .jsonl files', () => {
    writeFileSync(join(scratch, 'note.txt'), 'x')
    expect(findNewestUnclaimedJsonl(scratch, new Set())).toBeNull()
  })

  it('picks newest mtime when nothing is claimed', () => {
    writeJsonl('old', Date.now() - 60_000)
    writeJsonl('new', Date.now())
    expect(findNewestUnclaimedJsonl(scratch, new Set())?.convId).toBe('new')
  })

  it('skips claimed convIds even when they have newer mtime — the multi-agent fix', () => {
    // Scenario: two agents share a workdir. Peer agent's transcript ('peer')
    // is most recently active. Without the exclusion filter, this session
    // would adopt 'peer' and steal the peer's identity.
    writeJsonl('mine', Date.now() - 60_000)
    writeJsonl('peer', Date.now())
    const claimed = new Set(['peer'])
    expect(findNewestUnclaimedJsonl(scratch, claimed)?.convId).toBe('mine')
  })

  it('returns null when every .jsonl is claimed by a peer', () => {
    writeJsonl('a', Date.now())
    writeJsonl('b', Date.now() - 1000)
    expect(findNewestUnclaimedJsonl(scratch, new Set(['a', 'b']))).toBeNull()
  })

  it('handles /clear rotation: post-clear file is unclaimed and newest', () => {
    // Tracked = 'old'; user runs /clear; new file 'fresh' is created.
    // 'old' is *this* session's previous convId (not in claimed). Algorithm
    // returns 'fresh' because it's newer.
    writeJsonl('old', Date.now() - 60_000)
    writeJsonl('fresh', Date.now())
    expect(findNewestUnclaimedJsonl(scratch, new Set())?.convId).toBe('fresh')
  })

  it('with minBirthtimeMs filter: skips files born before session.created — symmetry break for cross-pollinated repair', () => {
    // Two sessions A and B share a workdir, both wound up tracking the same
    // peer convId. To repair without flopping back to the same wrong shared
    // value, each session filters candidates by `birthtime >= session.created`.
    //
    // Session A.created = T1, real file 'fileA' born T1+ε.
    // Session B.created = T2 (later), real file 'fileB' born T2+ε.
    // Both share the workdir. Each session's repair search excludes the
    // other's convId via `claimed`, AND excludes files born before its own
    // start. Result: A finds fileA, B finds fileB.
    const T1 = Date.now() - 600_000 // 10 min ago — session A start
    const T2 = Date.now() - 300_000 // 5 min ago  — session B start
    const fileA = join(scratch, 'fileA.jsonl')
    const fileB = join(scratch, 'fileB.jsonl')
    writeFileSync(fileA, '{}\n')
    writeFileSync(fileB, '{}\n')
    // We can't easily forge birthtime in tests (it's set by the kernel on
    // creation), so we simulate the comparison with mtime as a proxy: stat()
    // returns birthtimeMs == ctimeMs/mtimeMs on freshly-created files. By
    // setting mtime AND not modifying after, birthtime ≈ now for both files.
    // Instead of testing birthtime directly here, we test the behavior with
    // a `minBirthtimeMs` value that's clearly in the future — both files
    // should be excluded.
    expect(findNewestUnclaimedJsonl(scratch, new Set(), Date.now() + 60_000)).toBeNull()
    // And with a floor in the past, both should be candidates.
    expect(findNewestUnclaimedJsonl(scratch, new Set(), 0)).not.toBeNull()
    void T1
    void T2
  })
})
