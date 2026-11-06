import type { AuditContext } from '../../shared/janitor'
import { buildJanitorReport, type AuditInput, type AuditOptions } from './report'
import type { FeatureCache } from './evidence'

export interface AuditReadOptions extends AuditOptions {
  contextLimit?: number
  contextCards?: string[]
  readContext?: (id: string) => Promise<AuditContext>
}

/** Reusable cache is process-local. The daily scheduler/review store are separate later slices. */
export class JanitorAuditor {
  private cache: FeatureCache = new Map()

  async run(input: AuditInput, options: AuditReadOptions = {}) {
    const started = performance.now()
    const contexts = { ...input.contexts }
    const initial = buildJanitorReport({ snapshot: input.snapshot, contexts }, { ...options, cache: this.cache })
    const operational = new Set(initial.scope.operationalIds)
    const preferred = [...(options.contextCards ?? []), ...initial.proposals.filter(p => ['duplicates', 'overlaps', 'superseded'].includes(p.category))
      .flatMap(p => p.pages.map(page => page.id)), ...initial.proposals.filter(p => p.category === 'stale-or-no-action').flatMap(p => p.pages.map(page => page.id))]
    const selected = [...new Set(preferred)].filter(id => operational.has(id) && !contexts[id]).slice(0, options.contextLimit ?? 12)
    let contextReads = 0
    if (options.readContext) for (const id of selected) {
      contextReads++
      try { contexts[id] = await options.readContext(id) }
      catch { contexts[id] = { outcome: 'unavailable', blocks: [], omissions: 'Bounded source read failed; no inference or retry fallback' } }
    }
    const report = contextReads ? buildJanitorReport({ snapshot: input.snapshot, contexts }, { ...options, cache: this.cache }) : initial
    return { input: { snapshot: input.snapshot, contexts }, report: { ...report,
      metrics: { ...report.metrics, contextReads, contextReadLimit: options.contextLimit ?? 12, runtimeMs: Math.round(performance.now() - started),
        cacheHits: initial.metrics.cacheHits + (contextReads ? report.metrics.cacheHits : 0),
        cacheMisses: initial.metrics.cacheMisses + (contextReads ? report.metrics.cacheMisses : 0) } } }
  }
}
