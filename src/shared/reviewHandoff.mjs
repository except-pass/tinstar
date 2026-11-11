import { z } from 'zod'
import { reviewEvidenceSchema } from './reviewEvidence.mjs'

export const handoffManifestSchema = z.object({
  evidence: z.array(z.object({ card_id: z.string().regex(/^[a-f0-9]{32}$/), review: reviewEvidenceSchema }).strict()).max(100),
  nonReviewable: z.array(z.object({ pull: z.string(), reason: z.string().trim().min(1).max(4000), evidence: z.string().trim().min(1).max(4000) }).strict()).max(100).default([]),
}).strict()
export const lateEvidenceSchema = handoffManifestSchema.extend({
  action: z.literal('floor-review-evidence'), deploymentId: z.string().regex(/^floor:[a-f0-9]{40}$/),
  time: z.string(), ownerHome: z.string().min(1), operator: z.string().min(1),
})

/**
 * Reject invented deployment membership before persisting evidence. Fresh card
 * associations and Notion policy remain the shared workflow writer's authority.
 * @param {z.infer<typeof handoffManifestSchema>} manifest
 * @param {{ id: string, newSha: string, pulls: Array<{url: string, head: string}> }} deployment
 */
export function validateHandoffManifest(manifest, deployment) {
  const cards = new Set()
  const reviewed = new Set()
  for (const { card_id, review } of manifest.evidence) {
    if (cards.has(card_id)) throw new Error('Supply one review deliverable per canonical card')
    cards.add(card_id)
    if (review.deployment_id !== deployment.id || review.deployed_sha !== deployment.newSha || review.proof.tested_sha !== deployment.newSha) throw new Error('Review evidence must match the selected deployment ID and tested SHA')
    for (const pr of review.pulls) {
      if (!deployment.pulls.some(member => member.url === pr.url && member.head === pr.head)) throw new Error('Review PR/head is absent from the selected deployment receipt')
      reviewed.add(pr.url)
    }
  }
  const classified = new Set()
  for (const row of manifest.nonReviewable) {
    if (!deployment.pulls.some(member => member.url === row.pull)) throw new Error('Classified PR is absent from the selected deployment receipt')
    if (reviewed.has(row.pull) || classified.has(row.pull)) throw new Error('Supply one consistent classification per PR')
    classified.add(row.pull)
  }
}

/** Compare evidence meaning, ignoring object/collection order, not timestamps.
 * @param {unknown} value
 * @returns {string}
 */
export function handoffMeaning(value) {
  if (Array.isArray(value)) return `[${value.map(handoffMeaning).sort().join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${handoffMeaning(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * @template {{ action: 'floor-deployment', id: string, ownerHome: string | null, evidence: unknown[], nonReviewable: unknown[] }} T
 * @param {Array<T | { action: string, deploymentId?: string, ownerHome?: string, evidence?: unknown[], nonReviewable?: unknown[] }>} events
 * @returns {T[]}
 */
export function deploymentsWithEvidence(events) {
  const deployments = new Map()
  for (const event of events) {
    if (event.action === 'floor-deployment') {
      const receipt = /** @type {T} */ (event)
      deployments.set(receipt.id, receipt)
    } else if (event.action === 'floor-review-evidence') {
      const deployment = deployments.get(event.deploymentId)
      if (!deployment) throw new Error('Late review evidence has no existing deployment receipt')
      const evidence = lateEvidenceSchema.parse(event)
      validateHandoffManifest(evidence, deployment)
      deployments.set(deployment.id, { ...deployment, ownerHome: evidence.ownerHome, evidence: evidence.evidence, nonReviewable: evidence.nonReviewable })
    }
  }
  return [...deployments.values()]
}
