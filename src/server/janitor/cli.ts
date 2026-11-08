import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { SourceSnapshot } from '../reconciliation'
import { notionPageId } from '../reconciliation/notion'
import { auditCategories, type AuditContext } from '../../shared/janitor'
import { JanitorAuditor } from './audit'
import { runSemanticPilot, semanticClusters } from './semantic'
import type { AuditInput, JanitorReport } from './report'

const propertySchema = z.object({ id: z.string().nullable(), type: z.string().nullable(), value: z.unknown(), hasMore: z.boolean() }).passthrough()
// Validate the public source-file boundary, without copying the independent fleet schema.
// Fleet data is consumed by the existing scene/queue projections, which retain its source truth.
const snapshotSchema = z.object({ generatedAt: z.string().datetime(), scope: z.string(), warnings: z.array(z.string()), fleet: z.array(z.unknown()),
  intentions: z.object({ status: z.enum(['fresh', 'partial', 'stale', 'unknown']), coverage: z.enum(['complete', 'partial', 'unknown']),
    observedAt: z.string().nullable(), attemptedAt: z.string(), expiresAt: z.string().nullable(), error: z.string().nullable(),
    data: z.object({ cards: z.array(z.object({ id: z.string().refine(id => !!notionPageId(id)), url: z.string().nullable(), last_edited_time: z.string(),
      archived: z.boolean(), in_trash: z.boolean(), properties: z.record(propertySchema) })), schema: z.record(z.unknown()), hasMore: z.boolean(),
      truncatedRelations: z.array(z.object({ pageId: z.string(), property: z.string() })), missingSchemaProperties: z.array(z.string()) }).passthrough().nullable() }).passthrough() }).passthrough()
const contextSchema = z.object({ outcome: z.enum(['available', 'partial', 'unavailable']), observedAt: z.string().optional(),
  blocks: z.array(z.object({ id: z.string(), type: z.string(), text: z.string() })), omissions: z.string().optional() })

export function parseAuditInput(value: unknown): AuditInput {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const wrapped = object.ok === true ? object.data : object.snapshot ?? value
  const parsed = snapshotSchema.safeParse(wrapped)
  if (!parsed.success) throw new Error('Input must contain an existing Tin Star reconciliation source snapshot (or its ok/data envelope)')
  const contexts = z.record(contextSchema).safeParse(object.contexts ?? {})
  if (!contexts.success) throw new Error('Input contexts must contain outcome, cited blocks and optional observation time')
  return { snapshot: parsed.data as unknown as SourceSnapshot, contexts: contexts.data }
}

export function auditSummary(report: JanitorReport) {
  return [`Card Janitor — read-only, deterministic`, `Snapshot ${report.snapshotAt}; evaluated ${report.evaluatedAt}`,
    `${report.scope.operationalCards} operational / ${report.scope.sourceCards} source cards; excluded ${report.scope.sourceCards - report.scope.operationalCards}; Notion ${report.coverage.notion.status}/${report.coverage.notion.coverage}`,
    ...auditCategories.map(category => `${category}: ${report.categories[category].candidates} candidates, ${report.categories[category].unknown.length} unknown coverage items`),
    `${report.baseline.openDecisionCandidates} existing Desk decision candidates (no new Desk items)`,
    ...auditCategories.flatMap(category => {
      const proposal = report.proposals.find(p => p.category === category)
      return proposal ? [`${proposal.proposal_id} · ${proposal.why}\n  ${proposal.pages.map(p => `${p.id} ${p.url}`).join('\n  ')}\n  Proposed: ${proposal.proposedAction}`] : []
    }),
    `Model calls/tokens: ${report.metrics.modelCalls}/${report.metrics.modelTokens}; writes: ${report.metrics.writeCalls}`,
    'All items are investigation candidates. JSON contains full evidence, freshness, unchanged before/after previews and exclusions.',
  ].join('\n') + '\n'
}

