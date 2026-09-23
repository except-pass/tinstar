// Tails one first mate home's fleet ledger (`<home>/state/fleet-ledger.jsonl`).
//
// Pattern follows slate-watcher.ts: a directory-level `fs.watch` for latency (a
// file-level watch is broken by the ledger's documented `: >` truncation) plus a
// slow poll floor as the backstop for missed events.
//
// Tail mechanics:
//   - byte-offset tail; only COMPLETE lines (ending in "\n") are delivered, a
//     partial last line waits for the next read. Lines are split on raw bytes and
//     decoded afterwards so a multi-byte character never straddles a chunk edge;
//   - the file shrinking below the saved offset, or its inode changing, means it
//     was truncated/replaced: re-read from 0 and tell the consumer to REBUILD
//     (`reset: true`) — the ledger is never rotated, only emptied;
//   - a missing file/dir is normal (ledger flag off): nothing is delivered and the
//     next poll retries.
//
// Read-only: this module opens the ledger for reading and never writes anywhere.

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../logger'

export const LEDGER_FILE = 'fleet-ledger.jsonl'
const DEFAULT_POLL_MS = 3000
const READ_CHUNK = 1024 * 1024
/** A "line" longer than this without a newline is garbage, not a record. */
const MAX_PARTIAL_BYTES = 1024 * 1024

export interface LedgerBatch {
  lines: string[]
  /** The file was truncated/replaced: discard state derived from earlier batches. */
  reset: boolean
}

export class LedgerTail {
  private offset = 0
  private ino: number | null = null
  private partial: Buffer = Buffer.alloc(0)

  constructor(private readonly path: string) {}

  /** Read whatever was appended since the last call. Never throws. */
  async poll(): Promise<LedgerBatch | null> {
    let size: number
    let ino: number
    try {
      const s = await stat(this.path)
      if (!s.isFile()) return null
      size = s.size
      ino = s.ino
    } catch {
      // Gone: if we had read something, that is a reset the next appearance must honour.
      if (this.offset > 0 || this.ino !== null) {
        this.offset = 0
        this.ino = null
        this.partial = Buffer.alloc(0)
        return { lines: [], reset: true }
      }
      return null
    }

    let reset = false
    if ((this.ino !== null && ino !== this.ino) || size < this.offset) {
      this.offset = 0
      this.partial = Buffer.alloc(0)
      reset = true
    }
    this.ino = ino
    if (size === this.offset) return reset ? { lines: [], reset } : null

    const lines: string[] = []
    let handle
    try {
      handle = await open(this.path, 'r')
      let pos = this.offset
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - pos))
        const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
        if (bytesRead === 0) break
        pos += bytesRead
        let data = Buffer.concat([this.partial, buf.subarray(0, bytesRead)])
        let nl: number
        while ((nl = data.indexOf(0x0a)) !== -1) {
          lines.push(data.subarray(0, nl).toString('utf8'))
          data = data.subarray(nl + 1)
        }
        this.partial = data.length > MAX_PARTIAL_BYTES ? Buffer.alloc(0) : Buffer.from(data)
      }
      this.offset = pos
    } catch (err) {
      log.debug('firstmate', `ledger read failed: ${(err as Error).message}`)
      return reset ? { lines: [], reset } : null
    } finally {
      await handle?.close().catch(() => {})
    }
    return { lines, reset }
  }
}

export interface LedgerWatcherOpts {
  /** The first mate home; the ledger is `<home>/state/fleet-ledger.jsonl`. */
  home: string
  onBatch: (home: string, batch: LedgerBatch) => void | Promise<void>
  pollMs?: number
}

export class LedgerWatcher {
  private readonly tail: LedgerTail
  private readonly stateDir: string
  private timer: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private polling: Promise<void> | null = null
  private again = false

  constructor(private readonly opts: LedgerWatcherOpts) {
    this.stateDir = join(opts.home, 'state')
    this.tail = new LedgerTail(join(this.stateDir, LEDGER_FILE))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.pollOnce(), this.opts.pollMs ?? DEFAULT_POLL_MS)
    this.timer.unref?.()
    void this.pollOnce()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try { this.watcher?.close() } catch { /* already closed */ }
    this.watcher = null
  }

  /** Coalescing poll: a call during an in-flight poll schedules exactly one more. */
  pollOnce(): Promise<void> {
    if (this.polling) {
      this.again = true
      return this.polling
    }
    this.polling = (async () => {
      try {
        do {
          this.again = false
          this.armWatch()
          const batch = await this.tail.poll()
          if (batch) await this.opts.onBatch(this.opts.home, batch)
        } while (this.again)
      } catch (err) {
        log.warn('firstmate', `ledger poll failed for ${this.opts.home}: ${(err as Error).message}`)
      } finally {
        this.polling = null
      }
    })()
    return this.polling
  }

  /** (Re)arm the directory watch; the dir may not exist until the ledger is enabled. */
  private armWatch(): void {
    if (this.watcher) return
    try {
      const w = fsWatch(this.stateDir, { persistent: false }, (_evt, name) => {
        if (!name || name === LEDGER_FILE) void this.pollOnce()
      })
      w.on('error', () => {
        try { w.close() } catch { /* already closed */ }
        if (this.watcher === w) this.watcher = null // the next poll re-arms
      })
      this.watcher = w
    } catch {
      // state dir absent — the poll floor retries
    }
  }
}
