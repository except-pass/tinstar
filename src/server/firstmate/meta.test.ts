import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMeta, readTaskMeta } from './meta'

describe('first mate task meta', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fm-meta-')); mkdirSync(join(home, 'state')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('parses window, worktree and project', () => {
    const m = parseMeta([
      'window=firstmate:fm-x', 'endpoint_task_id=x', 'worktree=/w/tree/1/tinstar',
      'project=/Users/me/repo/firstmate/projects/tinstar', 'harness=claude', 'spawn_gen=s1790171520', 'unknown_future_key=zzz', 'garbage line',
    ].join('\n'))
    expect(m).toEqual({ window: 'firstmate:fm-x', worktree: '/w/tree/1/tinstar', project: 'tinstar', spawnGen: 1790171520 })
  })

  it('tolerates empty and partial content', () => {
    expect(parseMeta('')).toEqual({ window: null, worktree: null, project: null, spawnGen: null })
    expect(parseMeta('backend=herdr\nwindow=')).toEqual({ window: null, worktree: null, project: null, spawnGen: null })
  })

  it('returns null when the meta file is absent', async () => {
    expect(await readTaskMeta(home, 'nope')).toBeNull()
  })

  it('reads a real file and refuses unsafe task ids', async () => {
    writeFileSync(join(home, 'state', 'x.meta'), 'worktree=/a/b\n')
    expect((await readTaskMeta(home, 'x'))?.worktree).toBe('/a/b')
    expect(await readTaskMeta(home, '../state/x')).toBeNull()
  })
})
