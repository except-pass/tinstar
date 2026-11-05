export type OverviewDensity = 'compact' | 'detailed'
export const overviewDensityKey = 'tinstar.overview.density'
export function loadOverviewDensity(): OverviewDensity {
  try { return localStorage.getItem(overviewDensityKey) === 'detailed' ? 'detailed' : 'compact' } catch { return 'compact' }
}
export function saveOverviewDensity(density: OverviewDensity) {
  try { localStorage.setItem(overviewDensityKey, density) } catch { /* Restricted storage still permits changing the current view. */ }
}
