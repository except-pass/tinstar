import { spawn, type ChildProcess } from 'node:child_process'
import { parseQuotaAxiReport, type QuotaMeterSnapshot } from './parse'

export const QUOTA_AXI_COMMAND = 'quota-axi'
/**
 * Never pass a flag that asks the vendor CLI to refresh a login.
 * `--full` is what carries each provider's `state.refreshedAt`.
 */
export const QUOTA_AXI_ARGS = ['--json', '--full', '--no-credential-refresh'] as const
export const QUOTA_POLL_INTERVAL_MS = 2 * 60_000
export const QUOTA_COMMAND_TIMEOUT_MS = 20_000

/** A broken command streaming forever must not fill memory. */
const MAX_STDOUT_CHARS = 2_000_000

export type QuotaSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess

const EMPTY_SNAPSHOT: QuotaMeterSnapshot = {
  checkedAt: null,
  fetchedAt: null,
  commandError: null,
  providers: [],
}

export interface QuotaAxiPollerOptions {
  run?: (signal: AbortSignal) => Promise<string>
  spawnImpl?: QuotaSpawn
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  onError?: (message: string) => void
}

/**
 * Runs `quota-axi --json --full --no-credential-refresh` on an interval.
 * A tick that starts while a read is still running does nothing.
 * A failed read keeps the last good providers and records the error.
 */
export class QuotaAxiPoller {
  private cache: QuotaMeterSnapshot = EMPTY_SNAPSHOT
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private abort: AbortController | null = null

  constructor(private readonly opts: QuotaAxiPollerOptions = {}) {}

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, this.opts.intervalMs ?? QUOTA_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abort?.abort()
  }

  snapshot(): QuotaMeterSnapshot {
    return this.cache
  }

  async refresh(): Promise<void> {
    if (this.running) return
    this.running = true
    const controller = new AbortController()
    this.abort = controller
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? QUOTA_COMMAND_TIMEOUT_MS)
    const checkedAt = new Date(this.opts.now?.() ?? Date.now()).toISOString()
    try {
      const text = await (this.opts.run ?? (signal => runQuotaAxi(signal, this.opts.spawnImpl)))(controller.signal)
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('quota-axi returned unreadable output')
      }
      const report = parseQuotaAxiReport(payload)
      this.cache = {
        checkedAt,
        fetchedAt: report.fetchedAt,
        commandError: null,
        providers: report.providers,
      }
    } catch (error) {
      const message = controller.signal.aborted
        ? 'quota-axi timed out'
        : error instanceof Error && error.message
          ? error.message
          : 'quota-axi failed'
      this.cache = { ...this.cache, checkedAt, commandError: message }
      this.opts.onError?.(message)
    } finally {
      clearTimeout(timeout)
      this.running = false
      if (this.abort === controller) this.abort = null
    }
  }
}

export function runQuotaAxi(signal: AbortSignal, spawnImpl: QuotaSpawn = spawn): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnImpl(QUOTA_AXI_COMMAND, QUOTA_AXI_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error instanceof Error ? error : new Error('quota-axi failed'))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, value?: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value ?? '')
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(new Error('quota-axi timed out'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_STDOUT_CHARS) {
        child.kill('SIGKILL')
        finish(new Error('quota-axi output exceeded 2MB'))
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-500)
    })
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code === 'ENOENT' ? new Error('quota-axi is not installed') : error)
    })
    child.on('close', code => {
      if (signal.aborted) {
        finish(new Error('quota-axi timed out'))
        return
      }
      if (code !== 0) finish(new Error(stderr.trim() || `quota-axi exited ${code ?? 'unknown'}`))
      else finish(null, stdout)
    })
  })
}
