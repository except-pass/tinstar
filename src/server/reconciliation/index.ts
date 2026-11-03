import type { IncomingMessage, ServerResponse } from 'node:http'
import { ok, fail } from '../api/envelope'
import { resolveCorsHeaders } from '../api/cors'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { loadReconciliationConfig, type ReconciliationConfig, type FleetSource } from './config'
import { fleetObservation } from './fleet'
import { notionObservation } from './notion'
import { ageObservation } from './observation'
import { SceneReconciler } from './scene'

export type SourceSnapshot = Awaited<ReturnType<ReconciliationSources['snapshot']>>

/** Shared read-only collection and scene projection; no domain actions. */
export class ReconciliationSources {
  private fleet
  private notion
  private reconciler = new SceneReconciler()

  constructor(private readonly config: ReconciliationConfig = loadReconciliationConfig()) {
    this.fleet = config.fleet.map(source => ({ source, observation: fleetObservation(source) }))
    this.notion = notionObservation(config.notion)
  }

  async snapshot() {
    // At most four local snapshot processes at once, even for a large farm.
    const homes: Array<{ source: FleetSource & { machineBasis: string }; observation: Awaited<ReturnType<ReturnType<typeof fleetObservation>['get']>> }> = []
    const notion = this.notion.get()
    for (let offset = 0; offset < this.fleet.length; offset += 4) {
      homes.push(...await Promise.all(this.fleet.slice(offset, offset + 4).map(async ({ source, observation }) => ({
        source: { ...source, machineBasis: source.machine ? 'configured' : 'unknown' }, observation: await observation.get(),
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

  async scene() { return this.reconciler.reconcile(await this.snapshot()) }
}

export async function handleReconciliationRequest(sources: ReconciliationSources, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0]
  if (path !== '/api/reconciliation/sources' && path !== '/api/reconciliation/scene') return false
  const allowlist = currentOriginAllowlist()
  const headers = { ...resolveCorsHeaders({ origin: req.headers.origin, allowlist }), 'Cache-Control': 'no-store' }
  if (req.headers.origin && !allowlist.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
  if (req.method !== 'GET') return fail(res, 'BAD_REQUEST', 'Read-only endpoint; use GET', { headers })
  return ok(res, path === '/api/reconciliation/scene' ? await sources.scene() : await sources.snapshot(), { headers })
}
