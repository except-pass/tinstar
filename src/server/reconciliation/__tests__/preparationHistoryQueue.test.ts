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
