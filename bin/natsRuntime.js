// bin/natsRuntime.js — probes the runtime the NATS channel feature needs.
//
// The Saloon widget and agent-to-agent messaging ride on a per-session MCP
// server that Tinstar launches with `bun x <channel-server-package>` (see
// `generateNatsMcpConfig` in src/server/sessions/backends/tmux.ts). The
// generated sessions/<name>/nats-mcp.json spawns bun by ABSOLUTE path, so a bun
// that exists somewhere on $PATH but not at the configured `nats.bunPath` still
// fails — `which bun` is the wrong question. Probe the configured path instead.
//
// Missing bun is a silent, deferred failure: nats-server and Tinstar's own
// observer stay healthy, so nothing looks wrong until an agent tries to send a
// message and its MCP has already died at spawn with ENOENT. Both `npx tinstar`
// preflight and `tinstar doctor` call in here so it gets caught at onboarding.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getConfigRoot } from './configRoot.js'

export const BUN_INSTALL_HINT = 'install: curl -fsSL https://bun.sh/install | bash'

/**
 * The bun path sessions actually launch. Mirrors `nats.bunPath` resolution in
 * src/server/sessions/config.ts: user config.json wins, else ~/.bun/bin/bun.
 * Note this is a binary path, not a config path — homedir() is correct here,
 * while the config.json it reads comes from getConfigRoot() as usual.
 */
export function resolveBunPath() {
  try {
    const cfg = JSON.parse(readFileSync(join(getConfigRoot(), 'config.json'), 'utf-8'))
    const configured = cfg?.nats?.bunPath
    if (typeof configured === 'string' && configured.length > 0) return configured
  } catch {
    // No config.json, or unparseable — the Config section of doctor reports
    // that separately. Fall through to the same default the server uses.
  }
  return join(homedir(), '.bun/bin/bun')
}

/**
 * Sessions that already carry a generated nats-mcp.json — i.e. NATS is not
 * hypothetical on this host, it is wired up and (without bun) broken.
 */
export function countNatsSessions() {
  const sessionsDir = join(getConfigRoot(), 'sessions')
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(sessionsDir, d.name, 'nats-mcp.json')))
      .length
  } catch {
    return 0
  }
}

/**
 * Probe the configured bun binary. Returns
 * `{ ok, path, natsSessions, version? , reason? }`.
 */
export function probeBun() {
  const path = resolveBunPath()
  const natsSessions = countNatsSessions()

  if (!existsSync(path)) return { ok: false, path, natsSessions, reason: 'not found' }

  try {
    const version = execFileSync(path, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim()
    return { ok: true, path, natsSessions, version }
  } catch (err) {
    return { ok: false, path, natsSessions, reason: `not runnable (${err.code ?? err.message})` }
  }
}

/** Why a missing bun matters on THIS host — sharper wording once NATS is in use. */
export function describeMissingBun(probe) {
  if (probe.natsSessions === 0) return 'multi-agent NATS sessions (Saloon, agent-to-agent messaging) will fail'
  return probe.natsSessions === 1
    ? '1 session uses NATS — its channel MCP dies at spawn'
    : `${probe.natsSessions} sessions use NATS — their channel MCP dies at spawn`
}
