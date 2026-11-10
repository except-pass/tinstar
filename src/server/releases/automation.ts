import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import type { ReleasesRead } from '../../shared/releases'
import type { ReleaseAutomationPlan, ReleaseTransitionEvidence, ReleaseTransitionProposal } from '../../shared/releaseAutomation'
import { receiptHash } from './cmsandbox'

export const rolloutGate = 'Automatic transitions are OFF. Owner activation requires the verification checkbox and coordinated board-guide/PM Bot instructions. Historical snapshots are review only.'
export type AutomationSettings = Pick<ReleaseAutomationPlan, 'requestedEnabled' | 'configuration' | 'warnings'>
const schema = z.object({ version: z.literal(1), enabled: z.boolean().default(false) })

/** Read the operator switch; schema and policy approval are rollout prerequisites.
 * Reading this separate optional file does not invalidate deployment evidence. */
export async function readAutomationSettings(root: string): Promise<AutomationSettings> {
  try {
    const { enabled } = schema.parse(JSON.parse(await readFile(join(root, 'releases', 'automation.json'), 'utf8')))
    return { requestedEnabled: enabled, configuration: 'configured', warnings: [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { requestedEnabled: false, configuration: 'default', warnings: [] }
    return { requestedEnabled: false, configuration: 'error', warnings: ['Release automation configuration is unreadable or invalid; automatic transitions remain OFF.'] }
  }
}

const unique = (values: string[]) => [...new Set(values)].sort()
function audit(evidence: ReleaseTransitionEvidence[], verify: boolean) {
  return [verify ? 'Production deployment proven; explicit owner verification is required before completion.' : 'All required PRs are proven live in production.',
    ...evidence.map(({ pull, mergeSha, receipt }) => `${pull} (merge ${mergeSha}): ${receipt.repository} / ${receipt.component} / ${receipt.target}; version ${receipt.version ?? 'unknown'}; source ${receipt.deployedSha ?? 'unknown'}; digest ${receipt.artifactDigest ?? 'unknown'}; deployed ${receipt.deployedAt}; workflow ${receipt.workflowUrl}; receipt ${receipt.receiptUrl} (${receipt.id}).`),
  ].join('\n')
}

/** Deterministic proposals only. GET/replay never invokes the scheduled writer. */
export function planReleaseAutomation(data: ReleasesRead, scene: FloorScene, settings: AutomationSettings): ReleaseAutomationPlan {
  const result: ReleaseAutomationPlan = { mode: settings.requestedEnabled ? 'automatic' : 'review-only', enabled: settings.requestedEnabled, ...settings, warnings: [...settings.warnings, ...(!settings.requestedEnabled ? [rolloutGate] : [])], proposals: [], held: [] }
  const report = data.reconciliation
  if (!report) { result.warnings.push('Reconciliation is unavailable; no transition can be proposed.'); return result }
  for (const decision of report.cards) {
    const card = scene.cards.find(card => card.id === decision.cardId && !card.source.archived && !card.source.in_trash)
    if (!card || card.source.properties.Status?.value !== 'Waiting for Prod Release') continue
    const reasons = [...decision.reasons]
    if (!['fresh', 'snapshot'].includes(report.sourceStatus) || !data.associationsComplete || scene.coverage.intentions.status !== 'fresh' || scene.coverage.intentions.coverage !== 'complete') reasons.push('Fresh complete card associations and production evidence are required')
    if (!['would-complete', 'would-verify'].includes(decision.decision)) reasons.push('Required production changes are not all safely live')
    const verify = card.source.properties['Requires production verification']?.value === true
    // Re-read card fields from the same authorized scene rather than inheriting an old decision.
    if (verify !== decision.requiresProductionVerification) reasons.push('Verification requirement changed; reconcile again')
    const owner = String(card.source.properties.Owner?.value ?? '').trim()
    if (verify && (!owner || owner.toLowerCase() === 'unassigned')) reasons.push('Production verification has no responsible owner; assign the card before routing')
    const evidence: ReleaseTransitionEvidence[] = []
    for (const url of decision.requiredPulls) {
      const pull = data.pulls.find(pull => pull.url === url)
      if (!pull?.mergeSha || pull.deployment?.state !== 'shipped' || !pull.deployment.targets.length) { reasons.push(`${url}: reconciled release evidence is unavailable`); continue }
      for (const target of pull.deployment.targets) {
        if (target.state !== 'live' || !target.receipt) reasons.push(`${url}: production target evidence is unavailable`)
        else evidence.push({ pull: url, mergeSha: pull.mergeSha, receipt: target.receipt })
      }
    }
    if (!decision.requiredPulls.length) reasons.push('No explicit required PR association')
    if (reasons.length) { result.held.push({ cardId: card.id, reasons: unique(reasons) }); continue }
    evidence.sort((a, b) => a.pull.localeCompare(b.pull) || a.receipt.repository.localeCompare(b.receipt.repository) || a.receipt.component.localeCompare(b.receipt.component) || a.receipt.target.localeCompare(b.receipt.target) || a.receipt.id.localeCompare(b.receipt.id))
    const requiredPulls = unique(decision.requiredPulls), to = verify ? 'In Progress' : 'Done'
    const id = receiptHash({ cardId: card.id, to, owner, requiredPulls, evidence })
    const proposal: ReleaseTransitionProposal = { id, cardId: card.id, owner, from: 'Waiting for Prod Release', to, kind: verify ? 'verify-in-production' : 'complete', requiredPulls, evidence, auditText: audit(evidence, verify), desk: null }
    if (verify) {
      const title = String(card.source.properties.Name?.value ?? card.id)
      proposal.desk = { owner, item: {
        id: `release-verification:${id}`, identities: [`release-verification:${id}`], title: `Verify in production: ${title}`,
        action: 'Check the deployed change in production and record the explicit verification result on the card. Keep it open until the check is recorded.', kind: 'decision', readiness: 'future-or-conditional', reasons: [rolloutGate],
        cardIds: [card.id], executionIds: [], homeIds: [], decisionKeys: [], checkpoint: null, oneTouch: false,
        evidence: [{ url: card.source.url ?? `https://www.notion.so/${card.id}`, kind: 'card' }, ...requiredPulls.map(url => ({ url, kind: 'pull-request' as const })), ...unique(evidence.flatMap(row => [row.receipt.receiptUrl, row.receipt.workflowUrl])).map(url => ({ url, kind: 'reference' as const }))],
        sources: [{ kind: 'notion', id: card.id, field: 'Status/Owner/Requires production verification', ...scene.coverage.intentions,
          readiness: 'future-or-conditional', action: 'Record explicit production verification', reasons: [rolloutGate] }],
      } }
    }
    result.proposals.push(proposal)
  }
  result.proposals.sort((a, b) => a.cardId.localeCompare(b.cardId))
  result.held.sort((a, b) => a.cardId.localeCompare(b.cardId))
  return result
}
