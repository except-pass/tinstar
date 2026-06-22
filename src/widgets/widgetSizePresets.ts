/** S/M/L quick-resize presets. Pure, framework-free, unit-tested in isolation. */

export type SizePreset = 'small' | 'medium' | 'large'

export interface WidgetSizePresets {
  /** Viewport fractions (0..1), shared across all widget types. */
  small: number
  medium: number
  large: number
  /** Default aspect (width / height) applied when a type has no override. */
  defaultAspect: number
  /** Per-widget-type aspect override: widgetType -> width/height. */
  aspectByType: Record<string, number>
}

export const DEFAULT_WIDGET_SIZE_PRESETS: WidgetSizePresets = {
  small: 0.35,
  medium: 0.6,
  large: 0.85,
  defaultAspect: 1.5,
  aspectByType: {},
}

interface Size { width: number; height: number }

/** Aspect (width/height) for a widget type: per-type override if positive, else the default. */
export function resolveAspect(presets: WidgetSizePresets, widgetType: string): number {
  const a = presets.aspectByType[widgetType]
  return typeof a === 'number' && a > 0 ? a : presets.defaultAspect
}

/**
 * Concrete pixel size (canvas-space) for one preset. Letterbox-fits an `aspect`
 * rectangle inside a `fraction`-of-viewport box, then floors to `minSize`.
 * Min wins: a floored dimension may exceed the box / break the aspect.
 */
export function computePresetSize(
  viewport: Size,
  fraction: number,
  aspect: number,
  minSize: Size,
): Size {
  const boxW = viewport.width * fraction
  const boxH = viewport.height * fraction
  let width = Math.min(boxW, boxH * aspect)
  let height = width / aspect
  if (width < minSize.width) { width = minSize.width; height = width / aspect }
  if (height < minSize.height) { height = minSize.height; width = height * aspect }
  return { width: Math.round(width), height: Math.round(height) }
}

/** All three preset sizes for a widget — used for active-state matching. */
export function resolvePresetSizes(
  viewport: Size,
  presets: WidgetSizePresets,
  aspect: number,
  minSize: Size,
): Record<SizePreset, Size> {
  return {
    small: computePresetSize(viewport, presets.small, aspect, minSize),
    medium: computePresetSize(viewport, presets.medium, aspect, minSize),
    large: computePresetSize(viewport, presets.large, aspect, minSize),
  }
}

/** Which preset the current size matches within `tolerancePx`, or null (custom). */
export function matchPreset(
  current: Size,
  sizes: Record<SizePreset, Size>,
  tolerancePx = 2,
): SizePreset | null {
  for (const key of ['small', 'medium', 'large'] as SizePreset[]) {
    const s = sizes[key]
    if (Math.abs(current.width - s.width) <= tolerancePx
      && Math.abs(current.height - s.height) <= tolerancePx) {
      return key
    }
  }
  return null
}
