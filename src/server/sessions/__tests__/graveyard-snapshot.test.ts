import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  graveyardSnapshotPath,
  snapshotTranscript,
  hasGraveyardSnapshot,
  deleteGraveyardSnapshot,
  placeTranscriptAt,
  reviveWorkdir,
  deleteReviveWorkdir,
} from '../graveyard-snapshot'

function withTmp<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'gy-snap-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('graveyard-snapshot', () => {
  it('snapshots a transcript into the config-root store and finds it', () => {
    withTmp(root => {
      const src = join(root, 'src.jsonl')
      writeFileSync(src, '{"hi":1}\n')
      expect(snapshotTranscript(root, 'conv-1', src)).toBe(true)
      expect(hasGraveyardSnapshot(root, 'conv-1')).toBe(true)
      expect(readFileSync(graveyardSnapshotPath(root, 'conv-1'), 'utf-8')).toContain('hi')
    })
  })

  it('returns false (no throw) when the source is missing', () => {
    withTmp(root => {
      expect(snapshotTranscript(root, 'conv-x', join(root, 'nope.jsonl'))).toBe(false)
      expect(snapshotTranscript(root, 'conv-x', null)).toBe(false)
      expect(hasGraveyardSnapshot(root, 'conv-x')).toBe(false)
    })
  })

  it('survives a simulated session-dir removal (lives under root, not the session dir)', () => {
    withTmp(root => {
      const sessionDir = join(root, 'sessions', 'askviktor')
      mkdirSync(sessionDir, { recursive: true })
      const src = join(sessionDir, 't.jsonl')
      writeFileSync(src, 'x')
      snapshotTranscript(root, 'conv-2', src)
      rmSync(join(root, 'sessions'), { recursive: true, force: true }) // session dir gone
      expect(hasGraveyardSnapshot(root, 'conv-2')).toBe(true)
    })
  })

  it('purge deletes the snapshot; a second delete is a no-op', () => {
    withTmp(root => {
      const src = join(root, 's.jsonl'); writeFileSync(src, 'x')
      snapshotTranscript(root, 'conv-3', src)
      deleteGraveyardSnapshot(root, 'conv-3')
      expect(hasGraveyardSnapshot(root, 'conv-3')).toBe(false)
      expect(() => deleteGraveyardSnapshot(root, 'conv-3')).not.toThrow()
    })
  })

  it('placeTranscriptAt copies source to dest when absent, and is a no-op when present', () => {
    withTmp(root => {
      const src = join(root, 'from.jsonl'); writeFileSync(src, 'payload')
      const dest = join(root, 'projects', 'encoded-cwd', 'conv-4.jsonl')
      expect(placeTranscriptAt(dest, src)).toBe(true)
      expect(readFileSync(dest, 'utf-8')).toBe('payload')
      // Already present → no-op true, and a null source doesn't clobber it.
      expect(placeTranscriptAt(dest, null)).toBe(true)
      expect(existsSync(dest)).toBe(true)
    })
  })

  it('placeTranscriptAt returns false when neither dest nor source exists', () => {
    withTmp(root => {
      expect(placeTranscriptAt(join(root, 'x.jsonl'), null)).toBe(false)
      expect(placeTranscriptAt(join(root, 'x.jsonl'), join(root, 'missing.jsonl'))).toBe(false)
    })
  })

  it('deleteReviveWorkdir removes the revived-session fallback cwd; absent is a no-op', () => {
    withTmp(root => {
      const wd = reviveWorkdir(root, 'askviktor-necro')
      mkdirSync(wd, { recursive: true })
      writeFileSync(join(wd, 'transcript.jsonl'), 'x')
      expect(existsSync(wd)).toBe(true)
      deleteReviveWorkdir(root, 'askviktor-necro')
      expect(existsSync(wd)).toBe(false)
      expect(() => deleteReviveWorkdir(root, 'askviktor-necro')).not.toThrow()
    })
  })
})
