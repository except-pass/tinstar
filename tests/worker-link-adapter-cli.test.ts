import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile), dirs: string[] = []
const cli = (args: string[]) => exec(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/worker-link-adapter.ts'), ...args], { timeout: 20_000 })
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('coordinator adapter CLI', () => {
  it('runs report-only with synthetic configuration without opening the write-token path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinstar-adapter-cli-')); dirs.push(dir)
    await writeFile(join(dir, 'config.json'), JSON.stringify({ reconciliation: { fleet: [] } }))
    const audit = join(dir, 'audit.jsonl')
    const result = await cli(['--config-home', dir, '--audit-file', audit, '--write-token-file', join(dir, 'does-not-exist')])
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'report-only', stopped: false, plannedWrites: [] })
    expect(result.stderr).toBe('')
    expect(await readFile(audit, 'utf8')).toBe('')
  })
  it('refuses apply without explicit batch bounds before reading source or token paths', async () => {
    await expect(cli(['--apply', '--audit-file', '/nonexistent/audit', '--write-token-file', '/nonexistent/token'])).rejects.toMatchObject({
      code: 1, stderr: 'Worker-link adapter failed; check arguments, audit path, source coverage and credential access.\n',
    })
  })
  it('exposes usage through the executable interface', async () => {
    const { stdout } = await cli(['--help'])
    expect(stdout).toContain('--apply --max-cards 1..5 --write-token-file FILE')
  })
})
