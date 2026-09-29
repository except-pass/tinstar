import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { QUOTA_AXI_ARGS, QUOTA_AXI_COMMAND, QuotaAxiPoller, runQuotaAxi, type QuotaSpawn } from '../poller'

const recorded = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'recorded-quota-axi.json'), 'utf8')

describe('QuotaAxiPoller', () => {
  it('caches providers from a stubbed quota-axi command', async () => {
    const poller = new QuotaAxiPoller({
      run: async () => recorded,
      now: () => Date.parse('2026-09-29T12:00:05.000Z'),
    })
    await poller.refresh()
    const snapshot = poller.snapshot()
    expect(snapshot.commandError).toBeNull()
    expect(snapshot.checkedAt).toBe('2026-09-29T12:00:05.000Z')
    expect(snapshot.providers.map(provider => provider.id)).toEqual(['claude', 'codex', 'grok', 'kimi'])
  })

  it('keeps the last good providers when a later read fails', async () => {
    let calls = 0
    const poller = new QuotaAxiPoller({
      run: async () => {
        calls += 1
        if (calls === 1) return recorded
        throw new Error('quota-axi exited 1')
      },
      now: () => Date.parse('2026-09-29T12:00:05.000Z'),
    })
    await poller.refresh()
    await poller.refresh()
    const snapshot = poller.snapshot()
    expect(snapshot.commandError).toBe('quota-axi exited 1')
    expect(snapshot.providers.map(provider => provider.id)).toEqual(['claude', 'codex', 'grok', 'kimi'])
    expect(snapshot.fetchedAt).toBe('2026-09-29T12:00:00.000Z')
  })

  it('does not start a second command while one is running', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const poller = new QuotaAxiPoller({
      run: async () => {
        calls += 1
        await gate
        return recorded
      },
    })
    const first = poller.refresh()
    const second = poller.refresh()
    expect(calls).toBe(1)
    release()
    await first
    await second
    expect(calls).toBe(1)
  })

  it('times out a read that never finishes', async () => {
    const poller = new QuotaAxiPoller({
      run: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      timeoutMs: 20,
      now: () => Date.parse('2026-09-29T12:00:05.000Z'),
    })
    await poller.refresh()
    expect(poller.snapshot().commandError).toBe('quota-axi timed out')
    expect(poller.snapshot().providers).toEqual([])
  })
})

describe('runQuotaAxi', () => {
  it('runs quota-axi --json --full --no-credential-refresh and returns stdout', async () => {
    const calls: string[][] = []
    const spawnImpl: QuotaSpawn = (command, args) => {
      calls.push([command, ...args])
      return childWith(recorded, 0)
    }
    const text = await runQuotaAxi(new AbortController().signal, spawnImpl)
    expect(calls).toEqual([[QUOTA_AXI_COMMAND, ...QUOTA_AXI_ARGS]])
    expect(text).toBe(recorded)
  })

  it('surfaces a non-zero exit without the word from an empty failure', async () => {
    const spawnImpl: QuotaSpawn = () => childWith('', 2, 'disk read failed')
    await expect(runQuotaAxi(new AbortController().signal, spawnImpl)).rejects.toThrow('disk read failed')
  })

  it('kills the child when the signal aborts', async () => {
    let killed = false
    const spawnImpl: QuotaSpawn = () => {
      const child = childWith('', null)
      const original = child.kill.bind(child)
      child.kill = signal => {
        killed = signal === 'SIGKILL'
        return original(signal)
      }
      return child
    }
    const controller = new AbortController()
    const pending = runQuotaAxi(controller.signal, spawnImpl)
    controller.abort()
    await expect(pending).rejects.toThrow('quota-axi timed out')
    expect(killed).toBe(true)
  })
})

function childWith(stdoutText: string, code: number | null, stderrText = ''): ChildProcess {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ChildProcess
  child.stdout = stdout
  child.stderr = stderr
  child.kill = () => {
    queueMicrotask(() => child.emit('close', null))
    return true
  }
  if (code !== null) {
    queueMicrotask(() => {
      stdout.end(stdoutText)
      stderr.end(stderrText)
      child.emit('close', code)
    })
  }
  return child
}
