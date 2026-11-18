import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardLeases } from '../cardLeases'
import { DecisionPackets } from '../decisionPackets'
import { DecisionDeskApi } from '../decisionDeskApi'
import { seedOriginAllowlist } from '../../api/originAllowlist'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { PullsApi } from '../../pulls/routes'
import { AssociationStore } from '../../releases/associations'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { boundSearchDocuments, sceneSearchDocuments } from '../../../shared/searchDocuments'

let root: string, server: Server | undefined
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); if (root) await rm(root, { recursive: true, force: true }) })

it('serves isolated evidence/storage APIs through existing owner authentication and rejects conflicting saves', async () => {
  root = await mkdtemp(join(tmpdir(), 'decision-desk-api-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'fixture-only-not-a-live-credential-123456789' } }))
  const fixture = preparedDecisionFixture(), leases = new CardLeases(root), packets = new DecisionPackets(leases)
  const published = await packets.publish(fixture.packet, fixture.evidence, 'fixture', 'publication')
  const evidence = vi.fn(() => fixture.evidence), auth = new PullsApi({ scene: async () => {
    const scene = fixtureScene()
    return { ...scene, searchIndex: boundSearchDocuments(sceneSearchDocuments(scene)) }
  } }, new AssociationStore(root), root)
  const api = new DecisionDeskApi(packets, 'fixture-board', evidence, req => auth.authorized(req))
  server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}/api/reconciliation/decision-desk`
  seedOriginAllowlist(port)
  const headers = { 'Tailscale-User-Login': 'preview-owner@example.test', 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }
  expect((await fetch(`${base}/policy`)).status).toBe(403)
  expect((await fetch(`${base}/policy`, { headers: { ...headers, 'Tailscale-User-Login': 'intruder' } })).status).toBe(403)
  expect((await fetch(`${base}/policy`, { headers: { ...headers, Origin: 'https://evil.test' } })).status).toBe(403)
  expect((await fetch(`${base}/policy`, { headers: { 'Tailscale-User-Login': 'preview-owner@example.test' } })).status).toBe(403)
  expect((await (await fetch(`${base}/policy`, { headers })).json()).data).toMatchObject({ version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: false } })
  const update = { expected_version: 0, values: { target_ready: 8, max_preparers: 2, automatic_replenishment: true } }
  const saved = await fetch(`${base}/policy`, { method: 'PUT', headers, body: JSON.stringify(update) })
  expect(saved.status).toBe(200); expect((await saved.json()).data).toMatchObject({ version: 1, values: update.values, updated_by: 'preview-owner@example.test' })
  expect((await fetch(`${base}/policy`, { method: 'PUT', headers, body: JSON.stringify(update) })).status).toBe(409)
  expect((await fetch(`${base}/policy`, { method: 'PUT', headers, body: JSON.stringify({ ...update, expected_version: 1, values: { ...update.values, max_preparers: 9 } }) })).status).toBe(400)
  expect((await (await fetch(`${base}/policy`, { headers })).json()).data.version).toBe(1)
  expect((await fetch(`${base}/evidence?card_id=invalid`, { headers })).status).toBe(400)
  expect((await (await fetch(`${base}/evidence?card_id=${fixture.cardId}&refresh=1`, { headers })).json()).data).toEqual(fixture.evidence)
  expect((await (await fetch(`${base}/packet?id=${published.id}`, { headers })).json()).data).toMatchObject({ id: published.id, ready: true })
  const inventory = (await (await fetch(`${base}/packets`, { headers })).json()).data
  expect(inventory.packets).toHaveLength(1); expect(inventory).not.toHaveProperty('ready_count')
  expect((await (await fetch(`${base}/events`, { headers })).json()).data.map((event: { type: string }) => event.type)).toEqual(['publication', 'validation', 'policy', 'policy'])
  expect((await fetch(`${base}/packets`, { method: 'POST', headers, body: '{}' })).status).toBe(405)
  expect(leases.status(fixture.cardId)).toBe(null)
  expect(evidence).toHaveBeenCalledTimes(2)
}, 15_000)
