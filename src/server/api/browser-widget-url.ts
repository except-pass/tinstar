/** Default Tinstar dashboard ports — standalone and dev server. */
const DEFAULT_TINSTAR_PORTS = [5273, 5280] as const

function tinstarDashboardOrigins(): Set<string> {
  const origins = new Set<string>()
  for (const port of DEFAULT_TINSTAR_PORTS) {
    origins.add(`http://localhost:${port}`)
    origins.add(`http://127.0.0.1:${port}`)
    origins.add(`http://[::1]:${port}`)
  }
  const envPort = process.env.TINSTAR_DASHBOARD_PORT ?? process.env.TINSTAR_BACKEND_PORT
  if (envPort) {
    const p = parseInt(envPort, 10)
    if (!Number.isNaN(p)) {
      origins.add(`http://localhost:${p}`)
      origins.add(`http://127.0.0.1:${p}`)
      origins.add(`http://[::1]:${p}`)
    }
  }
  const dashUrl = process.env.TINSTAR_DASHBOARD_URL
  if (dashUrl) {
    try {
      origins.add(new URL(dashUrl).origin)
    } catch { /* ignore malformed env */ }
  }
  return origins
}

export const TINSTAR_SELF_EMBED_MESSAGE =
  'Cannot embed the Tinstar dashboard in a browser widget (nested Tinstar). Use an external URL (e.g. a dev server or stretchplan at http://localhost:8932/p/<slug>), or POST /api/artifacts for HTML output.'

/** True when the URL would load the Tinstar dashboard inside a browser widget. */
export function isTinstarSelfEmbedUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    return tinstarDashboardOrigins().has(new URL(trimmed).origin)
  } catch {
    return false
  }
}
