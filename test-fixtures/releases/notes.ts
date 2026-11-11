import { acceptanceFixture } from './acceptance'
import { releaseChanges } from '../../src/shared/releaseChanges'
import type { AcceptanceOutcome } from '../../src/shared/releaseAcceptance'

/** Synthetic native coordinator export, exact target readback and D.3 records. */
export function notesFixture() {
  const fixture = acceptanceFixture('human', true)
  const { scene, data, release, pull, contract } = fixture
  const baseCard = structuredClone(scene.cards[0]!)
  const outcomes: AcceptanceOutcome[] = ['passed', 'passed', 'failed', 'running', 'missing', 'passed']
  const titles = ['Bound query load', 'Hide absent generator frequency', 'Correct enum mappings', 'Preserve controller identity', 'Review administrative permissions', 'Remove expired history']
  scene.cards = outcomes.map((_, index) => {
    const card = structuredClone(baseCard)
    card.id = `notes-card-${index}`; card.source.id = card.id
    card.source.properties.Name!.value = titles[index]!
    card.source.properties.Product = { id: 'product', type: 'select', value: index === 1 ? 'Fleet Management Portal' : 'Cloud Platform', hasMore: false }
    card.source.properties.Evidence!.value = '```production-acceptance\n' + JSON.stringify({ ...contract,
      notes: { audience: index === 0 ? 'internal' : 'customer', internal: `Internal: ${titles[index]}.`, customer: `Customer: ${titles[index]}.` },
    }) + '\n```'
    const record = structuredClone(pull)
    record.id = `${release.repository}#${index + 1}`; record.number = index + 1; record.url = `https://github.com/${release.repository}/pull/${record.number}`
    record.links = [{ cardId: card.id, active: true, sources: ['Notion Link/GitHub property'], events: [] }]
    if (index === 5) { record.deployment!.state = 'unknown'; record.deployment!.targets[0]!.state = 'absent' }
    if (index === 0) { data.pulls = []; release.pulls = [] }
    data.pulls.push(record); release.pulls.push(record)
    return card
  })
  data.acceptanceRecords = releaseChanges(release, data, scene).flatMap((change, index) => (change.checks ?? []).flatMap(check => outcomes[index] === 'missing' ? [] : [{
    key: check.key, releaseId: release.id, changeId: change.id, checkId: check.id,
    events: [{ at: '2026-11-06T18:20:00Z', actor: 'Synthetic reviewer', outcome: outcomes[index]!, reason: 'Synthetic feature assertion', evidence: 'https://example.com/synthetic-proof', runId: null, runUrl: null }],
  }]))
  const candidate = data.releases!.find(item => item.kind === 'candidate')!
  candidate.pulls = release.pulls; candidate.membership = { ...release.membership }
  const older = structuredClone(release)
  older.id = `${release.id}:older-synthetic`; older.version = 'v1.23.9'; older.pulls = []
  data.releases!.push(older)
  return fixture
}
