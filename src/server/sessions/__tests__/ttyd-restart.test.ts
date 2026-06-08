import { describe, expect, it } from 'vitest'
import { shouldRestartTtyd } from '../backends/tmux'

describe('shouldRestartTtyd — auto-restart circuit breaker', () => {
  it('restarts when tmux is alive and restart rate is low', () => {
    const r = shouldRestartTtyd({ tmuxAlive: true, restartTimestamps: [], now: 10_000 })
    expect(r.restart).toBe(true)
    expect(r.reason).toBe('ok')
  })

  it('does NOT restart when the tmux target is gone — the session was closed/killed', () => {
    // This is the user's repro: a session whose tmux died must not spin ttyd
    // forever attaching to a dead session.
    const r = shouldRestartTtyd({ tmuxAlive: false, restartTimestamps: [9_000, 9_500], now: 10_000 })
    expect(r.restart).toBe(false)
    expect(r.reason).toBe('tmux-gone')
  })

  it('gives up after too many restarts inside the window — stops the restart-war', () => {
    // 1,184 restarts in 23h came from a ttyd that exits ~every 2s. Five rapid
    // restarts in the window is unambiguously pathological (port contention,
    // second backend on the same config dir).
    const now = 30_000
    const recent = [16_000, 19_000, 22_000, 25_000, 28_000] // 5 within 15s window
    const r = shouldRestartTtyd({ tmuxAlive: true, restartTimestamps: recent, now })
    expect(r.restart).toBe(false)
    expect(r.reason).toBe('rate-limited')
  })

  it('counts only restarts inside the window — old restarts do not trip the breaker', () => {
    const now = 100_000
    // Five restarts, but all older than the 15s window — should not rate-limit.
    const old = [10_000, 20_000, 30_000, 40_000, 50_000]
    const r = shouldRestartTtyd({ tmuxAlive: true, restartTimestamps: old, now })
    expect(r.restart).toBe(true)
    expect(r.reason).toBe('ok')
  })
})
