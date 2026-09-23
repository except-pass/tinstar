import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerTail, LedgerWatcher, LEDGER_FILE, type LedgerBatch } from './ledger-watcher'

describe('ledger tail', () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fm-ledger-')); file = join(dir, LEDGER_FILE) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null while the ledger does not exist (flag off)', async () => {
    expect(await new LedgerTail(file).poll()).toBeNull()
  })

  it('reads only new complete lines and holds a partial last line', async () => {
    const t = new LedgerTail(file)
    writeFileSync(file, '{"a":1}\n{"b":')
    expect(await t.poll()).toEqual({ lines: ['{"a":1}'], reset: false })
    expect(await t.poll()).toBeNull()
    appendFileSync(file, '2}\n{"c":3}\n')
    expect(await t.poll()).toEqual({ lines: ['{"b":2}', '{"c":3}'], reset: false })
  })

  it('does not split multi-byte characters across reads', async () => {
    const t = new LedgerTail(file)
    const line = JSON.stringify({ text: 'héllo → ✓ 日本語' })
    const bytes = Buffer.from(line + '\n')
    writeFileSync(file, bytes.subarray(0, 12)) // cuts inside a multi-byte sequence
    expect(await t.poll()).toEqual({ lines: [], reset: false })
    appendFileSync(file, bytes.subarray(12))
    expect((await t.poll())!.lines).toEqual([line])
  })

  it('signals reset and re-reads from zero when the file is truncated', async () => {
    const t = new LedgerTail(file)
    writeFileSync(file, '{"old":1}\n{"old":2}\n')
    await t.poll()
    writeFileSync(file, '{"new":1}\n')
    expect(await t.poll()).toEqual({ lines: ['{"new":1}'], reset: true })
    appendFileSync(file, '{"new":2}\n')
    expect(await t.poll()).toEqual({ lines: ['{"new":2}'], reset: false })
  })

  it('signals reset when the file is emptied and then refilled later', async () => {
    const t = new LedgerTail(file)
    writeFileSync(file, '{"old":1}\n')
    await t.poll()
    writeFileSync(file, '')
    expect(await t.poll()).toEqual({ lines: [], reset: true })
    appendFileSync(file, '{"x":1}\n')
    expect(await t.poll()).toEqual({ lines: ['{"x":1}'], reset: false })
  })

  it('watcher delivers batches for a ledger that appears after start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fm-home-'))
    const batches: LedgerBatch[] = []
    const w = new LedgerWatcher({ home, pollMs: 25, onBatch: (_h, b) => { batches.push(b) } })
    try {
      w.start()
      await w.pollOnce()
      expect(batches).toEqual([])
      mkdirSync(join(home, 'state'))
      writeFileSync(join(home, 'state', LEDGER_FILE), '{"a":1}\n')
      await waitFor(() => batches.length > 0)
      expect(batches[0]!.lines).toEqual(['{"a":1}'])
    } finally {
      w.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 15))
  }
}
