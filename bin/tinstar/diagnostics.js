/**
 * Pure diagnostics for `tinstar doctor` — bind observation, external version
 * floors, and reach state.
 *
 * Split out of doctor.js so each rule can be asserted without a live host.
 * doctor.js supplies the real `ss`, `ttyd --version` and `tailscale` output.
 */

/**
 * The containment guarantee rests entirely on ttyd's `-i` and `-H` flags. ttyd
 * is an operator-installed prerequisite whose version is arbitrary, and on a
 * build lacking either flag the spawn either dies or the flag is ignored and
 * terminals stay world-reachable — the exact exposure this work closes, with no
 * refusal and no failing check anywhere else.
 */
export const TTYD_MIN_VERSION = '1.7.4'

/**
 * Mirrors TAILSCALE_MIN_VERSION in src/server/reach/tailscale.ts. doctor is
 * plain JS and cannot import the TypeScript adapter, so the floor genuinely
 * exists twice; a test asserts the two agree, which is the only thing keeping
 * them from drifting.
 */
export const TAILSCALE_MIN_VERSION = '1.98.9'

/**
 * When that floor was last checked against the published bulletin index.
 * Reported by doctor because a floor that has gone stale after a later advisory
 * is otherwise invisible — it would sit here looking authoritative forever.
 */
export const TAILSCALE_FLOOR_VERIFIED_ON = '2026-08-05'

/** Numeric, component-wise: lexically '1.98.10' sorts below '1.98.9'. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Parse `ss -tlnp` into listeners.
 *
 * The bind is OBSERVED here rather than read from `server.host`, which is
 * self-reported: a server that believed it bound loopback and did not would
 * report clean from its own file.
 */
export function parseSsListeners(output) {
  const listeners = []
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith('LISTEN')) continue
    const columns = line.trim().split(/\s+/)
    const local = columns[3]
    if (!local) continue
    const split = local.lastIndexOf(':')
    if (split <= 0) continue
    const address = local.slice(0, split).replace(/^\[/, '').replace(/\]$/, '')
    const port = Number(local.slice(split + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    const owner = line.match(/users:\(\("([^"]+)"/)
    listeners.push({ address, port, process: owner ? owner[1] : null })
  }
  return listeners
}

/** Every address in 127.0.0.0/8, plus the IPv6 loopback. */
export function isLoopbackAddress(address) {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || address === '::1'
}

/**
 * A listener set is clean only when EVERY address is loopback. One wide
 * listener alongside a loopback one is the dangerous shape — localhost keeps
 * working, so nothing looks wrong from the host.
 */
export function classifyListenerBind(label, listeners) {
  if (!listeners.length) {
    return { status: 'skip', label: `${label} — no listener observed` }
  }
  const wide = listeners.filter(l => !isLoopbackAddress(l.address))
  if (wide.length) {
    return {
      status: 'fail',
      label: `${label} — reachable off this host`,
      detail: `bound ${wide.map(l => `${l.address}:${l.port}`).join(', ')}`,
    }
  }
  return {
    status: 'pass',
    label: `${label} — loopback only`,
    detail: listeners.map(l => `${l.address}:${l.port}`).join(', '),
  }
}

/** Names both versions, because "too old" without a target is not actionable. */
export function checkExternalVersion(name, installed, floor) {
  if (!installed) {
    return {
      status: 'fail',
      label: `${name} — not found on PATH`,
      detail: `install ${name} ${floor} or newer`,
    }
  }
  if (compareVersions(installed, floor) < 0) {
    return {
      status: 'fail',
      label: `${name} ${installed} — below the required ${floor}`,
      detail: `upgrade ${name} to ${floor} or newer`,
    }
  }
  return { status: 'pass', label: `${name} ${installed}`, detail: `floor ${floor}` }
}

/**
 * Reach is opt-in, so absent is 'skip' rather than 'fail' — a host that never
 * wanted remote access is not broken. A mapping that fronts a port the server
 * is not on IS a failure: the remote URL points at nothing while localhost
 * works fine, which is the drift reconcile exists to repair.
 */
export function checkReachState(opts) {
  const { providerPresent, mapping } = opts
  const serverPort = opts.serverPort
  if (!mapping) {
    return {
      status: 'skip',
      label: providerPresent
        ? 'reach inactive — no mapping recorded'
        : 'reach inactive — provider not installed',
    }
  }
  if (serverPort !== undefined && mapping.port !== serverPort) {
    return {
      status: 'fail',
      label: 'reach mapping points at the wrong port',
      detail: `mapping fronts :${mapping.port}, server is on :${serverPort}`,
    }
  }
  return {
    status: 'pass',
    label: `reach active — ${mapping.url}`,
    detail: `fronts :${mapping.port}`,
  }
}
