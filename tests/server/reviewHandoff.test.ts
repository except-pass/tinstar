import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { recordLateEvidence, recordSmoke } from '../../scripts/deploy/review-handoff.mjs'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const sha = 'a'.repeat(40), current = 'b'.repeat(40), head = 'c'.repeat(40), card = 'd'.repeat(32)
const pull = 'https://github.com/except-pass/tinstar/pull/999'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'late-handoff-')); roots.push(root)
  const audit = join(root, 'deploy.blocked.audit.jsonl'), manifest = join(root, 'manifest.json')
  const deployment = { action: 'floor-deployment', id: `floor:${sha}`, time: '2026-11-11T00:00:00Z', oldSha: head, newSha: sha,
    pulls: [{ url: pull, head, mergeSha: sha }], membershipComplete: true, ownerHome: null, evidence: [], nonReviewable: [], warnings: [] }
  const newer = { ...deployment, id: `floor:${current}`, oldSha: sha, newSha: current }
  const review = { submission_key: 'late-one', deliverable_id: 'late-ui', summary: 'Review UI', pulls: [{ url: pull, head }],
    deployment_id: deployment.id, deployed_sha: sha, live_url: 'https://example.test/review', instructions: 'Inspect the panel',
    proof: { kind: 'ui', tested_sha: sha, passed: true, receipt: 'https://example.test/receipt', screenshots: ['https://example.test/screenshot'] }, remaining_scope: [] }
  await writeFile(audit, [deployment, newer].map(row => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(manifest, JSON.stringify({ evidence: [{ card_id: card, review }] }))
  await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: [root] } }))
  const env = { TINSTAR_CONFIG_HOME: root, TINSTAR_REVIEW_EVIDENCE_FILE: manifest, TINSTAR_DEPLOY_SOURCE: '/unavailable-checkout' }
  return { root, audit, manifest, deployment, newer, review, env }
}

describe('late evidence operator command', () => {
  it('runs through plain Node without consulting the advanced checkout and skips reordered retries', async () => {
    const f = await fixture()
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TINSTAR_') && key !== 'NODE_OPTIONS'))
    const run = () => promisify(execFile)(process.execPath, [resolve('scripts/deploy/review-handoff.mjs'), 'record', '--deployment', f.deployment.id], { env: { ...inherited, ...f.env } })
    await run()
    const saved = await readFile(f.audit, 'utf8')
    const records = saved.trim().split('\n').map(line => JSON.parse(line))
    expect(records).toHaveLength(3)
    expect(records[2]).toMatchObject({ action: 'floor-review-evidence', deploymentId: f.deployment.id, ownerHome: f.root, operator: expect.any(String) })
    expect(records.slice(0, 2)).toEqual([f.deployment, f.newer])
    await writeFile(f.manifest, JSON.stringify({ nonReviewable: [], evidence: [{ review: Object.fromEntries(Object.entries(f.review).reverse()), card_id: card }] }))
    await run()
    expect(await readFile(f.audit, 'utf8')).toBe(saved)
  })
  it.each(['unknown', 'sha', 'tested-sha', 'head', 'pull', 'classification', 'proof', 'url', 'home'])('refuses %s evidence without changing the audit', async scenario => {
    const f = await fixture()
    if (scenario === 'sha') f.review.deployed_sha = current
    if (scenario === 'tested-sha') f.review.proof.tested_sha = current
    if (scenario === 'head') f.review.pulls[0]!.head = current
    if (scenario === 'pull') f.review.pulls[0]!.url += '1'
    if (scenario === 'proof') f.review.proof.screenshots = []
    if (scenario === 'url') f.review.proof.receipt = ''
    await writeFile(f.manifest, JSON.stringify({ evidence: [{ card_id: card, review: f.review }], nonReviewable: scenario === 'classification' ? [{ pull: pull + '1', reason: 'test only', evidence: 'diff' }] : [] }))
    const before = await readFile(f.audit, 'utf8')
    await expect(recordLateEvidence(scenario === 'unknown' ? `floor:${head}` : f.deployment.id, { ...f.env, ...(scenario === 'home' ? { TINSTAR_REVIEW_FIRSTMATE_HOME: '/unconfigured' } : {}) })).rejects.toThrow()
    expect(await readFile(f.audit, 'utf8')).toBe(before)
  })
  it('keeps current smoke targeted at the latest deployment despite a late historical append', async () => {
    const f = await fixture()
    await recordLateEvidence(f.deployment.id, f.env)
    const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/deployment' ? { ok: true, data: { sha: current } } : { ok: true, data: { reviewExceptions: [], warnings: [] } })) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const smokeEnv = { TINSTAR_CONFIG_HOME: f.root, TINSTAR_BRIDGE_URL: base, TINSTAR_OWNER_URL: base }
    await recordSmoke(smokeEnv)
    const records = (await readFile(f.audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({ action: 'floor-smoke', deploymentId: f.newer.id, newSha: current })
    await expect(recordSmoke({ ...smokeEnv, TINSTAR_REVIEW_EVIDENCE_FILE: f.manifest })).rejects.toThrow('Live evidence manifest unreadable')
    expect((await readFile(f.audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.action === 'floor-deployment')).toEqual([f.deployment, f.newer])
  })
})
