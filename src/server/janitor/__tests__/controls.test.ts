import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { syntheticJanitorControls } from '../../../../test-fixtures/janitor/semanticControls'
import { buildJanitorReport } from '../report'
import { runSemanticPilot, semanticClusters } from '../semantic'

let root = ''
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { force: true, recursive: true }) })
it('passes four separately labelled synthetic duplicate controls through the same slice A and model proposal pipeline', async () => {
  root = await mkdtemp(join(tmpdir(), 'janitor-controls-')); vi.stubEnv('TINSTAR_CONFIG_HOME', root)
  const { input, cases } = syntheticJanitorControls('2026-11-06T16:00:00.000Z')
  expect(input.snapshot.scope).toContain('SYNTHETIC')
  const clusters = semanticClusters(buildJanitorReport(input), input).filter(cluster => cases.some(c =>
    c.pageIds.length === cluster.pages.length && c.pageIds.every(id => cluster.pages.some(p => p.id === id))))
  expect(clusters).toHaveLength(4)
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/api/ps')) return Response.json({ models: [] })
    const envelope = JSON.parse(JSON.parse(options!.body as string).messages[1].content)
    return Response.json({ message: { content: JSON.stringify({ classification: 'possible_duplicate', confidence: 'high', reason: 'The same work has equivalent acceptance and a shared canonical PR.',
      abstainReason: null, survivorId: envelope.pages[0].id, drafts: [{ pageId: envelope.pages[0].id, description: 'SYNTHETIC shared work', currentState: 'SYNTHETIC proposal awaiting review', nextAction: 'SYNTHETIC compare and review' }],
      citations: envelope.pages.map((p: { id: string }) => ({ pageId: p.id, evidenceId: envelope.evidence.find((e: { pageId: string }) => e.pageId === p.id).evidenceId })) }) } })
  }
  const result = await runSemanticPilot(clusters, { maxCalls: 4, maxTokens: 100_000 }, fetcher)
  expect(result.proposals).toHaveLength(4)
  expect(result.proposals.every(p => p.reply?.classification === 'possible_duplicate' && p.pages.every(page => page.title.startsWith('SYNTHETIC:')))).toBe(true)
  expect(result.proposals.every(p => p.preview.length === 1 && p.applyPreconditions.authorization === 'not-authorized')).toBe(true)
  expect(result.metrics).toMatchObject({ modelCalls: 4, corroborationAbstentions: 0, abstentions: 0, writeCalls: 0, externalInferenceCalls: 0 })
})
