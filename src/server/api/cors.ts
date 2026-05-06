export interface CorsInput {
  origin: string | undefined
  allowlist: readonly string[]
}

export type CorsHeaders = {
  'Access-Control-Allow-Origin'?: string
  'Access-Control-Allow-Credentials'?: string
  'Access-Control-Allow-Methods'?: string
  'Access-Control-Allow-Headers'?: string
  'Access-Control-Max-Age'?: string
  Vary?: string
}

export function resolveCorsHeaders({ origin, allowlist }: CorsInput): CorsHeaders {
  const methodsAndHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Cache preflights for 24h. Without this, every cross-origin credentialed
    // request triggers an OPTIONS preflight, doubling connection-pool pressure
    // and causing ERR_INSUFFICIENT_RESOURCES on clients with many polled URLs
    // (the desktop Tauri app at tauri.localhost vs the browser hitting the
    // backend same-origin).
    'Access-Control-Max-Age': '86400',
  }
  if (allowlist.length === 0) {
    return { 'Access-Control-Allow-Origin': '*', ...methodsAndHeaders }
  }
  if (origin && allowlist.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
      ...methodsAndHeaders,
    }
  }
  return methodsAndHeaders
}

export function parseAllowlistFromEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}
