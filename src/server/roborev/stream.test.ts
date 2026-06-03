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
    await vi.waitFor(() => expect(broadcastEvent).toHaveBeenCalledTimes(2))

    expect(broadcastEvent).toHaveBeenCalledWith('roborev_stream', expect.objectContaining({ event: 'job.updated' }))
    handle.stop()
  })

  it('ignores malformed lines without throwing', async () => {
    const stdout = new Readable({ read() {} })
    spawnMock.mockReturnValue(fakeChild(stdout))
    const broadcastEvent = vi.fn()
    const handle = startRoborevStream({ broadcastEvent } as never)

    stdout.push('not json\n')
    stdout.push('{"event":"ok"}\n')
    await vi.waitFor(() => expect(broadcastEvent).toHaveBeenCalledTimes(1))
    expect(broadcastEvent).toHaveBeenCalledWith('roborev_stream', expect.objectContaining({ event: 'ok' }))
    handle.stop()
  })

  it('does not broadcast lines that arrive after stop()', async () => {
    const stdout = new Readable({ read() {} })
    spawnMock.mockReturnValue(fakeChild(stdout))
    const broadcastEvent = vi.fn()
    const handle = startRoborevStream({ broadcastEvent } as never)
    handle.stop()
    stdout.push('{"event":"late","id":9}\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(broadcastEvent).not.toHaveBeenCalled()
  })
})
