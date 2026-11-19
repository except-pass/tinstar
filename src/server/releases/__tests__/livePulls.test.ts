import { beforeEach, expect, it, vi } from 'vitest'
import { ReleasePullReader } from '../pulls'
import { QueuePullReader } from '../../reconciliation/queuePulls'
import { liveReaderJson } from '../../actions/liveClient'

vi.mock('../../actions/liveClient', () => ({ liveActionsEnabled: () => true, liveReaderJson: vi.fn() }))

const head = 'a'.repeat(40), mergeSha = 'b'.repeat(40)
const url = 'https://github.com/fortresspower/cmsandbox/pull/1'
const path = '/repos/fortresspower/cmsandbox/pulls/1'
const now = Date.parse('2026-11-08T12:00:00Z')
const pull = {
  title: 'Release changes', state: 'open', merged: false, draft: false,
  head: { sha: head }, base: { ref: 'main' }, merged_at: null, merge_commit_sha: null,
  mergeable: true, mergeable_state: 'clean',
}

beforeEach(() => { vi.mocked(liveReaderJson).mockReset() })

it.each([false, true])('observes a Releases PR through live Reader with merged=%s', async merged => {
  vi.mocked(liveReaderJson).mockResolvedValue({ ...pull, merged, state: merged ? 'closed' : 'open',
    merged_at: merged ? '2026-11-08T11:00:00Z' : null, merge_commit_sha: merged ? mergeSha : null })
  const result = await new ReleasePullReader(undefined, () => now).get([url])
  expect(result.get(url)).toEqual({ title: 'Release changes', base: 'main', head,
    state: merged ? 'merged' : 'open', mergedAt: merged ? '2026-11-08T11:00:00Z' : null,
    mergeSha: merged ? mergeSha : null, freshness: 'fresh', observedAt: new Date(now).toISOString() })
  expect(liveReaderJson).toHaveBeenCalledTimes(1)
  expect(liveReaderJson).toHaveBeenCalledWith(path, '.', undefined, expect.any(Function))
})

it('preserves Queue readiness and check projections through live Reader', async () => {
  vi.mocked(liveReaderJson).mockImplementation(async requested => {
    if (requested === path) return pull
    if (requested === `/repos/fortresspower/cmsandbox/commits/${head}/check-runs?per_page=100`) {
      return { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }
    }
    if (requested === `/repos/fortresspower/cmsandbox/commits/${head}/status?per_page=100`) return { total_count: 0, state: 'pending' }
    throw new Error('Unexpected Reader path')
  })
  const result = await new QueuePullReader(undefined, () => now).get([url])
  expect(result.get(url)).toMatchObject({ status: 'fresh', state: 'open', head, draft: false,
    checks: 'passed', mergeability: 'ready' })
  expect(liveReaderJson).toHaveBeenCalledTimes(3)
})

it('lets a dispatched list row replace an overlapping unsent exact failure', async () => {
  let clock = now
  let finishList!: () => void, finishOther!: () => void
  const listGate = new Promise<void>(resolve => { finishList = resolve })
  const otherGate = new Promise<void>(resolve => { finishOther = resolve })
  const otherUrl = (number: number) => `https://github.com/fortresspower/other/pull/${number}`
  const second = url.replace('/1', '/2')
  const page = (state: string) => ({
    rows: [1, 2].map(number => ({ ...pull, number, state, updated_at: new Date(now).toISOString() })),
    count: 2, oldestUpdatedAt: new Date(now).toISOString(),
  })
  vi.mocked(liveReaderJson).mockImplementation(async (requested, _projection, _numbers, onStart) => {
    if (requested === path) throw new Error('GitHub REST rate limited')
    onStart?.(clock)
    if (requested.includes('/other/')) {
      await otherGate
      return page('open')
    }
    await listGate
    return page('closed')
  })
  const reader = new ReleasePullReader(undefined, () => clock)
  const exact = reader.get([url, otherUrl(1), otherUrl(2)])
  const batch = reader.get([url, second])
  try {
    clock += 1_000
    finishOther()
    expect((await exact).get(url)).toMatchObject({ state: 'unknown', readError: 'GitHub REST rate limited' })
  } finally {
    finishOther()
    finishList()
  }
  expect((await batch).get(url)).toMatchObject({ state: 'closed', freshness: 'fresh' })
})

it('preserves dispatched evidence when a subsequent list attempt fails before dispatch', async () => {
  let clock = now
  vi.mocked(liveReaderJson).mockImplementation(async (requested, _projection, _numbers, onStart) => {
    if (requested !== path) throw new Error('GitHub REST rate limited')
    onStart?.(clock)
    return pull
  })
  const reader = new ReleasePullReader(undefined, () => clock)
  const first = await reader.get([url])
  clock += 1_000
  const second = url.replace('/1', '/2')
  for (const result of [await reader.get([url, second]), await reader.get([url, second])]) {
    expect(result.get(url)).toEqual(first.get(url))
    expect(result.get(second)).toMatchObject({ state: 'unknown', readError: 'GitHub REST rate limited' })
  }
  expect(liveReaderJson).toHaveBeenCalledTimes(2)
})
