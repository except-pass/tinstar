import { describe, it, expect } from 'vitest'
import { treemapInputs } from '../TelemetryPanel'

// Mirrors the real /context shape: per-category tokens are correct, but maxTokens
// comes from the Haiku probe model (200k), and "Free space" is computed against it.
function data(overrides: Partial<Parameters<typeof treemapInputs>[0]> = {}) {
  return {
    categories: [
      { name: 'Messages', tokens: 168_843 },
      { name: 'System tools (deferred)', tokens: 15_292 },
      { name: 'Skills', tokens: 11_464 },
      { name: 'System prompt', tokens: 6_543 },
      { name: 'Free space', tokens: 0 }, // wrong: computed against 200k
    ],
    totalTokens: 202_142,
    maxTokens: 200_000,
    percentage: 100,
    model: 'haiku',
    isAutoCompactEnabled: false,
    autoCompactThreshold: null,
    ...overrides,
  }
}

describe('treemapInputs', () => {
  it('rebuilds Free space and the denominator against the real 1M window', () => {
    const out = treemapInputs(data(), 1_000_000)
    expect(out.maxTokens).toBe(1_000_000)
    const free = out.categories.find(c => c.name === 'Free space')!
    // 1_000_000 - (168843 + 15292 + 11464 + 6543) = 797_858
    expect(free.tokens).toBe(797_858)
    // non-free categories are passed through untouched
    expect(out.categories.find(c => c.name === 'Messages')!.tokens).toBe(168_843)
    // exactly one Free space entry (the stale one was replaced, not appended to)
    expect(out.categories.filter(c => c.name === 'Free space')).toHaveLength(1)
  })

  it('passes data through unchanged when no live window is known', () => {
    const d = data()
    expect(treemapInputs(d, null)).toEqual({ categories: d.categories, maxTokens: d.maxTokens })
    expect(treemapInputs(d, undefined).maxTokens).toBe(200_000)
    expect(treemapInputs(d, 0).maxTokens).toBe(200_000)
  })

  it('is a no-op when the live window already matches maxTokens', () => {
    const d = data({ maxTokens: 200_000 })
    expect(treemapInputs(d, 200_000)).toEqual({ categories: d.categories, maxTokens: 200_000 })
  })

  it('clamps Free space to zero when usage exceeds the live window', () => {
    const out = treemapInputs(data(), 150_000)
    expect(out.categories.find(c => c.name === 'Free space')!.tokens).toBe(0)
  })
})
