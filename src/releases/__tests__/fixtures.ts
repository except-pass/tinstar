import type { FloorScene } from '../../shared/reconciliationPresentation'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { sceneSearchDocuments } from '../../shared/searchDocuments'
export function releaseFixture() {
  const scene: FloorScene = fixtureScene()
  scene.cards = scene.cards.slice(0, 3)
  scene.cards.forEach((card, index) => {
    card.source.properties.Link = { id: 'link', type: 'url', value: `https://github.com/Owner/Repo/pull/${index === 2 ? 2 : 1}`, hasMore: false }
    card.source.properties.Initiative = { id: 'initiative', type: 'select', value: index === 1 ? 'Beta' : 'Alpha', hasMore: false }
    card.source.properties.Epic = { id: 'epic', type: 'select', value: index === 1 ? 'Backend' : 'Frontend', hasMore: false }
    card.source.properties.Status!.value = 'Waiting for Prod Release'
  })
  scene.searchIndex = { documents: sceneSearchDocuments(scene), notes: [] }
  return scene
}
