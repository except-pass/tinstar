import { loopbackOriginsForPort } from '../sessionProxy'
import { parseAllowlistFromEnv } from './cors'

/**
 * The set of browser origins allowed to make credentialed API calls.
 *
 * Three sources, unioned and read fresh on every request: the environment
 * allowlist, a seeded set fixed at boot, and origins registered at runtime when
 * reach establishes.
 *
 * The seeded set is the load-bearing part, and not for reach's sake. An empty
 * allowlist takes `resolveCorsHeaders` down its wildcard branch, which answers
 * `Access-Control-Allow-Origin: *` to everyone — so on the configuration this
 * work ships FIRST (containment, reach never enabled) any page the operator
 * merely visits could read the whole canvas API. Seeding makes that branch
 * unreachable in normal operation, and it also removes the trap where
 * registering the first reach origin would silently narrow the response for
 * every other caller, the desktop app included.
 */

/** The desktop app's origins across the platforms Tauri serves it from. */
export const DESKTOP_APP_ORIGINS = [
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
] as const

/** Trailing slashes are not part of an origin; a stray one must not miss. */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '')
}

let seeded: string[] = []
const registered = new Set<string>()

/**
 * Fix the origins this server answers for. Called once from the listener's
 * post-bind callback with the port that actually bound — seeding the configured
 * port would leave the real one unlisted after a port fallback.
 */
export function seedOriginAllowlist(boundPort: number): void {
  seeded = [
    `http://localhost:${boundPort}`,
    `http://127.0.0.1:${boundPort}`,
    `http://[::1]:${boundPort}`,
    ...DESKTOP_APP_ORIGINS,
  ]
}

/** Allowed for the lifetime of the reach that produced it (R19). */
export function registerReachOrigin(origin: string): void {
  registered.add(normalizeOrigin(origin))
}

export function unregisterReachOrigin(origin: string): void {
  registered.delete(normalizeOrigin(origin))
}

export function reachOrigins(): string[] {
  return [...registered]
}

/**
 * Read fresh per request rather than captured: reach can register an origin
 * long after the first request has been served.
 */
export function currentOriginAllowlist(): string[] {
  return [
    ...parseAllowlistFromEnv(process.env.TINSTAR_CORS_ORIGINS),
    ...seeded,
    ...registered,
  ]
}

/** Tests only — module state would otherwise leak between cases. */
export function resetOriginAllowlistForTests(): void {
  seeded = []
  registered.clear()
}

/**
 * The origins a terminal WebSocket upgrade may carry.
 *
 * This exists as its own exported function because the wiring is what broke:
 * the upgrade handler was given a hand-built loopback-only list while reach
 * registered its origin somewhere else, so a remote canvas loaded and then
 * every terminal upgrade was refused. A resolver that can be imported is a
 * resolver a test can hold to the same contract the server uses.
 *
 * The loopback pair is unioned in unconditionally rather than relied on from
 * the seeded set: the dev-server backend never seeds, and the standalone
 * server has a window at boot before it does. Localhost must work in both.
 */
export function sessionUpgradeOrigins(boundPort: number): string[] {
  return [...loopbackOriginsForPort(boundPort), ...currentOriginAllowlist()]
}
