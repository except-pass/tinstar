import type { FloorScene } from './reconciliationPresentation'
import type { PullSummary } from './pulls'
import { floorFieldValues } from './floorOrganization'
import { releasePull } from './releases'
import { workerTitle, managerName, historyRecord } from '../reconciliation/overviewModel'

export function pullContext(scene: FloorScene | null, pull: Pick<PullSummary, 'id' | 'links'>, now = Date.now()) {
  const links = pull.links.filter(link => link.active)
  const cards = scene?.cards.filter(card => links.some(link => link.cardId === card.id)) ?? []
  const workers = scene?.executions.filter(worker => releasePull(String(worker.source.pr.url))?.id === pull.id) ?? []
  const freshness = (observation: { status: string; expiresAt: string | null }) => scene?.searchReadFailed || observation.expiresAt && Date.parse(observation.expiresAt) <= now ? 'stale' : observation.status
  const contributors = workers.map(worker => ({
    id: worker.id, task: worker.identity.task_id ?? 'Unknown', home: worker.home, attempt: worker.identity.spawn_gen,
    manager: worker.home, managerBasis: `Current home accountability; parent ${worker.parentHome ?? 'Unknown'}`,
    machine: worker.placement.machine, machineBasis: worker.placement.basis,
    state: historyRecord(worker) ? 'Historical' : freshness(worker.observation) === 'fresh' && worker.observation.coverage === 'complete' ? 'Confirmed' : 'Last known',
    freshness: freshness(worker.observation), source: String(worker.source.pr.source ?? 'tasks[].pr.url'), observedAt: worker.observation.observedAt,
    registeredHead: typeof worker.source.pr.head === 'string' ? worker.source.pr.head : null,
    claims: [...(scene?.claims ?? []), ...(scene?.claimHistory ?? [])].filter(claim => claim.executionId === worker.id).map(claim => ({ ...claim,
      state: claim.state === 'current' && claim.verification === 'confirmed' &&
        (freshness(scene!.coverage.intentions) !== 'fresh' || scene!.coverage.intentions.coverage !== 'complete' ||
          freshness(worker.observation) !== 'fresh' || worker.observation.coverage !== 'complete') ? 'last-known' as const : claim.state,
    })),
  }))
  for (const row of scene?.backlog ?? []) {
    if (releasePull(String(row.source.pr_url))?.id !== pull.id || workers.some(worker => worker.home === row.home && worker.identity.task_id === row.source.id)) continue
    contributors.push({ id: row.id, task: String(row.source.id ?? 'Unknown'), home: row.home, attempt: null,
      manager: '', managerBasis: 'Manager at registration unknown', machine: null, machineBasis: 'unknown',
      freshness: freshness(row.observation), state: ['landed', 'done'].includes(String(row.source.state)) ? 'Historical' : 'Last known', source: `backlog.pr_url (${row.source.state ?? 'state unknown'})`, observedAt: row.observation.observedAt,
      registeredHead: null, claims: [] })
  }
  const values = (field: 'initiative' | 'epic') => scene ? [...new Set(cards.flatMap(card => floorFieldValues(scene, { card }, field)))] : []
  return { links, cards, workers, contributors, initiatives: values('initiative'), epics: values('epic'),
    workerNames: [...workers.map(workerTitle), ...contributors.filter(contributor => !workers.some(worker => worker.id === contributor.id)).map(contributor => `${contributor.task} (${contributor.state.toLowerCase()})`)], managers: scene ? [...new Set(workers.map(worker => managerName(scene, worker.home)))] : [] }
}
