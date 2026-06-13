import { describe, it, expect } from 'vitest'
import {
  computePresetSize,
  resolveAspect,
  resolvePresetSizes,
  matchPreset,
  DEFAULT_WIDGET_SIZE_PRESETS,
} from '../widgetSizePresets'

const MIN = { width: 100, height: 80 }

describe('computePresetSize', () => {
  it('letterbox-fits the aspect rect inside the fraction-of-viewport box (wide box, wide aspect)', () => {
    // viewport 2000x1000, fraction 0.5 -> box 1000x500, aspect 1.5 -> width=min(1000,500*1.5=750)=750, h=500
    const s = computePresetSize({ width: 2000, height: 1000 }, 0.5, 1.5, MIN)
    expect(s).toEqual({ width: 750, height: 500 })
  })

  it('is width-limited when the box is taller than the aspect allows', () => {
    // viewport 1000x2000, fraction 0.5 -> box 500x1000, aspect 1.5 -> width=min(500,1000*1.5)=500, h=333.33->333
    const s = computePresetSize({ width: 1000, height: 2000 }, 0.5, 1.5, MIN)
    expect(s).toEqual({ width: 500, height: 333 })
  })

  it('is viewport-relative: same preset yields a bigger size on a bigger viewport', () => {
    const small = computePresetSize({ width: 1440, height: 900 }, 0.85, 1.5, MIN)
    const big = computePresetSize({ width: 3840, height: 2160 }, 0.85, 1.5, MIN)
    expect(big.width).toBeGreaterThan(small.width)
    expect(big.height).toBeGreaterThan(small.height)
  })

  it('floors to minSize when the preset would be smaller (both dims cascade: width→height)', () => {
    // tiny viewport -> box 10x10; width floored to 100, h=66.67<minH=80, so height also
    // floors to 80, width re-derived as 80*1.5=120. Both dimensions satisfy their minimums.
    const s = computePresetSize({ width: 100, height: 100 }, 0.1, 1.5, MIN)
    expect(s.width).toBe(120)
    expect(s.height).toBe(80)
  })

  it('floors height to minSize when the width-derived height is below min', () => {
    // aspect very wide so height tiny -> floored to min height, width = min.height * aspect
    const s = computePresetSize({ width: 1000, height: 1000 }, 0.05, 10, MIN)
    expect(s.height).toBe(80)
    expect(s.width).toBe(800)
  })
})

describe('resolveAspect', () => {
  const p = { ...DEFAULT_WIDGET_SIZE_PRESETS, defaultAspect: 1.5, aspectByType: { 'browser-widget': 1.777 } }
  it('returns the per-type override when present and positive', () => {
    expect(resolveAspect(p, 'browser-widget')).toBe(1.777)
  })
  it('falls back to defaultAspect for unknown types', () => {
    expect(resolveAspect(p, 'file-editor')).toBe(1.5)
  })
  it('ignores a non-positive override', () => {
    expect(resolveAspect({ ...p, aspectByType: { x: 0 } }, 'x')).toBe(1.5)
  })
})

describe('resolvePresetSizes + matchPreset', () => {
  it('matchPreset returns the key whose size matches current within tolerance, else null', () => {
    const sizes = resolvePresetSizes({ width: 2000, height: 1000 }, DEFAULT_WIDGET_SIZE_PRESETS, 1.5, MIN)
    expect(matchPreset(sizes.medium, sizes)).toBe('medium')
    expect(matchPreset({ width: sizes.large.width + 1, height: sizes.large.height - 1 }, sizes)).toBe('large')
    expect(matchPreset({ width: 12345, height: 999 }, sizes)).toBeNull()
  })
})
