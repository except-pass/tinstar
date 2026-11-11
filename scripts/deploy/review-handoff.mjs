import { appendFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { http } from './post-deploy-smoke.mjs'
import { runningSha } from './deploy-support.mjs'

const manifestSchema = z.object({ evidence: z.array(z.object({ card_id: z.string().regex(/^[a-f0-9]{32}$/), review: z.record(z.unknown()) })).max(100),
  nonReviewable: z.array(z.object({ pull: z.string(), reason: z.string().min(1).max(4000), evidence: z.string().min(1).max(4000) })).max(100).default([]) })
const shaPattern = /^[a-f0-9]{40}$/
const auditPath = e => `${e.TINSTAR_DEPLOY_BLOCK ?? join(e.TINSTAR_CONFIG_HOME, 'deploy.blocked')}.audit.jsonl`
const base = e => e.TINSTAR_BRIDGE_URL ?? 'http://127.0.0.1:5281'
const append = (e, record) => appendFile(auditPath(e), JSON.stringify(record) + '\n', { mode: 0o600 })
async function events(e) {
  try { return (await readFile(auditPath(e), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, ...options }).trim()
export async function recordDeployment(e = process.env, execute = run) {
  const source = e.TINSTAR_DEPLOY_SOURCE
  const newSha = execute('git', ['-C', source, 'rev-parse', 'HEAD'])
  if (!shaPattern.test(newSha)) throw new Error('Deployment revision unavailable')
  const id = `floor:${newSha}`, previous = (await events(e)).filter(row => row.action === 'floor-deployment' && row.id === id).at(-1)
  const oldSha = shaPattern.test(e.TINSTAR_PREVIOUS_DEPLOYED_SHA ?? '') ? e.TINSTAR_PREVIOUS_DEPLOYED_SHA : null
  const record = { action: 'floor-deployment', id, time: new Date().toISOString(), oldSha, newSha, pulls: [], membershipComplete: false, ownerHome: null, evidence: [], nonReviewable: [], warnings: [] }
  try {
    const config = JSON.parse(await readFile(join(e.TINSTAR_CONFIG_HOME, 'config.json'), 'utf8'))
    const homes = config.firstmate?.homes ?? []
    record.ownerHome = e.TINSTAR_REVIEW_FIRSTMATE_HOME ?? (homes.length === 1 ? homes[0] : null)
    if (!homes.includes(record.ownerHome)) { record.ownerHome = null; record.warnings.push('Select a configured Firstmate home for review handoff delivery') }
  } catch { record.warnings.push('Firstmate delivery configuration unreadable') }
  if (previous && (oldSha === newSha || !oldSha)) {
    Object.assign(record, { oldSha: previous.oldSha, pulls: previous.pulls, membershipComplete: previous.membershipComplete, evidence: previous.evidence, nonReviewable: previous.nonReviewable })
  } else if (oldSha) {
    try {
      const revisions = execute('git', ['-C', source, 'rev-list', '--first-parent', `${oldSha}..${newSha}`]).split('\n').filter(Boolean)
      execute('git', ['-C', source, 'merge-base', '--is-ancestor', oldSha, newSha])
      if (revisions.length > 50) throw new Error('Deployment membership exceeds bounded read')
      const pulls = new Map()
      let complete = true
      for (const revision of revisions) {
        const output = execute('gh-axi', ['api', 'GET', `/repos/except-pass/tinstar/commits/${revision}/pulls`, '--jq', '{rows:([.[]|{url:.html_url,head:.head.sha,mergeSha:.merge_commit_sha}]|tojson)}', '--full'])
        const encoded = /^rows: (.*)$/m.exec(output)?.[1]
        const first = encoded ? JSON.parse(encoded) : null
        const rows = typeof first === 'string' ? JSON.parse(first) : first
        if (!Array.isArray(rows)) throw new Error('PR membership read unavailable')
        const members = rows.filter(row => row.mergeSha === revision && shaPattern.test(row.head) && /^https:\/\/github.com\/except-pass\/tinstar\/pull\/[1-9]\d*$/.test(row.url))
        if (!members.length) complete = false // Includes direct commits: never silently classify them.
        for (const member of members) pulls.set(member.url, member)
      }
      record.pulls = [...pulls.values()]; record.membershipComplete = complete
    } catch { record.warnings.push('Deployed commit/PR membership could not be completely verified') }
  } else record.warnings.push('Previous running revision is unknown; supply verified deployment evidence before claiming a complete handoff')
  if (e.TINSTAR_REVIEW_EVIDENCE_FILE) {
    try {
      // The server applies the full shared review schema before any Notion write.
      const manifest = manifestSchema.parse(JSON.parse(await readFile(e.TINSTAR_REVIEW_EVIDENCE_FILE, 'utf8')))
      record.evidence = manifest.evidence; record.nonReviewable = manifest.nonReviewable
    } catch { record.warnings.push('Review evidence manifest is missing or malformed') }
  }
  await append(e, record)
  return record
}
export async function recordSmoke(e = process.env) {
  const sha = await runningSha(e)
  let deployment = (await events(e)).filter(row => row.action === 'floor-deployment').at(-1)
  if (!sha || !deployment || sha !== deployment.newSha) throw new Error('Running revision does not match the deployment receipt')
  await append(e, { action: 'floor-smoke', deploymentId: deployment.id, newSha: sha, time: new Date().toISOString(), passed: true, receipt: 'Guarded Ask round-trip and MCP catalog/publication smoke; running /api/deployment SHA verified' })
  // Live proof may be collected after restart. Re-read the evidence file here
  // (also on --check-only), without a new deploy or another membership crawl.
  if (e.TINSTAR_REVIEW_EVIDENCE_FILE) {
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(e.TINSTAR_REVIEW_EVIDENCE_FILE, 'utf8')))
      deployment = { ...deployment, evidence: manifest.evidence, nonReviewable: manifest.nonReviewable ?? [], time: new Date().toISOString() }
      await append(e, deployment)
    } catch { throw new Error('Live evidence manifest unreadable; handoff remains unconfirmed') }
  }
  // The existing normal operational refresh performs the same reconciliation
  // after restart. Calling it here makes a successful guarded deploy immediate.
  const response = await (await http(`${base(e)}/api/reconciliation/queue?refresh=1`, { headers: { 'X-Tinstar-UI': '1' }, timeout: 60_000 })).json()
  if (!response.ok || response.data?.reviewExceptions?.some(row => row.deployedSha === sha) || response.data?.warnings?.some(value => /handoff.*unavailable|handoff.*unknown/i.test(value))) throw new Error('Review handoff remains unresolved; inspect deployment audit and Firstmate delivery')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'record') await recordDeployment()
    else if (process.argv[2] === 'smoke') await recordSmoke()
    else throw new Error('Unknown review handoff command')
  } catch { console.error('Review handoff unconfirmed; healthy deployment is retained. Inspect the existing deploy audit and retry normal reconciliation.'); process.exitCode = 1 }
}
