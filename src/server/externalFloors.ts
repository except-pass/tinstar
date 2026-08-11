/**
 * Minimum versions for the two operator-installed externals this product's
 * containment guarantee rests on.
 *
 * Both live here, import-light, so a test can read them without dragging in the
 * sessions or reach chains. `bin/tinstar/diagnostics.js` keeps a plain-JS copy
 * because `tinstar doctor` cannot import TypeScript; the drift between the two
 * is held closed by a test, which is the only thing that can hold it.
 */

/**
 * ttyd's `-i` and `-H` flags ARE the terminal containment guarantee. On a build
 * lacking either, the flag is ignored and terminals stay world-reachable — the
 * exact exposure this product closes, with no refusal anywhere. Enforced at
 * spawn (see `assertTtydVersionSupported`), not only reported by doctor.
 */
export const TTYD_MIN_VERSION = '1.7.4'

/**
 * Bulletins TS-2026-005, TS-2026-007 and TS-2026-008 are all fixed in 1.98.9.
 * TS-2026-008 pins a CPU core indefinitely from one malformed HTTP request to a
 * node running Serve, reachable by any tailnet peer — an unauthenticated denial
 * of service against the exact surface reach turns on. Refused below the floor
 * rather than warned.
 */
export const TAILSCALE_MIN_VERSION = '1.98.9'

/**
 * When the Tailscale floor was last checked against the published bulletin
 * index. Reported by doctor because a floor that has gone stale after a later
 * advisory is otherwise invisible — it would sit here looking authoritative.
 */
export const TAILSCALE_FLOOR_VERIFIED_ON = '2026-08-05'

/**
 * Component-wise numeric comparison. A lexical compare puts '1.98.10' BELOW
 * '1.98.9' and would silently admit a vulnerable build — the one failure this
 * gate exists to stop.
 */
export function compareVersions(a: string, b: string): number {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Pull the leading numeric triplet out of a version banner, ignoring any build
 * or git suffix (`1.98.4-t9e69045b2-ged3a62f14`, `ttyd version 1.7.4`). Returns
 * null when nothing version-shaped is present, which callers treat as "cannot
 * establish the version" rather than as a pass.
 */
export function parseVersionTriplet(output: string): string | null {
  const match = String(output ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}
