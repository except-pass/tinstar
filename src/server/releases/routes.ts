import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ReconciliationSources } from '../reconciliation'
import { getConfigRoot } from '../configRoot'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { fail, ok } from '../api/envelope'
import { releaseChanges } from '../../shared/releaseChanges'
import { releaseAssociations } from '../../shared/releases'
import { AssociationConflict, AssociationStore, associationInput } from './associations'
import { ReleasePullReader } from './pulls'
import { ReleaseEvidenceReader } from './evidence'
import { ReleaseReconciler } from './reconcile'
import { readReleaseWriteRecords } from './writer'
import { planReleaseAutomation, readAutomationSettings } from './automation'
import { readAcceptanceRecords, readAcceptanceSettings } from './acceptance'
import { ReleaseObjectReader } from './objects'

async function ownerLogins(root: string): Promise<string[]> {
  try {
    const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    return z.array(z.string().min(1)).parse(config.ask?.ownerLogins)
  } catch { return [] }
}
/** GET produces observations/proposals only, never executes the scheduled writer. */
export class ReleasesApi {
  readonly store: AssociationStore
  private releaseObjects = new ReleaseObjectReader()
  constructor(private sources: Pick<ReconciliationSources, 'scene'>, private root = getConfigRoot(), private pulls = new ReleasePullReader(), private owners = ownerLogins, private evidence = new ReleaseEvidenceReader(root), private reconciler = new ReleaseReconciler()) {
    this.store = new AssociationStore(root)
  }
  /** Shared authorized-source projection for Releases and contextual Ask. */
  async read(writable = false, force = false) {
    const scene = await this.sources.scene(force, { history: true })
    let events: Awaited<ReturnType<AssociationStore['read']>> = [], warning: string | undefined
    try { events = await this.store.read() } catch { warning = 'Local association audit unavailable; manual associations cannot be verified' }
    const data = releaseAssociations(scene, events)
    data.associationsWritable = writable && !warning
    if (warning) { data.associationsComplete = false; data.warnings.push(warning); for (const pull of data.pulls) pull.exceptions.push(warning) }
    const observations = await this.pulls.get(data.pulls.map(pull => pull.url))
    for (const pull of data.pulls) {
      Object.assign(pull, observations.get(pull.url))
      if (pull.readError) pull.exceptions.push(pull.readError)
      else if (pull.freshness !== 'fresh') pull.exceptions.push('GitHub merge evidence pending, stale or unavailable')
      else if (pull.state !== 'merged') pull.exceptions.push(pull.state === 'open' ? 'PR has not merged' : 'PR closed without merge')
    }
    const errors = [...new Set(data.pulls.flatMap(pull => pull.readError ? [pull.readError] : []))]
    data.githubSync = { status: errors.length ? 'error' : data.pulls.some(pull => pull.freshness !== 'fresh') ? 'pending' : 'ok', errors }
    const evidence = await this.evidence.get()
    const reconciled = await this.reconciler.get(data, scene, evidence, await readReleaseWriteRecords(this.root))
    reconciled.automation = planReleaseAutomation(reconciled, scene, await readAutomationSettings(this.root))
    try { reconciled.acceptanceWorkflows = (await readAcceptanceSettings(this.root)).checks }
    catch { reconciled.acceptanceWorkflows = {} }
    try { reconciled.acceptanceRecords = await readAcceptanceRecords(this.root) }
    catch { reconciled.acceptanceRecords = []; reconciled.warnings.push('Acceptance receipt store is unreadable; no passing results can be established.') }
    reconciled.releases = await this.releaseObjects.get(evidence, reconciled, scene)
    const visibleChecks = new Set(reconciled.releases.flatMap(release => releaseChanges(release, reconciled, scene).flatMap(change => (change.checks ?? []).map(check => check.key))))
    reconciled.acceptanceRecords = reconciled.acceptanceRecords.filter(record => visibleChecks.has(record.key))
    const acceptanceWarning = reconciled.warnings.find(message => message.startsWith('Acceptance receipt store'))
    if (acceptanceWarning) for (const release of reconciled.releases) release.gaps.push(acceptanceWarning)
    return reconciled
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0]
    if (!['/api/releases', '/api/releases/associations', '/api/releases/reconciliation', '/api/releases/automation'].includes(path!)) return false
    const allowlist = currentOriginAllowlist(), origin = req.headers.origin
    const headers = { ...resolveCorsHeaders({ origin, allowlist }), 'Access-Control-Allow-Headers': 'Content-Type, X-Tinstar-UI', 'Cache-Control': 'no-store', Vary: 'Tailscale-User-Login, Origin' }
    if (origin && !allowlist.includes(origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const login = req.headers['tailscale-user-login']
    // Same tailnet owner boundary as Ask: only the local serve proxy injects this identity.
    const writable = (peer === '::1' || peer.startsWith('127.')) && typeof login === 'string' && (await this.owners(this.root)).includes(login)
    try {
      if (path !== '/api/releases/associations' && req.method === 'GET') {
        const reconciled = await this.read(writable)
        return ok(res, path === '/api/releases/automation' ? reconciled.automation : path === '/api/releases/reconciliation' ? reconciled.reconciliation : reconciled, { headers })
      }
      if (path !== '/api/releases/associations' || req.method !== 'POST') return fail(res, 'BAD_REQUEST', 'Use GET for Releases or POST for a local association', { headers })
      if (!writable || req.headers['x-tinstar-ui'] !== '1') return fail(res, 'FORBIDDEN', 'Authorized tailnet owner and UI handshake required', { headers })
      if (!req.headers['content-type']?.startsWith('application/json')) return fail(res, 'BAD_REQUEST', 'Expected JSON', { headers })
      const chunks: Buffer[] = []; let bytes = 0
      const timeout = setTimeout(() => req.destroy(), 10_000)
      let input: z.infer<typeof associationInput>
      try {
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk)
          if (bytes > 16 * 1024) return fail(res, 'BAD_REQUEST', 'Association payload too large', { headers })
          chunks.push(Buffer.from(chunk))
        }
        input = associationInput.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } finally { clearTimeout(timeout) }
      const scene = await this.sources.scene()
      // Do not attach an arbitrary inaccessible card. Unlink remains possible for retired local edges.
      if (input.action === 'link' && !scene.cards.some(card => card.id === input.cardId && !card.source.in_trash && !card.source.archived)) return fail(res, 'NOT_FOUND', 'Card unavailable in the authorized source', { headers })
      return ok(res, await this.store.append(input, String(login)), { headers })
    } catch (error) {
      if (error instanceof AssociationConflict) return fail(res, 'CONFLICT', error.message, { headers })
      if (error instanceof z.ZodError || error instanceof SyntaxError) return fail(res, 'BAD_REQUEST', 'Invalid association request', { headers })
      return fail(res, 'BACKEND_UNAVAILABLE', 'Release sources or local association audit unavailable', { headers })
    }
  }
}
