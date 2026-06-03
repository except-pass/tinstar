import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { SSEBroadcaster } from '../api/sse'
import { log } from '../logger'

export interface RoborevStreamHandle {
  stop(): void
}

const RESTART_BACKOFF_MS = 3_000

/** Spawn a long-lived `roborev stream` and forward each JSONL frame to the
 *  `roborev_stream` SSE channel. Clients treat any frame as a "review state
 *  changed — refetch" signal, so we don't depend on the event schema. */
export function startRoborevStream(sse: Pick<SSEBroadcaster, 'broadcastEvent'>): RoborevStreamHandle {
  let child: ChildProcess | null = null
  let rl: ReturnType<typeof createInterface> | null = null
  let stopped = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  function spawnOnce() {
    if (stopped) return
    let proc: ChildProcess
    try {
      proc = spawn('roborev', ['stream'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) {
      log.warn('roborev', `stream spawn failed: ${(err as Error).message}`)
      scheduleRestart()
      return
    }
    child = proc
    if (proc.stdout) {
      rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          sse.broadcastEvent('roborev_stream', JSON.parse(trimmed))
        } catch {
          // non-JSON noise — ignore
        }
      })
    }
    proc.on('error', (err) => {
      log.warn('roborev', `stream error: ${err.message}`)
      scheduleRestart()
    })
    proc.on('exit', () => {
      if (child === proc) {
        child = null
        if (rl) { rl.close(); rl = null }
      }
      scheduleRestart()
    })
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnOnce()
    }, RESTART_BACKOFF_MS)
    restartTimer.unref?.()
  }

  spawnOnce()

  return {
    stop() {
      stopped = true
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      if (rl) { rl.close(); rl = null }
      if (child) { try { child.kill('SIGTERM') } catch { /* gone */ } child = null }
    },
  }
}
