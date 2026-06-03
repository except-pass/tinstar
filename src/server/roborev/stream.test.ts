import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { startRoborevStream } from './stream'

function fakeChild(stdout: Readable) {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void }
  child.stdout = stdout
  child.kill = vi.fn()
  return child
}

describe('startRoborevStream', () => {
  it('broadcasts roborev_stream once per JSONL line', async () => {
    const stdout = new Readable({ read() {} })
    spawnMock.mockReturnValue(fakeChild(stdout))
    const broadcastEvent = vi.fn()
    const handle = startRoborevStream({ broadcastEvent } as never)

    stdout.push('{"event":"job.updated","id":1}\n')
    stdout.push('{"event":"job.done","id":2}\n')
    await new Promise((r) => setTimeout(r, 10))

    expect(broadcastEvent).toHaveBeenCalledTimes(2)
    expect(broadcastEvent).toHaveBeenCalledWith('roborev_stream', expect.objectContaining({ event: 'job.updated' }))
    handle.stop()
  })

  it('ignores malformed lines without throwing', async () => {
    const stdout = new Readable({ read() {} })
    spawnMock.mockReturnValue(fakeChild(stdout))
    const broadcastEvent = vi.fn()
    const handle = startRoborevStream({ broadcastEvent } as never)
    stdout.push('not json\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(broadcastEvent).not.toHaveBeenCalled()
    handle.stop()
  })
})