export async function runJanitorCli(args: string[], stdout: (text: string) => void = text => process.stdout.write(text), fetcher: typeof fetch = fetch) {
  const { values } = parseArgs({ args, options: { server: { type: 'string' }, input: { type: 'string' }, format: { type: 'string', default: 'json' },
    'save-input': { type: 'string' }, semantic: { type: 'boolean' }, endpoint: { type: 'string' }, model: { type: 'string' },
    'model-calls': { type: 'string' }, 'model-tokens': { type: 'string' }, 'model-time-ms': { type: 'string' }, 'model-timeout-ms': { type: 'string' }, 'busy-file': { type: 'string' }, 'context-limit': { type: 'string', default: '12' }, 'context-card': { type: 'string', multiple: true }, at: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    stdout('Usage: npm run --silent janitor:report -- (--server URL | --input FILE) [--format json|summary] [--save-input FILE] [--at ISO_TIME] [--context-limit 0..40] [--context-card PAGE_ID ...] [--semantic] [--endpoint PRIVATE_OLLAMA_ORIGIN] [--model NAME] [--model-calls N] [--model-tokens N] [--model-time-ms N] [--model-timeout-ms N] [--busy-file FILE]\nReads existing Tin Star sources and up to 12 candidate card contexts by default. Saved input replays offline. JSON is the default; no Desk item or Notion write. Opt-in --semantic adds bounded local-only proposals (defaults: 4 calls, 32000 conservative token budget, 120000 ms/run, 45000 ms/call). Set --busy-file to the operator reservation marker; a present marker defers inference. Cache: TINSTAR_CONFIG_HOME/janitor/semantic (default ~/.config/tinstar). Endpoint/model may also use TINSTAR_JANITOR_ENDPOINT/TINSTAR_JANITOR_MODEL. No hosted fallback.\n')
    return
  }
  if (!!values.server === !!values.input) throw new Error('Choose one source: --server URL or --input FILE (see --help)')
  if (!['json', 'summary'].includes(values.format!)) throw new Error('--format must be json or summary')
  const limit = Number(values['context-limit'])
  if (!Number.isInteger(limit) || limit < 0 || limit > 40) throw new Error('--context-limit must be an integer from 0 to 40 (bounded Notion read budget)')
  const read = async (path: string) => {
    const response = await fetcher(new URL(path, values.server), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Tin Star source read failed (HTTP ${response.status}); no empty-success fallback`)
    const envelope = await response.json() as { ok?: boolean; data?: unknown }
    if (envelope.ok !== true || envelope.data === undefined) throw new Error('Tin Star source response unavailable')
    return envelope.data
  }
  const input = parseAuditInput(values.input ? JSON.parse(await readFile(values.input, 'utf8')) : await read('/api/reconciliation/sources'))
  const result = await new JanitorAuditor().run(input, { evaluatedAt: values.at,
    contextLimit: limit, contextCards: (values['context-card'] ?? []).flatMap(id => notionPageId(id) ?? []),
    readContext: values.server ? async id => {
      const result = contextSchema.safeParse(await read(`/api/reconciliation/card-context?id=${encodeURIComponent(id)}`))
      return result.success ? result.data as AuditContext : { outcome: 'unavailable', blocks: [], omissions: 'Unsupported card context response' }
    } : undefined })
  if (values['save-input']) await writeFile(values['save-input'], JSON.stringify(result.input, null, 2) + '\n', { mode: 0o600 })
  const budget = (value: string | undefined) => value === undefined ? undefined : Number(value)
  const semantic = values.semantic ? await runSemanticPilot(semanticClusters(result.report, result.input), {
    endpoint: values.endpoint, model: values.model, maxCalls: budget(values['model-calls']), maxTokens: budget(values['model-tokens']),
    maxRunMs: budget(values['model-time-ms']), timeoutMs: budget(values['model-timeout-ms']), busyFile: values['busy-file'],
  }, fetcher) : undefined
  stdout(values.format === 'summary' ? auditSummary(result.report) + (semantic
    ? `Local semantic: ${semantic.metrics.modelCalls} calls, ${semantic.metrics.cacheHits} cache hits, ${semantic.metrics.abstentions} abstentions; ${semantic.warnings.join('; ')}\n`
    : '') : JSON.stringify({ ...result.report, ...(semantic ? { semantic } : {}) }, null, 2) + '\n')
}
