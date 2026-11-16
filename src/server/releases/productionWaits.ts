import type { FloorScene } from '../../shared/reconciliationPresentation'
import { activeReleaseLinks, releasePull, type ReleasesRead } from '../../shared/releases'
import type { ReleaseTransitionProposal } from '../../shared/releaseAutomation'
import { receiptHash } from './cmsandbox'
import type { ReleaseTransport } from './writer'

/** Membership is a release milestone, not proof of deployment or acceptance.
 * Keep the existing verification route for cards that explicitly require it. */
export function productionWaits(data: ReleasesRead, scene: FloorScene): ReleaseTransitionProposal[] {
  if (!data.associationsComplete || !data.releaseSource || data.releaseSource.status === 'unknown' ||
    scene.coverage.intentions.status !== 'fresh' || scene.coverage.intentions.coverage !== 'complete') return []
  return scene.cards.flatMap(card => {
    if (card.source.archived || card.source.in_trash || card.source.properties.Status?.value !== 'Waiting for Prod Release') return []
    const requiredPulls = data.pulls.filter(pull => activeReleaseLinks(pull).some(link => link.cardId === card.id)).map(pull => pull.url).sort()
    if (!requiredPulls.length) return []
    const releases = requiredPulls.map(url => data.releases?.find(release => release.kind === 'production' &&
      !release.provenance.historical && release.membership.status === 'complete' && release.github?.record === 'available' &&
      !!release.github.publishedAt && release.pulls.some(pull => pull.id === releasePull(url)?.id)))
    if (releases.some(release => !release)) return []
    const owner = String(card.source.properties.Owner?.value ?? '').trim()
    const verify = card.source.properties['Requires production verification']?.value === true
    if (verify && (!owner || owner.toLowerCase() === 'unassigned')) return []
    const to = verify ? 'In Progress' as const : 'Done' as const
    const membership = requiredPulls.map((pull, index) => ({ pull, release: releases[index]!.id, source: releases[index]!.sourceSha, url: releases[index]!.evidenceUrl }))
    const id = `membership:${receiptHash({ card: card.id, owner, to, membership })}`
    return [{ id, cardId: card.id, owner, from: 'Waiting for Prod Release' as const, to, kind: verify ? 'verify-in-production' as const : 'complete' as const,
      requiredPulls, evidence: [], desk: null,
      auditText: ['Awaited PRs are included in published production releases.', ...membership.map(row => `${row.pull}: ${row.release}; source ${row.source}; ${row.url}`),
        verify ? 'Production verification is required; continue on the existing In Progress route.' : 'Release wait completed.',
        'Release membership does not certify current deployment or feature acceptance.'].join('\n') }]
  })
}

/** Scheduled separately from reads. Reuse the existing Notion release transport
 * and durable card markers, including recovery after a lost status response. */
export class ProductionWaitWriter {
  private running: Promise<{ completed: string[]; unconfirmed: string[] }> | null = null
  constructor(private transport: ReleaseTransport, private read: () => Promise<{ data: ReleasesRead; scene: FloorScene }>) {}
  run() {
    return this.running ??= this.perform().finally(() => { this.running = null })
  }
  private async perform() {
    const { data, scene } = await this.read(), completed: string[] = [], unconfirmed: string[] = []
    for (const proposal of productionWaits(data, scene)) {
      const marker = `Tin Star production wait: ${proposal.id}`
      try {
        let card = await this.transport.card(proposal.cardId)
        const matches = () => !card.archived && !card.in_trash && card.properties.Status?.value === proposal.from &&
          String(card.properties.Owner?.value ?? '').trim() === proposal.owner &&
          (card.properties['Requires production verification']?.value === true) === (proposal.to === 'In Progress')
        if (!matches()) continue
        if (!await this.transport.hasNote(card.id, marker)) await this.transport.note(card.id, proposal.auditText, marker)
        card = await this.transport.card(card.id)
        const fresh = await this.read()
        // Re-read all associations before the write: a newly added required PR
        // must not inherit an earlier release's membership.
        if (!matches() || !productionWaits(fresh.data, fresh.scene).some(row => row.id === proposal.id)) continue
        await this.transport.transition(card, proposal)
        completed.push(proposal.cardId)
      } catch {
        // Surface an uncertain write to the scheduler; the next pass recovers
        // from the card/receipt instead of silently claiming success.
        unconfirmed.push(proposal.cardId)
      }
    }
    return { completed, unconfirmed }
  }
}
