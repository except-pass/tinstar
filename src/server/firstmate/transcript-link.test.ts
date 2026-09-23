import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLinkedTranscript, SPAWN_SKEW_SEC } from './transcript-link'

const WT = '/wt/1/webapp'
const iso = (sec: number) => new Date(sec * 1000).toISOString()

describe('findLinkedTranscript', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fm-link-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Write a transcript whose first record is `first`; `appendedAt` sets its mtime. */
  function transcript(id: string, first: Record<string, unknown>, appendedAt: number, preamble: object[] = []) {
    const lines = [...preamble, { type: 'user', cwd: WT, isSidechain: false, entrypoint: 'claude-desktop', ...first }]
    const p = join(dir, `${id}.jsonl`)
    writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    utimesSync(p, appendedAt, appendedAt)
  }
  const link = (spawnSec: number | null, override?: string) =>
    findLinkedTranscript({ worktree: WT, spawnSec, projectDir: dir, override })

  it('skips the previous task that shared the worktree slot, picks the newer one', () => {
    transcript('aaaaaaaa-old', { timestamp: iso(1000) }, 5000)
    transcript('bbbbbbbb-new', { timestamp: iso(9000) }, 9500)
    expect(link(9000)?.conversationId).toBe('bbbbbbbb-new')
  })

  it('accepts a first record up to the skew before the spawn time, not beyond', () => {
    transcript('cccccccc-skew', { timestamp: iso(9000 - SPAWN_SKEW_SEC + 1) }, 9500)
    expect(link(9000)?.conversationId).toBe('cccccccc-skew')
    transcript('dddddddd-early', { timestamp: iso(9000 - SPAWN_SKEW_SEC - 5) }, 9900)
    expect(link(9000)?.conversationId).toBe('cccccccc-skew')
  })

  it('with a later spawn in the same worktree, only transcripts started before it qualify', () => {
    transcript('aaaaaaaa-mine', { timestamp: iso(1000) }, 2000)
    transcript('bbbbbbbb-next', { timestamp: iso(5000) }, 6000)
    expect(findLinkedTranscript({ worktree: WT, spawnSec: 1000, nextSpawnSec: 5000, projectDir: dir })?.conversationId).toBe('aaaaaaaa-mine')
    expect(findLinkedTranscript({ worktree: WT, spawnSec: 5000, projectDir: dir })?.conversationId).toBe('bbbbbbbb-next')
  })

  it('picks the most recently appended candidate (relaunch, /clear)', () => {
    transcript('eeeeeeee-first', { timestamp: iso(9000) }, 9100)
    transcript('ffffffff-second', { timestamp: iso(9200) }, 9800)
    expect(link(9000)?.conversationId).toBe('ffffffff-second')
  })

  it('rejects wrong cwd, sidechains and headless sdk entrypoints', () => {
    transcript('11111111-cwd', { timestamp: iso(9000), cwd: '/somewhere/else' }, 9900)
    transcript('22222222-side', { timestamp: iso(9000), isSidechain: true }, 9900)
    transcript('33333333-sdk', { timestamp: iso(9000), entrypoint: 'sdk-cli' }, 9900)
    expect(link(9000)).toBeNull()
    transcript('44444444-good', { timestamp: iso(9000) }, 9100)
    expect(link(9000)?.conversationId).toBe('44444444-good')
  })

  it('judges the first user/assistant record, ignoring metadata lines before it', () => {
    transcript('55555555-meta', { timestamp: iso(9000) }, 9100, [{ type: 'file-history-snapshot' }, { type: 'summary' }])
    expect(link(9000)?.conversationId).toBe('55555555-meta')
  })

  it('without a spawn time any interactive transcript for the worktree qualifies', () => {
    transcript('66666666-any', { timestamp: iso(1) }, 100)
    expect(link(null)?.conversationId).toBe('66666666-any')
  })

  it('returns null for a missing directory and ignores non-jsonl files and subdirectories', () => {
    expect(findLinkedTranscript({ worktree: WT, spawnSec: 1, projectDir: join(dir, 'nope') })).toBeNull()
    mkdirSync(join(dir, 'sub.jsonl'))
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(link(1)).toBeNull()
  })

  it('a manual override wins, needs no heuristic match, and rejects path-like ids', () => {
    transcript('77777777-auto', { timestamp: iso(9000) }, 9900)
    transcript('88888888-manual', { timestamp: iso(1), cwd: '/other' }, 100)
    const l = link(9000, '88888888-manual')
    expect(l).toMatchObject({ conversationId: '88888888-manual', source: 'manual' })
    expect(link(9000, '../../etc/passwd')).toBeNull()
    expect(link(9000, '99999999-missing')).toBeNull()
  })
})
