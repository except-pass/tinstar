import { afterEach, expect, it, vi } from 'vitest'
import { CardContextReader } from '../cardContext'
import { PreparationHistory } from '../preparationHistory'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('settles failed reads within a deadline, frees both slots, and retries with increasing backoff', async () => {
  vi.useFakeTimers()
  const reader = new CardContextReader(undefined)
  const details = vi.spyOn(reader, 'decisionDetails').mockImplementation(() => new Promise(() => {}))
  const queue = new PreparationHistory(reader)
  queue.warm(['one', 'two', 'three'])
  expect(details).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(queue.state('one')).toMatchObject({ state: 'unavailable', message: expect.stringContaining('deadline'), retry_at: expect.any(String) })
  expect(queue.state('two').state).toBe('unavailable')
  expect(details).toHaveBeenCalledTimes(3)
  queue.warm(['one', 'two'])
  expect(details).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(30_000)
  queue.warm(['one', 'two'])
  expect(details).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(90_000)
  expect(details).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(Date.parse(queue.state('one').retry_at!) - Date.now()).toBe(60_000)
})

it('prioritizes one explicit queued card, shares its read, and lets it bypass failure backoff', async () => {
  const reader = new CardContextReader(undefined)
  const finish = new Map<string, () => void>()
  const details = vi.spyOn(reader, 'decisionDetails').mockImplementation(id => new Promise(resolve => {
    finish.set(id, () => resolve({ outcome: 'unavailable', blocks: [] }))
  }))
  const queue = new PreparationHistory(reader)
  queue.warm(['one', 'two', 'three', 'four'])
  const requested = queue.read('four'), shared = queue.read('four')
  finish.get('one')!()
  await vi.waitFor(() => expect(details.mock.calls.map(([id]) => id)).toEqual(['one', 'two', 'four']))
  finish.get('four')!()
  await Promise.all([requested, shared])
  expect(queue.state('four')).toMatchObject({ state: 'unavailable', retry_at: expect.any(String) })
  finish.get('two')!(); finish.get('three')!()
  const retry = queue.read('four')
  await vi.waitFor(() => expect(details.mock.calls.filter(([id]) => id === 'four')).toHaveLength(2))
  finish.get('four')!()
  await retry
})

it('refreshes priority history before expiry and promotes exact sources ahead of queued board reads', async () => {
  const reader = new CardContextReader(undefined)
  const completed = new Map<string, () => void>()
  const cached = new Map<string, { context: { outcome: 'available'; commentsOutcome: 'available'; blocks: [] }; observed_at: string; expires_at: string }>()
  vi.spyOn(reader, 'cachedDecisionHistory').mockImplementation(id => cached.get(id))
  const details = vi.spyOn(reader, 'decisionDetails').mockImplementation(id => new Promise(resolve => {
    completed.set(id, () => {
      const context = { outcome: 'available' as const, commentsOutcome: 'available' as const, blocks: [] as [] }
      cached.set(id, { context, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString() })
      resolve(context)
    })
  }))
  const properties = vi.fn(async () => {})
  const queue = new PreparationHistory(reader, () => {}, async () => {}, properties)
  cached.set('published', { context: { outcome: 'available', commentsOutcome: 'available', blocks: [] }, observed_at: new Date(Date.now() - 20_000).toISOString(), expires_at: new Date(Date.now() + 10_000).toISOString() })
  queue.warm(['one', 'two', 'three', 'published'])
  expect(details.mock.calls.map(([id]) => id)).toEqual(['one', 'two'])
  queue.warm(['three', 'published'], ['published'])
  expect(queue.state('published').expires_at).toBe(cached.get('published')!.expires_at)
  completed.get('one')!()
  await vi.waitFor(() => expect(details.mock.calls.map(([id]) => id)).toEqual(['one', 'two', 'published']))
  expect(details).toHaveBeenLastCalledWith('published', true)
  expect(properties).toHaveBeenCalledWith('published')
  completed.get('published')!(); completed.get('two')!()
  await vi.waitFor(() => expect(details).toHaveBeenCalledWith('three', true))
  completed.get('three')!()
})

it.each([false, true])('refreshes expired properties with fresh history for explicit=%s', async explicit => {
  const reader = new CardContextReader(undefined)
  const context = { outcome: 'available' as const, commentsOutcome: 'available' as const, blocks: [] }
  vi.spyOn(reader, 'cachedDecisionHistory').mockReturnValue({ context, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString() })
  const details = vi.spyOn(reader, 'decisionDetails').mockResolvedValue(context)
  let fresh = false
  const properties = vi.fn(async () => { fresh = true })
  const queue = new PreparationHistory(reader, () => {}, async () => {}, properties, () => fresh)
  if (explicit) await queue.read('retry')
  else { queue.warm(['retry']); await vi.waitFor(() => expect(queue.state('retry').state).toBe('available')) }
  expect(properties).toHaveBeenCalledTimes(1)
  expect(properties).toHaveBeenCalledWith('retry')
  expect(details).toHaveBeenCalledTimes(1)
  expect(details).toHaveBeenCalledWith('retry', true)
  queue.warm(['retry'])
  expect(properties).toHaveBeenCalledTimes(1)
})
