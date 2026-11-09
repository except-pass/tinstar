import type { FloorScene } from './presentation'
import { completeSceneSources } from './sceneFreshness'

export interface FloorSync {
  refresh: () => Promise<void>
  refreshing: boolean
  lastSuccessfulSyncAt: string | null
  error: string | null
}

/** Refresh state stays on the existing toolbar icon, including its touch and
 * keyboard accessible name; failed attempts never replace the successful time. */
export function FloorRefresh({ sync, scene, now }: { sync: FloorSync; scene: FloorScene; now: number }) {
  const current = !sync.error && !scene.searchReadFailed && completeSceneSources(scene, now)
  const failed = sync.error || scene.coverage.intentions.error || scene.coverage.homes.some(home => !!home.observation.error)
  const status = sync.refreshing ? 'Refreshing' : failed ? 'Refresh failed; showing last-known data' : current ? 'Sources current' : 'Source coverage incomplete; data may be stale'
  const last = sync.lastSuccessfulSyncAt ? new Date(sync.lastSuccessfulSyncAt).toLocaleString() : 'No complete sync yet'
  const label = `Refresh work. ${status}. Last successful sync: ${last}`
  return <button type="button" className={`ov-refresh${current ? '' : ' ov-warning'}`} disabled={sync.refreshing} aria-busy={sync.refreshing} aria-label={label} title={label} onClick={() => { void sync.refresh() }}>
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M16 7a6.5 6.5 0 1 0 .3 5M16 2v5h-5" /></svg>
  </button>
}
