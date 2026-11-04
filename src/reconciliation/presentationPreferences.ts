import { organizerSchema, statusFilterSchema } from '../shared/reconciliationCommands'
import { initialPresentation, type PresentationState } from './presentation'

export const preferencesKey = 'tinstar.floor.preferences'
export function loadPresentationPreferences(): PresentationState {
  const state = initialPresentation()
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey) ?? '{}')
    const organizer = organizerSchema.safeParse(saved.organizer), statusFilter = statusFilterSchema.safeParse(saved.statusFilter)
    if (organizer.success) state.organizer = organizer.data
    if (statusFilter.success) state.statusFilter = statusFilter.data
  } catch { /* A restricted or cleared browser store uses the default view. */ }
  return state
}
export function savePresentationPreferences(state: PresentationState) {
  try { localStorage.setItem(preferencesKey, JSON.stringify({ organizer: state.organizer, statusFilter: state.statusFilter })) } catch { /* The view still works when browser storage is unavailable. */ }
}
