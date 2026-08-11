// bin/tinstar/commands/reach.js — turn tailnet reach on and off
//
//   tinstar reach            (same as `status`)
//   tinstar reach status
//   tinstar reach on
//   tinstar reach off
//
// This is the opt-in surface. Reach is never established implicitly: the server
// re-establishes on start only when the operator's persisted preference says
// to, and this command is the only thing that writes that preference.
//
// The privilege grant is installed HERE rather than at `install-service`,
// because this is the moment an operator has actually asked for reach and is
// present to read the sudoers rule before it is written. A host that installs
// the service and never wants remote access never gets a root-adjacent grant.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getApiBase } from '../../apiBase.js'
import { getConfigRoot } from '../../configRoot.js'
import { installReachGrant, removeReachGrant } from './service.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

async function api(path, init) {
  const base = await getApiBase()
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body }
}

function printStatus(status) {
  if (!status || status.state === 'off') {
    console.log(`${DIM}reach is off${RESET}`)
    if (status?.detail) console.log(`${DIM}${status.detail}${RESET}`)
    return
  }
  if (status.state === 'stranded') {
    console.log(`${RED}✗${RESET} reach stranded — ${BOLD}${status.url}${RESET} may still be served`)
    if (status.detail) console.log(`${DIM}${status.detail}${RESET}`)
    return
  }
  if (status.state === 'active') {
    console.log(`${GREEN}✓${RESET} reach is active at ${BOLD}${status.url}${RESET}`)
    return
  }
  console.log(`${RED}✗${RESET} reach ${status.state}${status.detail ? `: ${status.detail}` : ''}`)
}

/** The port the server actually bound, which is what reach must front. */
async function boundPort() {
  const base = await getApiBase()
  const parsed = Number(new URL(base).port)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5273
}

async function reachStatus() {
  const { ok, body } = await api('/api/reach')
  if (!ok) {
    console.error(`${RED}✗${RESET} could not read reach state — is the server running?`)
    process.exit(1)
  }
  printStatus(body?.data)
}

async function reachOn() {
  // The grant first: establishing without it fails on privilege, and the
  // failure would read as a provider problem rather than a missing grant.
  const port = await boundPort()
  const granted = installReachGrant({ port })
  if (!granted) {
    console.error(`${RED}✗${RESET} reach not enabled — the privilege grant was not installed`)
    process.exit(1)
  }

  const { ok, body } = await api('/api/reach', {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  })
  if (!ok) {
    console.error(`${RED}✗${RESET} ${body?.error?.message ?? 'reach refused'}`)
    // The server keeps the opt-in on a failed establish ON PURPOSE, so a
    // transient provider outage does not silently discard the decision. That is
    // the right behaviour and the wrong thing to leave unsaid: without this line
    // the operator reads "failed" and does not expect reach at the next start.
    console.error(`${DIM}The opt-in was kept, so reach will be retried when the server `
      + `next starts. Run ${RESET}tinstar reach off${DIM} if you do not want that.${RESET}`)
    process.exit(1)
  }
  printStatus(body?.data)
  console.log(`${DIM}This preference persists: a restart brings the same URL back.${RESET}`)
}

/**
 * Clearing the stored opt-in without the server.
 *
 * The CLI owns this half deliberately. `reach off` has to work when the server
 * is down — that is exactly when an operator wants to be sure they are not still
 * exposed — and the preference is a file this process can write itself.
 */
function clearPreferenceLocally() {
  const file = join(getConfigRoot(), 'reach', 'preference.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    if (raw?.enabled === false) return true
    writeFileSync(file, JSON.stringify({ ...raw, enabled: false }), { mode: 0o600 })
    return true
  } catch {
    // No preference file means no opt-in to clear, which is the desired end state.
    return !existsSync(file)
  }
}

async function reachOff() {
  // Always clear the opt-in first, so a server that never answers cannot leave
  // reach set to come back at the next start.
  const cleared = clearPreferenceLocally()

  let ok = false
  let body = null
  let unreachable = false
  try {
    ({ ok, body } = await api('/api/reach', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    }))
  } catch {
    // Distinct from a server that answered and said no. Both keep the grant, but
    // conflating them tells an operator to check the wrong thing — and the
    // server now has real reasons to refuse (a disabled instance, a mapping
    // owned by another one) whose message is the whole point.
    unreachable = true
  }

  if (!ok && !unreachable) {
    console.error(`${RED}✗${RESET} the server refused to take the mapping down: `
      + `${body?.error?.message ?? 'no reason given'}`)
    console.error(`${DIM}Keeping the privilege grant, since nothing was revoked.${RESET}`)
    process.exit(1)
  }

  if (!ok) {
    // The server could not be reached, so nothing has confirmed the mapping is
    // down. KEEP the grant: removing it here is what previously took away the
    // only means of finishing the job.
    console.error(`${RED}✗${RESET} could not reach the server to take the mapping down`)
    console.error(`${DIM}The opt-in is ${cleared ? 'cleared' : 'NOT cleared'}, so reach will not `
      + `come back on its own.${RESET}`)
    console.error(`${DIM}Your tailnet URL may still be live. Run ${RESET}tinstar doctor${DIM} to check, `
      + `then ${RESET}tinstar reach off${DIM} again once the server is up.${RESET}`)
    process.exit(1)
  }

  const status = body?.data
  if (status?.state === 'stranded') {
    // Same reasoning: the mapping is still up, so the grant has to stay.
    console.error(`${RED}✗${RESET} reach did not come down: ${status.detail ?? 'unknown reason'}`)
    console.error(`${DIM}Keeping the privilege grant so this can be retried.${RESET}`)
    process.exit(1)
  }

  // Confirmed down. The grant goes with the opt-in — leaving it behind would keep
  // a root-adjacent rule on the machine for a feature the operator turned off.
  removeReachGrant()
  printStatus(status)
}

export async function run(argv) {
  const sub = argv[0] ?? 'status'
  if (sub === 'status') return reachStatus()
  if (sub === 'on') return reachOn()
  if (sub === 'off') return reachOff()
  console.error(`unknown subcommand: reach ${sub}`)
  console.error('usage: tinstar reach [status|on|off]')
  process.exit(1)
}
