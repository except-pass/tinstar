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
  // Rotate which fake run IDs are "burning" so the quadrant visibly animates in FAST_SIM.
  const phase = Math.floor(t / 4000) % 4
  const fakeBurning: string[] = []
  if (phase === 0) fakeBurning.push('fake-run-1', 'fake-run-3')
  if (phase === 1) fakeBurning.push('fake-run-2')
  if (phase === 2) fakeBurning.push('fake-run-1', 'fake-run-2', 'fake-run-3')
  // phase === 3 → empty
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
    // Oscillate around ~2 concurrent agents for a visible swarm-mode demo (sometimes peaks > 3×).
    dutyCycle: { value: 2 + Math.sin(secs / 30) * 1.2, windowMinutes: 5 },
    burningRunIds: fakeBurning,
  }
}
