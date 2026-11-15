/** P5 isolated running-UI fixture partition. Build client first.
 * node --import tsx scripts/decision-desk-ui-preview.ts /absolute/proof-directory
 * Uses only fresh task-owned roots and a disposable Notion-compatible source;
 * no live root, credentials, board, bridge, runner or preparation scheduling.
 * Scenario/fault controls are preview server endpoints, never production UI. */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { decisionSubmitFixture } from '../test-fixtures/reconciliation/decisionSubmit'
import { DecisionDeskApi } from '../src/server/reconciliation/decisionDeskApi'
import { PreparedReviews } from '../src/server/reconciliation/preparedReviews'
import { PreparedSubmissions } from '../src/server/reconciliation/preparedSubmissions'
import { PullsApi } from '../src/server/pulls/routes'
import { AssociationStore } from '../src/server/releases/associations'
import { SceneReconciler } from '../src/server/reconciliation/scene'
import { buildQueue } from '../src/server/reconciliation/queue'
import { needsWill } from '../src/server/reconciliation/needsWill'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { boundSearchDocuments, sceneSearchDocuments } from '../src/shared/searchDocuments'
import type { DecisionPacket, DecisionEvidence } from '../src/shared/decisionPacket'

if (!process.argv[2]) throw new Error('Task proof directory required')
const output = resolve(process.argv[2]); await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'isolated-ui-'))
process.env.TINSTAR_CONFIG_HOME = root
await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'isolated-ui-only-no-live-bridge-123456789' }, reconciliation: { fleet: [] } }), { mode: 0o600 })
let scenario = 'normal', partition = 0
function extendEvidence(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'expiresAt' || key === 'expires_at') && typeof item === 'string') (value as Record<string, unknown>)[key] = new Date(Date.now() + 7200_000).toISOString()
    else if (item && typeof item === 'object') extendEvidence(item)
  }
}
async function makePartition(name: string) {
  scenario = name
  const taskRoot = await mkdtemp(join(root, `${++partition}-${name}-`))
  const fixture = decisionSubmitFixture(name === 'recorded-empty' ? 1 : name === 'preparation' ? 5 : 3)
  for (const f of fixture.fixtures) {
    extendEvidence(f.snapshot); extendEvidence(f.history); extendEvidence(f.evidence)
    f.packet.title = 'Fixture · Authorize an isolated release rehearsal?'
    f.packet.question = f.packet.binding.source_question
    f.packet.background = 'The release workflow needs one rehearsal against a disposable preview source before its operator review. Existing source requests and answer receipts will be checked without touching customer data, devices or the live board.'
    f.packet.rationale = 'Use the isolated rehearsal to verify source-bound answers and recovery before requesting any supervised rollout. This answer permits only the explicitly bounded preview work.'
    f.packet.authorization.scope = 'Authorize one isolated DEV rehearsal using disposable fixture data only.'
    f.packet.authorization.permitted_follow_up = 'Collect readback receipts and screenshots, then return the evidence for review.'
    f.packet.references = [{ label: 'Fixture source card (synthetic)', url: `https://www.notion.so/${f.cardId}` }]
    if (name === 'no-requests') {
      f.evidence.requests = []; f.history.context.blocks = []; fixture.comments.set(f.cardId, [])
      for (const home of f.snapshot.fleet) { for (const task of home.observation.data?.tasks ?? []) if (task.queue) task.queue.decisions = []; for (const hold of home.observation.data?.backlog ?? []) hold.captain_actionable = false }
      const card = f.snapshot.intentions.data!.cards.find(card => card.id === f.cardId)!
      card.properties['Will action']!.value = []; card.properties['Next action']!.value = null
      fixture.pages.get(f.cardId)!.properties['Will action'] = { id: 'Will action', type: 'multi_select', multi_select: [] }
    }
    if (name === 'source-unavailable') f.evidence.reasons.push('Source evidence unavailable in the isolated fixture')
    if (name === 'low-confidence') { f.packet.confidence = 'Low'; f.packet.uncertainty = ['Device and production behavior have not been verified.', 'The rehearsal does not establish customer rollout readiness.'] }
    if (name === 'high-risk') { f.packet.risk.rating = 'High'; f.packet.risk.explanation = 'An incorrect rehearsal recipient could expose synthetic operational messages.'; f.packet.reversibility.rating = 'Difficult'; f.packet.reversibility.residual_exposure = 'Delivered test communications cannot be recalled.' }
    if (name === 'long-content') {
      f.packet.title = 'Fixture · Authorize a tightly bounded rehearsal of the source-bound decision review workflow with exceptionally long operational names and source provenance?'
      f.packet.background = ('This deliberately long fixture checks wrapping and readable Markdown. **No production authorization.** ' + 'long-unbroken-identifier-'.repeat(12) + '\n\n').repeat(8)
      f.packet.risk.explanation = 'Long rationale: '.repeat(35)
    }
  }
  const first = fixture.fixtures[0]!
  if (name === 'independent-requests') {
    const source = { ...first.packet.binding.source_request, id: 'independent-format' }
    const home = first.snapshot.fleet.find(home => home.source.home === source.home)!.observation.data!
    const hold = structuredClone(home.backlog!.find(row => row.id === first.packet.binding.source_request.id)!)
    hold.id = source.id; hold.hold_reason = 'Authorize the independent evidence format?'; hold.title = hold.hold_reason
    home.backlog!.push(hold); home.tasks[0]!.queue!.decisions.push({ key: source.id, verb: 'needs-decision', summary: hold.hold_reason })
    fixture.comments.get(first.cardId)!.push({ id: 'source-format', rich_text: [{ text: { content: `Operation: request_decision\nRequested from: Will\nQuestion: ${hold.hold_reason}\nTin Star request: ${JSON.stringify({ id: 'format-request', action: 'Decision', preserve_action: false, source_request: source, source_question: hold.hold_reason, source_spawn_gen: 'attempt-1', options: [{ id: 'table', label: 'Use a table' }, { id: 'prose', label: 'Use prose' }] })}` } }] })
  }
  const backend = await fixture.build(taskRoot)
  const update = async (card: string, evidence: DecisionEvidence) => { fixture.fixtures.find(f => f.cardId === card)!.evidence = evidence }
  if (name === 'independent-requests') {
    // Read using the first fixture's actual source workflow, not packet prose.
    const firstStored = (await Promise.all((await backend.packets.ids()).map(id => backend.packets.read(id)))).find(value => value?.packet.binding.card_id === first.cardId)!
    const all = await backend.source.evidence(firstStored)
    await update(first.cardId, all)
    for (const request of all.requests) {
      if (!request.binding) continue
      const packet: DecisionPacket = { ...structuredClone(first.packet), binding: request.binding, question: request.question!,
        recommended_option_id: request.binding.options[0]!.id, dependencies: request.dependencies.map(dep => ({ kind: dep.kind, key: dep.key, revision: dep.revision! })) }
      if (request.binding.request_id === 'preview-question') first.packet = packet
      await backend.packets.publish(packet, all, 'isolated-ui-fixture', `independent-${request.binding.request_id}`)
    }
  }
  const review = new PreparedReviews(backend.packets, 'isolated-ui-board', card => fixture.fixtures.find(f => f.cardId === card)!.evidence,
    () => { if (fixture.controls.queueUnavailable) throw new Error('Isolated next allocation unavailable'); return ({ card_ids: name === 'no-requests' ? [] : fixture.fixtures.map(f => f.cardId), coverage: name === 'source-unavailable' ? 'unknown' : 'complete', requests: name === 'no-requests' ? 0 : name === 'source-unavailable' ? null : fixture.fixtures.reduce((sum, f) => sum + f.evidence.requests.filter(r => !r.answered).length, 0) }) })
  const submissions = new PreparedSubmissions(review, backend.source)
  if (name === 'no-prepared' || name === 'preparation') for (const id of (await backend.packets.ids())) await backend.packets.leases.writeStorage(db => db.prepare("INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,'research-requested','fixture',?,?)").run(id, new Date().toISOString(), JSON.stringify({ reason: 'Fixture pending research' })))
  if (name === 'save-failed') fixture.controls.reject = true
  if (name === 'save-unconfirmed') fixture.controls.loseIntent = true
  const scene = async () => {
    const value = new SceneReconciler().reconcile(first.snapshot)
    return { ...value, searchIndex: boundSearchDocuments(sceneSearchDocuments(value)) }
  }
  const auth = new PullsApi({ scene }, new AssociationStore(taskRoot), root)
  const api = new DecisionDeskApi(backend.packets, 'isolated-ui-board', card => fixture.fixtures.find(f => f.cardId === card)!.evidence, req => auth.authorized(req), review, undefined, submissions)
  return { api, fixture, backend, review, submissions, first, scene, taskRoot }
}
let current = await makePartition('normal')
const clientDir = resolve('dist/client')
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://preview').pathname
    if (path === '/__preview/scenario' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const { name } = JSON.parse(Buffer.concat(chunks).toString())
      if (!['normal', 'preparation', 'independent-requests', 'low-confidence', 'high-risk', 'invalidated', 'lease-lost', 'save-failed', 'save-unconfirmed', 'recorded-empty', 'next-unavailable', 'no-requests', 'no-prepared', 'backend-unavailable', 'source-unavailable', 'long-content'].includes(name)) throw new Error('Unknown fixture')
      current = await makePartition(name); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ fixture: true, scenario, root: current.taskRoot })); return
    }
    if (path === '/__preview/state' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ scenario, source_writes: current.fixture.writes.length, source_answers: [...current.fixture.comments.values()].flat().filter(note => JSON.stringify(note).includes('Operation: answer_decision')).length })); return }
    if (path === '/__preview/resolve' && req.method === 'POST') { current.fixture.controls.reject = false; current.fixture.controls.loseIntent = false; current.fixture.controls.evidenceChanged = false; res.end('Fixture fault cleared'); return }
    if (path === '/__preview/fault' && req.method === 'POST') {
      if (scenario === 'invalidated') { current.first.evidence.requests[0]!.binding!.source_revision = 'changed-source-revision'; current.fixture.controls.evidenceChanged = true }
      if (scenario === 'next-unavailable') current.fixture.controls.queueUnavailable = true
      if (scenario === 'lease-lost') await current.backend.leases.writeStorage(db => db.prepare('UPDATE leases SET expires = ?').run(Date.now() - 1))
      res.end('Fixture fault applied'); return
    }
    if (path.startsWith('/api/reconciliation/decision-desk/')) {
      if (scenario === 'backend-unavailable') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: 'Isolated fixture backend unavailable' } })); return }
      // Trusted owner injection exists only on this loopback fixture server.
      req.headers['tailscale-user-login'] = 'preview-owner@example.test'
      await appendFile(join(output, 'api-operations.jsonl'), JSON.stringify({ at: new Date().toISOString(), scenario, path, method: req.method }) + '\n')
      if (await current.api.handle(req, res)) return
    }
    let data: unknown
    if (req.method === 'GET' && path === '/api/reconciliation/scene') data = await current.scene()
    else if (req.method === 'GET' && path === '/api/reconciliation/queue') { const queue = buildQueue(current.first.snapshot); queue.needsWill = needsWill(queue, await current.scene(), new Map([[current.first.cardId, current.first.history.context]]), null, new Map(), false); data = queue }
    else if (req.method === 'GET' && path === '/api/reconciliation/card-context') data = current.first.history.context
    else if (req.method === 'GET' && path === '/api/fleet') data = { ready: true, workers: [], attention: [], messages: [], errors: [] }
    else if (req.method === 'GET' && path === '/api/ask/requests') data = []
    else if (path.startsWith('/api/')) { res.writeHead(404); res.end('Unsupported in isolated UI partition'); return }
    if (data !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); return }
    const file = path.startsWith('/assets/') ? resolve(clientDir, `.${path}`) : join(clientDir, 'index.html')
    if (!file.startsWith(`${clientDir}/`)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res)
  } catch (error) { await appendFile(join(output, 'preview-errors.log'), `${new Date().toISOString()} ${String(error)}\n`); if (!res.headersSent) res.writeHead(500); res.end('Isolated UI preview error') }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port; seedOriginAllowlist(port)
const manifest = { url: `http://127.0.0.1:${port}/?view=decisions`, config_root: root, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixture: true, host: execFileSync('hostname', { encoding: 'utf8' }).trim(), source: 'Disposable Notion-compatible in-process adapter with independent request records; no live source or bridge' }
await writeFile(join(output, 'ui-preview.json'), JSON.stringify(manifest, null, 2)); process.stdout.write(JSON.stringify(manifest) + '\n')
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
