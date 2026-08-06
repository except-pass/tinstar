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

import { getApiBase } from '../../apiBase.js'
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
    process.exit(1)
  }
  printStatus(body?.data)
  console.log(`${DIM}This preference persists: a restart brings the same URL back.${RESET}`)
}

async function reachOff() {
  const { ok, body } = await api('/api/reach', {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  })
  if (!ok) {
    console.error(`${RED}✗${RESET} ${body?.error?.message ?? 'could not turn reach off'}`)
    process.exit(1)
  }
  // The grant goes with the opt-in. Leaving it behind would keep a root-adjacent
  // rule on the machine for a feature the operator just turned off.
  removeReachGrant()
  printStatus(body?.data)
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
