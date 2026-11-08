export interface DeskPreferences { width: number; collapsed: boolean }
export const deskPreferencesKey = 'tinstar.desk.preferences'
export const defaultDeskWidth = 320
export const minimumDeskWidth = 240
export const maximumDeskWidth = 640

export function loadDeskPreferences(): DeskPreferences {
  const defaults = { width: defaultDeskWidth, collapsed: false }
  try {
    const saved = JSON.parse(localStorage.getItem(deskPreferencesKey) ?? '{}')
    return {
      width: typeof saved?.width === 'number' && Number.isFinite(saved.width) ? Math.max(minimumDeskWidth, Math.min(maximumDeskWidth, saved.width)) : defaults.width,
      collapsed: typeof saved?.collapsed === 'boolean' ? saved.collapsed : defaults.collapsed,
    }
  } catch { return defaults }
}
export function saveDeskPreferences(value: DeskPreferences) {
  try { localStorage.setItem(deskPreferencesKey, JSON.stringify(value)) } catch { /* The current layout still works without browser storage. */ }
}
export function deskWidthLimit(available: number) {
  return Math.max(minimumDeskWidth, Math.min(maximumDeskWidth, available - 400))
}
export function clampDeskWidth(width: number, available: number) {
  return Math.max(minimumDeskWidth, Math.min(deskWidthLimit(available), width))
}
