import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { buildJanitorReport } from '../report'
import { semanticClusters } from '../semantic'
import { evaluateJanitorSample } from '../pilot'

let root = ''
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { force: true, recursive: true }) })
it('evaluates prelabelled real candidate identities, exposing unavailable/budget abstentions and measured denominators', async () => {
  root = await mkdtemp(join(tmpdir(), 'janitor-pilot-')); vi.stubEnv('TINSTAR_CONFIG_HOME', root)
  const snapshot = fixtureSources({ now: Date.parse('2026-11-06T15:00:00.000Z'), size: 175 }); snapshot.fleet = []
  const input = { snapshot }
  const clusters = semanticClusters(buildJanitorReport(input), input).slice(0, 25)
  expect(clusters).toHaveLength(25)
  const sample = { recordedAt: snapshot.generatedAt, snapshotAt: snapshot.generatedAt, notes: 'Controlled negative/unknown cases.',
    cases: clusters.map(c => ({ clusterId: c.id, expected: ['abstain'], group: 'stale-active', rationale: 'Bounded incomplete source; no completion claim.' })) }
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/api/ps')) return Response.json({ models: [] })
    const body = JSON.parse(options?.body as string), envelope = JSON.parse(body.messages[1].content)
    return Response.json({ message: { content: JSON.stringify({ classification: 'abstain', confidence: 'low', reason: 'Incomplete evidence',
      abstainReason: 'Cannot establish absence', survivorId: null, drafts: [],
      citations: envelope.pages.map((p: { id: string }) => ({ pageId: p.id, evidenceId: envelope.evidence.find((e: { pageId: string }) => e.pageId === p.id).evidenceId })) }) },
      eval_count: 10, prompt_eval_count: 100, eval_duration: 1e9, prompt_eval_duration: 1e9 })
  })
  const result = await evaluateJanitorSample(input, sample, { maxCalls: 1 }, fetcher)
  expect(result.metrics).toMatchObject({ sampleSize: 25, modelCalls: 1, negativeCases: 25, falsePositives: 0, falsePositiveRate: 0,
    abstainRate: 1, modelAbstainRate: 1, schemaRejectRate: 0, expectedMatches: 25, inferenceSeconds: 2, writeCalls: 0 })
  expect(result.cases[1]?.outcome).toBe('abstain')
  expect(result.metrics.latencyMs.median).toBeTypeOf('number')
  const calls = fetcher.mock.calls.length
  await expect(evaluateJanitorSample(input, { ...sample, cases: sample.cases.slice(0, 24) }, {}, fetcher)).rejects.toThrow()
  await expect(evaluateJanitorSample(input, { ...sample, cases: sample.cases.map(c => ({ ...c, clusterId: 'invented' })) }, {}, fetcher)).rejects.toThrow()
  await expect(evaluateJanitorSample(input, { ...sample, snapshotAt: '2026-11-05T15:00:00.000Z' }, {}, fetcher)).rejects.toThrow('saved source snapshot')
  expect(fetcher.mock.calls).toHaveLength(calls)
})
