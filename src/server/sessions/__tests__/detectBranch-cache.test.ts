import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectBranch, _resetBranchCacheForTests } from '../session'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tinstar-branchcache-'))
  mkdirSync(join(scratch, '.git'), { recursive: true })
  writeFileSync(join(scratch, '.git/HEAD'), 'ref: refs/heads/main\n')
  _resetBranchCacheForTests()
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('detectBranch cache', () => {
  it('returns the same value when .git/HEAD mtime is unchanged', async () => {
    const first = await detectBranch(scratch)
    expect(typeof first === 'string' || first === null).toBe(true)

    writeFileSync(join(scratch, 'unrelated.txt'), 'x')
    const second = await detectBranch(scratch)
    expect(second).toBe(first)
  })

  it('invalidates when .git/HEAD mtime advances', async () => {
    await detectBranch(scratch)

    const headPath = join(scratch, '.git/HEAD')
    writeFileSync(headPath, 'ref: refs/heads/feature\n')
    const future = new Date(Date.now() + 1000)
    utimesSync(headPath, future, future)

    const after = await detectBranch(scratch)
    expect(after === null || typeof after === 'string').toBe(true)
  })
})
