import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { reviewEvidenceSchema, reviewSha, type ReviewEvidence } from '../../shared/reviews'
import { lateEvidenceSchema, deploymentsWithEvidence } from '../../shared/reviewHandoff.mjs'
import { releaseAssociations } from '../../shared/releases'
import { updateWorkSchema, type StartWorkResult } from '../../shared/workflow'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import { getConfigRoot } from '../configRoot'
import { AssociationStore } from '../releases/associations'
import type { ReviewOperation } from './workflowReview'
import { ReviewWriteError } from './workflowReview'

const pull = z.object({ url: z.string().regex(/^https:\/\/github.com\/except-pass\/tinstar\/pull\/[1-9]\d*$/), head: reviewSha, mergeSha: reviewSha }).strict()
export const floorDeploymentSchema = z.object({
  action: z.literal('floor-deployment'), id: z.string().min(1).max(128), time: z.string(),
  oldSha: reviewSha.nullable(), newSha: reviewSha, pulls: z.array(pull).max(100), membershipComplete: z.boolean(),
  ownerHome: z.string().nullable(), evidence: z.array(z.object({ card_id: z.string().regex(/^[a-f0-9]{32}$/), review: z.unknown() }).strict()).max(100),
  nonReviewable: z.array(z.object({ pull: z.string(), reason: z.string().min(1).max(4000), evidence: z.string().min(1).max(4000) }).strict()).max(100),
  warnings: z.array(z.string()),
})
export type FloorDeployment = z.infer<typeof floorDeploymentSchema>
const smokeSchema = z.object({ action: z.literal('floor-smoke'), deploymentId: z.string(), newSha: reviewSha, time: z.string(), passed: z.literal(true), receipt: z.string().min(1) })
export interface HandoffException { id: string; deploymentId: string; deployedSha: string; cardId: string | null; pull: string | null; owner: 'Firstmate'; worker: string | null; missing: string[]; nextAction: string; resolved: boolean }
type HandoffEvent = { action: 'review-handoff'; time: string; exception: HandoffException; deliverySaved?: boolean }
type AuditEvent = FloorDeployment | z.infer<typeof smokeSchema> | z.infer<typeof lateEvidenceSchema> | HandoffEvent
const stable = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function validateDeploymentEvidence(deployment: FloorDeployment, evidence: ReviewEvidence) {
  if (evidence.deployment_id !== deployment.id || evidence.deployed_sha !== deployment.newSha) throw new ReviewWriteError('deployment-mismatch', 'Review evidence must identify this guarded deployment and SHA')
  if (evidence.proof.tested_sha !== deployment.newSha) throw new ReviewWriteError('review-proof-mismatch', 'Live proof must identify the actual deployed SHA')
  for (const pr of evidence.pulls) {
    if (!deployment.pulls.some(member => member.url === pr.url && member.head === pr.head)) throw new ReviewWriteError('deployment-pr-mismatch', 'Declared PR/head is absent from the deployed receipt')
  }
}

