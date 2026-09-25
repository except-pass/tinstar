import { getPref } from '../../lib/uiPrefs'

/** V6 mounts when the preference is on or the page was opened with `?v6=1`. */
export function v6ShellEnabled(search?: string): boolean {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  if (new URLSearchParams(query).get('v6') === '1') return true
  return getPref('v6Shell') === true
}
