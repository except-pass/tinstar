import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDeployment, recordSmoke, runningSha } from '../../scripts/deploy/review-handoff.mjs'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const sha = 'a'.repeat(40), old = 'b'.repeat(40), head = 'c'.repeat(40)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-deploy-')); roots.push(root)
  await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: ['/fixture'] } }))
  const env = { TINSTAR_CONFIG_HOME: root, TINSTAR_DEPLOY_SOURCE: root, TINSTAR_PREVIOUS_DEPLOYED_SHA: old, TINSTAR_BRIDGE_URL: 'http://preview.test' }
  const execute = vi.fn((command: string, args: string[]) => {
    if (args.includes('rev-parse') || args.includes('rev-list')) return sha
    if (command === 'gh-axi') return `rows: ${JSON.stringify(JSON.stringify([{ url: 'https://github.com/except-pass/tinstar/pull/999', head, mergeSha: sha }]))}`
    return ''
  })
  return { root, env, execute }
}
it('records actual delta PR membership and keeps it on repeated deployment of the same SHA', async () => {
  const f = await fixture()
  const first = await recordDeployment(f.env, f.execute)
  expect(first).toMatchObject({ oldSha: old, newSha: sha, membershipComplete: true, ownerHome: '/fixture', pulls: [{ head, mergeSha: sha }] })
  expect(await recordDeployment({ ...f.env, TINSTAR_PREVIOUS_DEPLOYED_SHA: sha }, f.execute)).toMatchObject({ oldSha: old, pulls: first.pulls })
})
it('never guesses a previous running revision or direct-commit membership', async () => {
  const f = await fixture()
  expect(await recordDeployment({ ...f.env, TINSTAR_PREVIOUS_DEPLOYED_SHA: 'unknown' }, f.execute)).toMatchObject({ oldSha: null, membershipComplete: false })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  expect(await runningSha(f.env)).toBeNull()
})
it('records smoke only for the matching running build and exposes unresolved handoff without deleting health evidence', async () => {
  const f = await fixture(); await recordDeployment(f.env, f.execute)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/api/deployment') ? { ok: true, data: { sha } } : { ok: true, data: { reviewExceptions: [{ deployedSha: sha }] } })))
  await expect(recordSmoke(f.env)).rejects.toThrow('unresolved')
  const rows = (await readFile(join(f.root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(rows.at(-1)).toMatchObject({ action: 'floor-smoke', newSha: sha, passed: true })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: { sha: old } })))
  await expect(recordSmoke(f.env)).rejects.toThrow('does not match')
  expect((await readFile(join(f.root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(rows.length)
})
