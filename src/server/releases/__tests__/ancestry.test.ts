import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkReleaseAncestry } from '../ancestry'
const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('uses real Git ancestry, refuses a wrong repo, detects reverts and keeps missing objects unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-ancestry-')); roots.push(root)
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim()
  await git('init'); await git('config', 'user.email', 'test@example.com'); await git('config', 'user.name', 'Release Test')
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git')
  await writeFile(join(root, 'feature'), 'base'); await git('add', 'feature'); await git('commit', '-m', 'base')
  const base = await git('rev-parse', 'HEAD')
  await writeFile(join(root, 'feature'), 'merged change'); await git('commit', '-am', 'squash merge')
  const merged = await git('rev-parse', 'HEAD')
  expect(await checkReleaseAncestry('owner/repo', root, merged, base)).toEqual({ state: 'not-ancestor' })
  expect(await checkReleaseAncestry('owner/repo', root, merged, merged)).toEqual({ state: 'ancestor' })
  expect(await checkReleaseAncestry('other/repo', root, merged, merged)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('different repository') })
  await git('revert', '--no-edit', merged)
  const reverted = await git('rev-parse', 'HEAD')
  expect(await checkReleaseAncestry('owner/repo', root, merged, reverted)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('reverts') })
  expect(await checkReleaseAncestry('owner/repo', root, 'f'.repeat(40), reverted)).toMatchObject({ state: 'unknown' })
  expect(await git('status', '--porcelain')).toBe('')
})