/** Additive records in the existing deployment audit, never a second journal. */
export class ReviewDeploymentAudit {
  readonly path: string
  constructor(root = getConfigRoot(), path?: string) { this.path = path ?? `${(root === getConfigRoot() ? process.env.TINSTAR_DEPLOY_BLOCK : undefined) ?? join(root, 'deploy.blocked')}.audit.jsonl` }
  async read(): Promise<AuditEvent[]> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const events: AuditEvent[] = []
    for (const line of raw.split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      if (row.action === 'floor-deployment') events.push(floorDeploymentSchema.parse(row))
      else if (row.action === 'floor-smoke') events.push(smokeSchema.parse(row))
      else if (row.action === 'floor-review-evidence') events.push(lateEvidenceSchema.parse(row))
      else if (row.action === 'review-handoff') {
        if (!row.exception?.id || !Array.isArray(row.exception.missing) || typeof row.exception.resolved !== 'boolean') throw new Error('Invalid review handoff audit')
        events.push(row)
      }
    }
    return events
  }
  append(event: HandoffEvent) { return appendFile(this.path, JSON.stringify(event) + '\n', { mode: 0o600 }) }
  async exceptions() {
    const rows = new Map<string, HandoffException>()
    for (const event of await this.read()) if (event.action === 'review-handoff') rows.set(event.exception.id, event.exception)
    return [...rows.values()].filter(row => !row.resolved)
  }
  async validate(input: Extract<ReviewOperation, { kind: 'submit_for_review' }>, scene: FloorScene, associations: AssociationStore) {
    const events = await this.read(), evidence = input.review
    const deployment = deploymentsWithEvidence<FloorDeployment>(events).find(event => event.id === evidence.deployment_id)
    if (!deployment || deployment.newSha !== evidence.deployed_sha) throw new ReviewWriteError('deployment-missing', 'No matching guarded deployment receipt for this SHA')
    validateDeploymentEvidence(deployment, evidence)
    if (!events.some(event => event.action === 'floor-smoke' && event.deploymentId === deployment.id && event.newSha === deployment.newSha)) throw new ReviewWriteError('smoke-missing', 'Guarded deployment has no verified successful smoke receipt')
    if (!deployment.membershipComplete) throw new ReviewWriteError('deployment-membership-incomplete', 'Deployed PR membership is incomplete; reconcile the deployment audit')
    const links = releaseAssociations(scene, await associations.read())
    if (!links.associationsComplete) throw new ReviewWriteError('association-source-stale', 'Fresh complete shared PR/card association evidence is required')
    for (const pr of evidence.pulls) {
      if (!links.pulls.some(member => member.url === pr.url && member.links.some(link => link.cardId === input.card_id && link.active))) throw new ReviewWriteError('card-association-missing', 'An explicit canonical PR/card association is missing')
    }
  }
}

