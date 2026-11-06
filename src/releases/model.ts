import type { FloorScene } from '../shared/reconciliationPresentation'
import { floorFieldValues } from '../shared/floorOrganization'
import { activeReleaseLinks, type ReleasePull } from '../shared/releases'
import type { SearchDocument } from '../shared/searchDocuments'
import { searchText, sceneSearchDocuments } from '../shared/searchDocuments'

export type ReleaseFilter = 'In Queue' | 'Verify in Prod' | 'Shipped' | 'Exceptions'
export const releaseFilters: ReleaseFilter[] = ['In Queue', 'Verify in Prod', 'Shipped', 'Exceptions']
// Until component reconciliation is available, no observation certifies shipment.
export const releaseState = (pull: ReleasePull) => pull.exceptions.length ? 'Exception' : pull.state === 'merged' ? 'Deployment unknown' : 'Merge unknown'
export const queuedPulls = (pulls: ReleasePull[]) => pulls.filter(pull => pull.state === 'merged' && pull.freshness === 'fresh')
export function filterReleases(pulls: ReleasePull[], filter: ReleaseFilter) {
  if (filter === 'Exceptions') return pulls.filter(pull => pull.exceptions.length > 0)
  if (filter === 'In Queue') return pulls.filter(pull => pull.state === 'merged' || pull.state === 'unknown')
  return [] // Verify/Shipped require evidence, never a tag or card status alone.
}
export function releaseGroups(scene: FloorScene, pulls: ReleasePull[], preset: 'initiative' | 'repository') {
  const groups = new Map<string, { id: string; label: string; pulls: ReleasePull[] }>()
  for (const pull of pulls) {
    const memberships = preset === 'repository' ? [pull.repository] : activeReleaseLinks(pull).flatMap(link => {
      const card = scene.cards.find(card => card.id === link.cardId)
      const initiatives = floorFieldValues(scene, { card }, 'initiative'), epics = floorFieldValues(scene, { card }, 'epic')
      const label = (id: string) => String(scene.cards.find(card => card.id === id)?.source.properties.Name?.value ?? id)
      return (initiatives.length ? initiatives : ['Unassigned / Unknown']).flatMap(initiative =>
        (epics.length ? epics : ['Unassigned / Unknown']).map(epic => `${label(initiative)} → ${label(epic)}`))
    })
    for (const label of new Set(memberships.length ? memberships : ['Unassigned / Unknown'])) {
      let group = groups.get(label)
      if (!group) { group = { id: label, label, pulls: [] }; groups.set(label, group) }
      group.pulls.push(pull)
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}
export function releaseDocuments(scene: FloorScene, pulls: ReleasePull[], missingCardIds: string[] = []): SearchDocument[] {
  const cardDocuments = scene.searchIndex?.documents ?? sceneSearchDocuments(scene)
  const documents: SearchDocument[] = pulls.map(pull => {
    const cards = activeReleaseLinks(pull).map(link => link.cardId)
    const linked = cardDocuments.filter(document => document.target.kind === 'card' && cards.includes(document.target.id))
    return { key: `pull:${pull.id}`, target: { kind: 'pull', id: pull.id }, title: searchText(pull.title ?? `${pull.repository} #${pull.number}`),
      identifiers: [pull.id, pull.url, `PR #${pull.number}`, String(pull.number)],
      fields: [{ name: 'Repository', source: 'GitHub', text: pull.repository }, { name: 'Release state', source: 'Release projection', text: `${releaseState(pull)} ${pull.exceptions.join(' ')}` },
        ...linked.flatMap(document => [{ name: 'Linked card', source: 'Notion', text: document.title }, ...document.fields])],
      observedAt: pull.observedAt, expiresAt: scene.coverage.intentions.expiresAt, coverage: pull.freshness }
  })
  return [...documents, ...cardDocuments.filter(document => document.target.kind === 'card' && missingCardIds.includes(document.target.id))]
}
