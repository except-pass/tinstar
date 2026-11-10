import type { IncomingMessage, ServerResponse } from 'node:http'
import { ok, fail } from '../api/envelope'
import { resolveCorsHeaders } from '../api/cors'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { loadReconciliationConfig, type ReconciliationConfig, type FleetSource } from './config'
import { fleetObservation } from './fleet'
import { notionObservation, readNotionCard } from './notion'
import type { SceneCard } from './scene'
import { ageObservation } from './observation'
import { CardContextReader } from './cardContext'
import { SceneReconciler } from './scene'
import { buildQueue } from './queue'
import { QueuePullReader } from './queuePulls'
import { buildWorkerLinkReport } from './workerLinkReport'
import { SearchDocumentCollector } from './searchIndex'

export type SourceSnapshot = Awaited<ReturnType<ReconciliationSources['snapshot']>>

/** Shared read-only collection and scene projection; no domain actions. */
export class ReconciliationSources {
  checkInIndicators?: () => Promise<Map<string, NonNullable<SceneCard['checkInRequest']>>>
  private fleet
  private notion
  private context
  private reconciler = new SceneReconciler()
  private queuePulls = new QueuePullReader()
  private search = new SearchDocumentCollector((id, revision) => this.context.get(id, revision))

  constructor(private readonly config: ReconciliationConfig = loadReconciliationConfig()) {
    this.context = new CardContextReader(config.notion)
    this.fleet = config.fleet.map(source => ({ source, observation: fleetObservation(source) }))
    this.notion = notionObservation(config.notion)
  }

  async snapshot(force = false) {
    // At most four local snapshot processes at once, even for a large farm.
    const homes: Array<{ source: FleetSource & { machineBasis: string }; observation: Awaited<ReturnType<ReturnType<typeof fleetObservation>['get']>> }> = []
    const notion = this.notion.get(force)
    for (let offset = 0; offset < this.fleet.length; offset += 4) {
      homes.push(...await Promise.all(this.fleet.slice(offset, offset + 4).map(async ({ source, observation }) => ({
        source: { ...source, machineBasis: source.machine ? 'configured' : 'unknown' }, observation: await observation.get(force),
      }))))
    }
    const intentions = await notion
    return {
      generatedAt: new Date().toISOString(), scope: 'configured-homes-only',
      warnings: [...this.config.warnings, ...(!homes.length ? ['No First Mate homes configured; fleet coverage is unknown'] : [])],
      // Earlier batches can age while a later home consumes its timeout.
      fleet: homes.map(row => ({ ...row, observation: ageObservation(row.observation) })), intentions: ageObservation(intentions),
    }
  }

  async card(id: string) { return this.context.get(id) }

  async currentCard(id: string) { return readNotionCard(this.config.notion, id) }
  async currentCardContext(id: string) { return this.context.checkpoints(id) }

  async scene(force = false) {
    const scene = this.reconciler.reconcile(await this.snapshot(force))
    if (this.checkInIndicators) {
      const indicators = await this.checkInIndicators()
      for (const card of scene.cards) card.checkInRequest = indicators.get(card.id)
    }
    return { ...scene, searchIndex: this.search.get(scene) }
  }

  async workerLinkReport() { return buildWorkerLinkReport(await this.snapshot()) }

  async queue() {
    const snapshot = await this.snapshot()
    const candidates = buildQueue(snapshot)
    const urls = candidates.items.filter(item => item.kind === 'merge')
      .flatMap(item => item.evidence.filter(link => link.kind === 'pull-request').map(link => link.url))
    return buildQueue(snapshot, await this.queuePulls.get(urls))
  }
}

export async function handleReconciliationRequest(sources: ReconciliationSources, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (!['/api/reconciliation/sources', '/api/reconciliation/scene', '/api/reconciliation/queue', '/api/reconciliation/card-context'].includes(path)) return false
  const allowlist = currentOriginAllowlist()
  const headers = { ...resolveCorsHeaders({ origin: req.headers.origin, allowlist }), 'Cache-Control': 'no-store' }
  if (req.headers.origin && !allowlist.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
  if (req.method !== 'GET') return fail(res, 'BAD_REQUEST', 'Read-only endpoint; use GET', { headers })
  if (path === '/api/reconciliation/card-context') {
    const id = new URL(req.url!, 'http://localhost').searchParams.get('id')
    const scene = await sources.scene()
    if (!id || !scene.cards.some(c => c.id === id)) return fail(res, 'NOT_FOUND', 'Unknown authorized card', { headers })
    return ok(res, await sources.card(id), { headers })
  }
  return ok(res, path === '/api/reconciliation/queue' ? await sources.queue() : path === '/api/reconciliation/scene' ? await sources.scene(new URL(req.url!, 'http://localhost').searchParams.get('refresh') === '1') : await sources.snapshot(), { headers })
}
