import type { ToolRegistrar } from './toolCatalog'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { releasePull } from '../../shared/releases'
import type { PullsApi } from '../pulls/routes'
import type { ReleasesApi } from '../releases/routes'

const pagination = {
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(100).default(25),
}
const pullUrl = z.string().max(2048).refine(value => releasePull(value) !== null, 'Use a GitHub PR URL')
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const unauthorized = {
  outcome: 'unauthorized',
  prerequisite: 'A configured verified owner binding for MCP PR reads is required. Both the installation credential and the separate granted caller credential must match. Caller IDs, localhost and forwarded owner headers alone grant no PR access.',
}
function page<T>(rows: T[], offset: number, limit: number) {
  return { items: rows.slice(offset, offset + limit), total: rows.length,
    next_offset: offset + limit < rows.length ? offset + limit : null }
}

/** Thin facades over the instances serving the UI; no cache or association store.
 * The authorization hook is server-owned, never derived from tool arguments or
 * unverified identity headers. It defaults to denying PR reads. */
export class DomainReadTools {
  constructor(private pulls: Pick<PullsApi, 'read' | 'inspect'>, private releases: Pick<ReleasesApi, 'read'>,
    private authorizePulls: (request?: IncomingMessage) => Promise<boolean> = async () => false) {}

  async listPulls({ offset, limit }: { offset: number; limit: number }, request?: IncomingMessage) {
    if (!await this.authorizePulls(request)) return unauthorized
    try {
      const data = await this.pulls.read(), rows = page(data.pulls, offset, limit)
      return { outcome: 'available', ...data, pulls: rows.items, pagination: { total: rows.total, next_offset: rows.next_offset },
        omissions: ['CI, reviews and files require get_pr with the captured head. Inventory alone does not establish review need or merge readiness.'] }
    } catch { return { outcome: 'unavailable', message: 'PR Operations sources unavailable; inventory and linkage are unknown.' } }
  }
  async getPull({ url, head, include_files, offset, limit }: { url: string; head: string; include_files: boolean; offset: number; limit: number }, request?: IncomingMessage) {
    if (!await this.authorizePulls(request)) return unauthorized
    try {
      const data = await this.pulls.inspect(url, head, include_files)
      const files = data.footprint ? page(data.footprint.files, offset, limit) : null
      return { outcome: 'available', ...data,
        footprint: data.footprint && files ? { ...data.footprint, files: files.items, pagination: { total: files.total, next_offset: files.next_offset } } : null,
        omissions: ['Observed checks and reviews do not establish merge permission or satisfaction of branch policy.', ...(!include_files ? ['File metadata was not requested.'] : [])] }
    } catch {
      // Do not serialize CLI errors: they can contain private stderr/credentials.
      return { outcome: 'unavailable', message: 'PR unavailable in the authenticated scope, source read failed, or captured head changed. Refresh list_prs and retry with its current URL and head.' }
    }
  }
  async releaseStatus({ offset, limit }: { offset: number; limit: number }) {
    try {
      const data = await this.releases.read(false)
      const pulls = page(data.pulls, offset, limit), exceptions = page(data.unassociatedCards, offset, limit)
      const cards = data.reconciliation ? page(data.reconciliation.cards, offset, limit) : null
      const targets = data.reconciliation ? page(data.reconciliation.targets, offset, limit) : null
      // Keep every feed warning and dry-run eligibility/receipt field. Pagination
      // applies independently to each collection, so no missing section becomes
      // an apparent zero. UI automation drafts are intentionally not exported.
      return { outcome: 'available', generatedAt: data.generatedAt, pulls: pulls.items, unassociatedCards: exceptions.items,
        warnings: data.warnings, associationsComplete: data.associationsComplete, associationsWritable: false, githubSync: data.githubSync,
        reconciliation: data.reconciliation ? { ...data.reconciliation, cards: cards!.items, targets: targets!.items } : null,
        pagination: { pulls: { total: pulls.total, next_offset: pulls.next_offset },
          unassociatedCards: { total: exceptions.total, next_offset: exceptions.next_offset },
          cards: cards ? { total: cards.total, next_offset: cards.next_offset } : null,
          targets: targets ? { total: targets.total, next_offset: targets.next_offset } : null },
        omissions: ['Read-only release reconciliation. No automation drafts or transitions. Shipment requires the reported production receipt and ancestry evidence; tags alone are insufficient.'] }
    } catch { return { outcome: 'unavailable', message: 'Release sources unavailable; queue, associations and production status are unknown.' } }
  }
}

export function registerDomainReadTools(server: ToolRegistrar, readers?: DomainReadTools, request?: IncomingMessage) {
  server.registerTool('list_prs', { description: 'Read the same scoped open PR inventory as PR Operations, with canonical repository#number IDs, captured heads, many-to-many card links and explicit repository/association coverage. CI/review need is unknown until get_pr. Requires a configured grant verifying installation and caller credentials for an existing owner.', inputSchema: pagination, annotations: readAnnotations }, async input => result(readers ? await readers.listPulls(input, request) : unauthorized))
  server.registerTool('get_pr', { description: 'Inspect one PR URL at its captured head using shared PR Operations detail/check/review/file and attribution readers. Refresh list_prs after a head change. Partial/stale evidence is not merge readiness. No patches or terminal transcripts. Requires a configured verified owner binding.', inputSchema: { url: pullUrl, head: z.string().regex(/^[a-f0-9]{40,64}$/), include_files: z.boolean().default(false), ...pagination }, annotations: readAnnotations }, async input => result(readers ? await readers.getPull(input, request) : unauthorized))
  server.registerTool('get_release_status', { description: 'Read the Releases PR-first queue, shared card links, production receipt/ancestry reconciliation and opt-in verification requirements. Missing/stale/partial evidence stays explicit and never proves shipment. offset/limit paginate pulls, card exceptions, eligibility cards and targets independently. Read-only.', inputSchema: pagination, annotations: readAnnotations }, async input => result(readers ? await readers.releaseStatus(input) : { outcome: 'unavailable', message: 'Release reader unavailable; queue and production status are unknown.' }))
}
