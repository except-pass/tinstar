import { appendFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { handoffManifestSchema, lateEvidenceSchema, validateHandoffManifest, handoffMeaning, deploymentsWithEvidence } from '../../src/shared/reviewHandoff.mjs'
import { configuredReviewHomes, resolveReviewHome } from '../../src/server/fleet/reviewHomes.mjs'
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
/** Attach a complete evidence manifest to an existing receipt; never probe HEAD
 * or rewrite deployment/smoke provenance to repair a review-only failure. */
export async function recordLateEvidence(deploymentId, e = process.env) {
  const history = await events(e)
  const deployment = deploymentsWithEvidence(history).find(row => row.id === deploymentId)
  if (!deployment) throw new Error('No existing guarded deployment receipt for the selected ID')
  const manifest = handoffManifestSchema.parse(JSON.parse(await readFile(e.TINSTAR_REVIEW_EVIDENCE_FILE, 'utf8')))
  validateHandoffManifest(manifest, deployment)
  const config = JSON.parse(await readFile(join(e.TINSTAR_CONFIG_HOME, 'config.json'), 'utf8'))
  const ownerHome = resolveReviewHome(configuredReviewHomes(config), e.TINSTAR_REVIEW_FIRSTMATE_HOME)
  // A typo here would strand the durable exception without a usable delivery path.
  if (!ownerHome) throw new Error('Select a configured Firstmate home path or unique reconciliation.fleet label with TINSTAR_REVIEW_FIRSTMATE_HOME')
  const event = lateEvidenceSchema.parse({ action: 'floor-review-evidence', deploymentId, time: new Date().toISOString(), operator: userInfo().username, ownerHome, ...manifest })
  const meaning = row => handoffMeaning({ ownerHome: row.ownerHome, evidence: row.evidence, nonReviewable: row.nonReviewable })
  if (meaning(deployment) !== meaning(event)) await append(e, event)
  return event
}
export async function recordDeployment(e = process.env, execute = run) {
  const source = e.TINSTAR_DEPLOY_SOURCE
  const newSha = execute('git', ['-C', source, 'rev-parse', 'HEAD'])
  if (!shaPattern.test(newSha)) throw new Error('Deployment revision unavailable')
  const id = `floor:${newSha}`, previous = deploymentsWithEvidence(await events(e)).find(row => row.id === id)
  const oldSha = shaPattern.test(e.TINSTAR_PREVIOUS_DEPLOYED_SHA ?? '') ? e.TINSTAR_PREVIOUS_DEPLOYED_SHA : null
  const record = { action: 'floor-deployment', id, time: new Date().toISOString(), oldSha, newSha, pulls: [], membershipComplete: false, ownerHome: null, evidence: [], nonReviewable: [], warnings: [] }
  try {
    const config = JSON.parse(await readFile(join(e.TINSTAR_CONFIG_HOME, 'config.json'), 'utf8'))
    record.ownerHome = resolveReviewHome(configuredReviewHomes(config), e.TINSTAR_REVIEW_FIRSTMATE_HOME)
    if (!record.ownerHome) record.warnings.push('Select a configured Firstmate home path or unique reconciliation.fleet label for review handoff delivery')
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
  const history = await events(e)
  const current = history.filter(row => row.action === 'floor-deployment').at(-1)
  let deployment = deploymentsWithEvidence(history).find(row => row.id === current?.id)
  if (!sha || !deployment || sha !== deployment.newSha) throw new Error('Running revision does not match the deployment receipt')
  await append(e, { action: 'floor-smoke', deploymentId: deployment.id, newSha: sha, time: new Date().toISOString(), passed: true, receipt: 'Guarded Ask round-trip and MCP catalog/publication smoke; running /api/deployment SHA verified' })
  // Live proof may be collected after restart. Re-read the evidence file here
  // (also on --check-only), without a new deploy or another membership crawl.
  if (e.TINSTAR_REVIEW_EVIDENCE_FILE) {
    try {
      const manifest = handoffManifestSchema.parse(JSON.parse(await readFile(e.TINSTAR_REVIEW_EVIDENCE_FILE, 'utf8')))
      validateHandoffManifest(manifest, deployment)
      deployment = { ...deployment, evidence: manifest.evidence, nonReviewable: manifest.nonReviewable ?? [] }
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
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === 'record') await recordDeployment()
    else if (args.length === 3 && args[0] === 'record' && args[1] === '--deployment') await recordLateEvidence(args[2])
    else if (args.length === 1 && args[0] === 'smoke') await recordSmoke()
    else throw new Error('Usage: review-handoff.mjs record [--deployment floor:<sha>] | smoke')
  } catch (error) { console.error(`Review handoff unconfirmed: ${error.message}. Healthy deployment is retained; correct the evidence and retry normal reconciliation.`); process.exitCode = 1 }
}