export class ReviewDeploymentReconciler {
  private pending?: Promise<void>
  private next = 0
  private cursor = 0
  constructor(private audit: ReviewDeploymentAudit, private deps: {
    scene: () => Promise<FloorScene>; associations: AssociationStore
    update: (input: ReviewOperation, actor: string) => Promise<StartWorkResult>
    deliver: (home: string, id: string, text: string) => Promise<{ saved: boolean }>
  }) {}
  run(force = false) {
    if (this.pending) return this.pending
    if (!force && Date.now() < this.next) return Promise.resolve()
    this.next = Date.now() + 30_000
    this.pending = this.reconcile().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async reconcile() {
    const events = await this.audit.read()
    const deployments = deploymentsWithEvidence<FloorDeployment>(events)
    if (!deployments.length) return
    const latest = new Map(events.filter((row): row is HandoffEvent => row.action === 'review-handoff').map(row => [row.exception.id, row]))
    const scene = await this.deps.scene(), links = releaseAssociations(scene, await this.deps.associations.read())
    const jobs = deployments.flatMap(deployment => (deployment.pulls.length ? deployment.pulls : [null]).flatMap(pr => {
      const cards = pr ? links.pulls.find(row => row.url === pr.url)?.links.filter(link => link.active).map(link => link.cardId) ?? [] : []
      if (pr) for (const { exception } of latest.values()) {
        if (exception.resolved && exception.deployedSha === deployment.newSha && exception.pull === pr.url && exception.cardId && !cards.includes(exception.cardId)) cards.push(exception.cardId)
      }
      return (cards.length ? cards : [null]).map(cardId => ({ deployment, pr, cardId, id: stable([deployment.newSha, pr?.url ?? null, cardId]) }))
    }))
    // Persist all work before the bounded mutation pass. A crash or the next
    // page of the budget must remain an explicit unresolved handoff.
    for (const { deployment, pr, cardId, id } of jobs) if (!latest.has(id)) {
      const pending: HandoffEvent = { action: 'review-handoff', time: new Date().toISOString(), exception: { id, deploymentId: deployment.id,
        deployedSha: deployment.newSha, cardId, pull: pr?.url ?? null, owner: 'Firstmate', worker: null, missing: ['Review reconciliation pending'],
        nextAction: 'Firstmate: refresh work views to reconcile the persisted guarded deployment evidence.', resolved: false } }
      await this.audit.append(pending); latest.set(id, pending)
    }
    // Resolve only formerly unknown identities when complete source now supplies
    // their exact associations. Never leave a repaired unknown-card row dangling.
    if (links.associationsComplete) for (const prior of latest.values()) {
      if (prior.exception.resolved || prior.exception.cardId) continue
      const known = jobs.filter(job => job.deployment.newSha === prior.exception.deployedSha && job.cardId && job.deployment.membershipComplete &&
        (!prior.exception.pull || job.pr?.url === prior.exception.pull))
      if (known.length && !jobs.some(job => job.id === prior.exception.id)) await this.audit.append({ action: 'review-handoff', time: new Date().toISOString(),
        exception: { ...prior.exception, resolved: true, missing: [], nextAction: 'Canonical association recovered; see the handoff for the linked card.' }, deliverySaved: prior.deliverySaved })
    }
    const pending = jobs.filter(job => !latest.get(job.id)?.exception.resolved)
    const start = this.cursor % Math.max(pending.length, 1)
    for (let offset = 0; offset < Math.min(pending.length, 8); offset++) {
          const index = (start + offset) % pending.length
          this.cursor = index + 1
          const { deployment, pr, cardId, id } = pending[index]!
          const prior = latest.get(id)
          const smoke = events.some(row => row.action === 'floor-smoke' && row.deploymentId === deployment.id && row.newSha === deployment.newSha)
          const missing: string[] = []
          if (!smoke) missing.push('Successful smoke receipt for the actual running SHA')
          if (!deployment.oldSha || !deployment.membershipComplete) missing.push('Complete deployed old/new SHA and PR membership evidence')
          if (!links.associationsComplete) missing.push('Fresh complete Notion/worker association source')
          const classification = deployment.nonReviewable.find(row => row.pull === pr?.url)
          if (!cardId) missing.push('Explicit PR ↔ canonical Notion card association')
          const declared = deployment.evidence.find(row => row.card_id === cardId)
          if (declared) { const parsed = reviewEvidenceSchema.safeParse(declared.review); if (!parsed.success) missing.push(...parsed.error.issues.map(issue => `Review evidence ${issue.path.join('.')}: ${issue.message}`)) }
          const evidence = deployment.evidence.flatMap(row => { const parsed = reviewEvidenceSchema.safeParse(row.review); return parsed.success ? [{ card_id: row.card_id, review: parsed.data }] : [] }).find(row => row.card_id === cardId && row.review.pulls.some(member => member.url === pr?.url))
          if (evidence) {
            try { validateDeploymentEvidence(deployment, evidence.review) }
            catch (error) { missing.push(error instanceof Error ? error.message : 'Deployment evidence mismatch') }
          }
          if (!classification && !evidence) missing.push('Review classification, live proof, screenshots (or non-UI alternative), and acceptance instructions')
          if (!missing.length && evidence && !classification) {
            const parsed = updateWorkSchema.safeParse({ kind: 'submit_for_review', card_id: cardId, operation_id: `deploy-review-${id.slice(0, 40)}`, review: evidence.review })
            if (!parsed.success || parsed.data.kind !== 'submit_for_review') missing.push('Valid bounded review submission evidence')
            else {
              const saved = await this.deps.update(parsed.data, 'Firstmate')
              if (saved.outcome !== 'saved') missing.push(`${saved.code}: ${saved.message}`)
            }
          }
          if (missing.length && !deployment.ownerHome) missing.push('Configured Firstmate home responsible for handoff delivery')
          const worker = cardId ? scene.claims.find(claim => claim.cardId === cardId && claim.basis === 'explicit' && claim.state === 'current' && claim.verification === 'confirmed')?.executionId ?? null : null
          const exception: HandoffException = { id, deploymentId: deployment.id, deployedSha: deployment.newSha, cardId, pull: pr?.url ?? null, owner: 'Firstmate', worker,
            missing, nextAction: missing.length ? `Firstmate: repair the listed association/source gaps; supply evidence with review-handoff.mjs record --deployment ${deployment.id}, then refresh work views. Keep the same submission key for a pending write.` : 'Handoff confirmed', resolved: !missing.length }
          let saved = prior?.deliverySaved ?? false
          if (!prior || JSON.stringify(prior.exception) !== JSON.stringify(exception)) await this.audit.append({ action: 'review-handoff', time: new Date().toISOString(), exception, deliverySaved: saved })
          if (missing.length && !saved && deployment.ownerHome) {
            saved = (await this.deps.deliver(deployment.ownerHome, id, `Tin Star review handoff exception\n${JSON.stringify(exception)}`)).saved
            if (saved) await this.audit.append({ action: 'review-handoff', time: new Date().toISOString(), exception, deliverySaved: true })
          }
    }
  }
}
