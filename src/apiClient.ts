// Resolved once at module load; _resetApiBaseForTests re-reads globals.
let apiBase: string | null = null

function readApiBase(): string | null {
  const injected = (globalThis as Record<string, unknown>).__TINSTAR_API_BASE__
  if (typeof injected === 'string' && injected.length > 0) {
    return injected.replace(/\/+$/, '')
  }
  return null
}

function getBase(): string | null {
  if (apiBase === null) apiBase = readApiBase() ?? ''
  return apiBase === '' ? null : apiBase
}

export function _resetApiBaseForTests(): void {
  apiBase = null
}

/**
 * Forces the next apiUrl() / apiFetch() call to re-read window.__TINSTAR_API_BASE__.
 *
 * Use case: the Tauri desktop shell injects __TINSTAR_API_BASE__ via Window::eval
 * inside the PageLoadEvent::Started callback. Module-init time can race that
 * injection in some webview implementations. Calling this from the bootstrap
 * (main.tsx) right before mounting React makes the timing question irrelevant —
 * apiBase is null again, so the very next read picks up whatever the eval set.
 */
export function resetApiBaseFromGlobal(): void {
  apiBase = null
}

export function apiUrl(path: string): string {
  const base = getBase()
  if (!base) return path.startsWith('/') ? path : `/${path}`
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const opts: RequestInit = { credentials: 'include', ...init }
  if (init.credentials !== undefined) opts.credentials = init.credentials
  return fetch(apiUrl(path), opts)
}
