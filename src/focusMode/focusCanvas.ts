import type { WidgetLayout } from '../hooks/useWidgetLayouts'

export type FocusCycleDirection = 'previous' | 'next'

export function resolveFocusLayout(
  viewport: { width: number; height: number },
  sidebarWidth: number,
): WidgetLayout {
  return {
    x: 0,
    y: 0,
    width: Math.max(0, viewport.width - sidebarWidth),
    height: Math.max(0, viewport.height),
  }
}

export function focusCycleDirection(
  deltaX: number,
  deltaY: number,
): FocusCycleDirection | null {
  const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
  if (delta === 0) return null
  return delta > 0 ? 'next' : 'previous'
}
