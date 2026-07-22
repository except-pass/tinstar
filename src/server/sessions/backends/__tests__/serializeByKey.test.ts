import { describe, it, expect } from 'vitest'
import { serializeByKey } from '../serializeByKey'

/** A controllable async task: resolves only when `finish()` is called, recording
 *  when it started and finished into a shared log. */
function makeTask(log: string[], name: string) {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = async () => {
    log.push(`start:${name}`)
    await gate
    log.push(`end:${name}`)
    return name
  }
  return { run, finish: () => release() }
}

describe('serializeByKey', () => {
  it('runs same-key tasks one at a time, in registration order', async () => {
    const chains = new Map<string, Promise<unknown>>()
    const log: string[] = []
    const a = makeTask(log, 'a')
    const b = makeTask(log, 'b')

    const pa = serializeByKey(chains, 'sess', a.run)
    const pb = serializeByKey(chains, 'sess', b.run)

    // Only the first task has started; the second is queued behind it (no overlap).
    await Promise.resolve()
    expect(log).toEqual(['start:a'])

    a.finish()
    await pa
    // Now the second may start — never before the first ended.
    await Promise.resolve()
    expect(log).toEqual(['start:a', 'end:a', 'start:b'])

    b.finish()
    await expect(pb).resolves.toBe('b')
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('runs different-key tasks concurrently', async () => {
    const chains = new Map<string, Promise<unknown>>()
    const log: string[] = []
    const a = makeTask(log, 'a')
    const b = makeTask(log, 'b')

    serializeByKey(chains, 'sess-1', a.run)
    serializeByKey(chains, 'sess-2', b.run)

    // Both started immediately — different keys don't block each other.
    await Promise.resolve()
    expect(log).toEqual(['start:a', 'start:b'])
    a.finish(); b.finish()
  })

  it('surfaces a task rejection to its caller without poisoning the next same-key task', async () => {
    const chains = new Map<string, Promise<unknown>>()
    const boom = serializeByKey(chains, 'sess', async () => { throw new Error('boom') })
    await expect(boom).rejects.toThrow('boom')

    // The next task for the same key still runs and resolves normally.
    const ok = serializeByKey(chains, 'sess', async () => 'ok')
    await expect(ok).resolves.toBe('ok')
  })
})
