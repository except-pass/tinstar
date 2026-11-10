import { acceptanceKey, acceptanceState, cardAcceptanceContract } from './releaseAcceptance'
import type { FloorScene } from './reconciliationPresentation'
import type { ReleaseChange, ReleaseObject } from './releaseObjects'
import { activeReleaseLinks, type ReleasePull, type ReleasesRead } from './releases'

/** One outcome per explicit card; unlinked PRs retain their real GitHub identity.
 * Build/DEV checks never substitute for production acceptance assertions. */
export function releaseChanges(release: ReleaseObject, data: ReleasesRead, scene: FloorScene): ReleaseChange[] {
  const groups = new Map<string, { cardId: string | null; pulls: ReleasePull[] }>()
  for (const pull of release.pulls) {
    const cards = activeReleaseLinks(pull).map(link => link.cardId)
    for (const cardId of cards.length ? cards : [null]) {
      const id = cardId ? `card:${cardId}` : `pull:${pull.id}`
      let group = groups.get(id)
      if (!group) { group = { cardId, pulls: [] }; groups.set(id, group) }
      group.pulls.push(pull)
    }
  }
  return [...groups].map(([id, group]) => {
    const card = scene.cards.find(card => card.id === group.cardId)
    const required = group.cardId ? data.pulls.filter(pull => activeReleaseLinks(pull).some(link => link.cardId === group.cardId)).map(pull => pull.url) : group.pulls.map(pull => pull.url)
    const requiredPulls = [...new Set([...required, ...group.pulls.map(pull => pull.url)])]
    const evaluated = [...release.pulls, ...(release.supportingPulls ?? [])]
    const requiredRecords = requiredPulls.flatMap(url => evaluated.find(pull => pull.url === url) ?? [])
    const targets = release.targets.filter(target => requiredRecords.some(pull => pull.deployment?.targets.some(item => item.target === target.target && item.component === target.component)))
    const proven = requiredPulls.length > 0 && requiredPulls.every(url => {
      const pull = evaluated.find(pull => pull.url === url)
      return pull?.deployment?.state === 'shipped' && pull.deployment.targets.length && pull.deployment.targets.every(target => target.state === 'live' &&
        release.targets.some(item => item.component === target.component && item.target === target.target && item.receipt?.id === target.receipt?.id && item.receipt?.outcome === 'succeeded' && !item.receipt.exceptions.length && item.receipt.repository === release.repository && item.receipt.environment === 'production' && !!item.receipt.deployedSha))
    })
    const absent = requiredRecords.some(pull => pull.deployment?.targets.some(target => target.state === 'absent'))
    const change: ReleaseChange = { id, cardId: group.cardId, title: String(card?.source.properties.Name?.value ?? group.pulls[0]?.title ?? group.pulls[0]?.id),
      product: String(card?.source.properties.Product?.value ?? (group.cardId ? 'Linked work' : 'Unlinked PR')),
      pulls: requiredRecords, requiredPulls, targets,
      delivery: release.kind !== 'production' ? 'Awaiting delivery' : proven ? 'Deployed' : absent ? 'Not deployed' : 'Unknown',
      acceptance: 'Unknown', successCondition: null, method: null, checkRef: null, acceptanceEvidence: null, note: null, audience: 'internal' }
    const { contract, gap } = cardAcceptanceContract(card?.source.properties.Evidence?.value)
    change.acceptanceGap = gap
    change.checks = (contract?.checks ?? []).map(check => {
      const key = acceptanceKey(release, change, check, data.acceptanceWorkflows)
      const record = data.acceptanceRecords?.find(record => record.key === key) ?? null
      return { ...check, key, record, outcome: record?.events.at(-1)?.outcome ?? 'missing' }
    })
    change.successCondition = contract?.checks.map(check => check.successCondition).join(' · ') ?? null
    change.method = contract?.checks.map(check => check.method === 'workflow' ? 'Automated' : check.method === 'human' ? 'Manual' : 'Observational').join(' · ') ?? null
    change.checkRef = contract?.checks.map(check => check.ref).join(' · ') ?? null
    change.acceptance = acceptanceState(change.checks, change.delivery === 'Deployed' && data.associationsComplete && release.membership.status === 'complete')
    change.acceptanceEvidence = change.checks.flatMap(check => {
      const event = check.record?.events.at(-1)
      return event ? [`${check.ref}: ${event.outcome} · ${event.reason}${event.evidence ? ` · ${event.evidence}` : ''}`] : []
    }).join('\n') || null
    return change
  })
}
