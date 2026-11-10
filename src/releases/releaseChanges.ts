import type { FloorScene } from '../shared/reconciliationPresentation'
import type { ReleaseChange, ReleaseObject } from '../shared/releaseObjects'
import { activeReleaseLinks, type ReleasePull, type ReleasesRead } from '../shared/releases'

/** One outcome per explicit card; unlinked PRs retain their real GitHub identity.
 * D.3 owns acceptance contracts/results. Build/DEV checks never fill that gap. */
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
    const targets = release.targets.filter(target => group.pulls.some(pull => pull.deployment?.targets.some(item => item.target === target.target && item.component === target.component)))
    const proven = requiredPulls.length > 0 && requiredPulls.every(url => {
      const pull = release.pulls.find(pull => pull.url === url)
      return pull?.deployment?.targets.length && pull.deployment.targets.every(target => target.state === 'live' &&
        release.targets.some(item => item.component === target.component && item.target === target.target && item.receipt?.id === target.receipt?.id && item.receipt?.outcome === 'succeeded'))
    })
    const absent = group.pulls.some(pull => pull.deployment?.targets.some(target => target.state === 'absent'))
    return { id, cardId: group.cardId, title: String(card?.source.properties.Name?.value ?? group.pulls[0]?.title ?? group.pulls[0]?.id),
      product: String(card?.source.properties.Product?.value ?? (group.cardId ? 'Linked work' : 'Unlinked PR')),
      pulls: group.pulls, requiredPulls, targets,
      delivery: release.kind !== 'production' ? 'Awaiting delivery' : proven ? 'Deployed' : absent ? 'Not deployed' : 'Unknown',
      acceptance: 'Unknown', successCondition: null, method: null, checkRef: null, acceptanceEvidence: null, note: null, audience: 'internal' }
  })
}
