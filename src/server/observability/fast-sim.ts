import type { HudSnapshot } from './types.js'

/**
 * Returns a synthetic HUD snapshot that slowly accumulates. Used when
 * TINSTAR_FAST_SIM=1 so E2E tests and demos have something to render
 * without real Prometheus data.
 */
export function makeFakeHud(t = Date.now()): HudSnapshot {
  const secs = (t / 1000) % 3600
  const cost = 0.10 + secs * 0.0015
  const tokens = Math.floor(1000 + secs * 85)
  const rate = 1200 + Math.sin(secs / 30) * 400
  return {
    window: 'today',
    state: 'ready',
    cost: {
      total: cost,
      byModel: {
        'claude-opus-4-6': cost * 0.88,
        'claude-haiku-4-5': cost * 0.12,
      },
    },
    tokens: { total: tokens },
    rate: { perMin: Math.max(0, rate), perHour: Math.max(0, rate * 60) },
    cacheHitPct: 0.65 + Math.sin(secs / 45) * 0.15,
    autonomy: { ratio: 4.5 + Math.sin(secs / 60), cliSeconds: 4500, userSeconds: 1000 },
  }
}
