import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MESSAGE_ROUTE_SUBJECT_PREFIX = '_TINSTAR.delivery.route.v1'
export const TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV = 'TINSTAR_MESSAGE_ROUTER_SUBJECT'
export const TINSTAR_MESSAGE_ROUTER_AUTH_ENV = 'TINSTAR_MESSAGE_ROUTER_AUTH'
export const TINSTAR_NATS_URL_ENV = 'TINSTAR_NATS_URL'
export const TINSTAR_SESSION_NAME_ENV = 'TINSTAR_SESSION_NAME'
export const TINSTAR_AGENT_INCARNATION_ENV = 'TINSTAR_AGENT_INCARNATION'
export const MESSAGE_ROUTER_INSTANCE_FILE = '.message-router-instance'
export const MESSAGE_ROUTER_AUTH_FILE = '.message-router-auth'

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Stable, private instance identity shared by the host and managed MCP configs. */
export function messageRouterInstanceId(configRoot: string): string {
  const path = join(configRoot, MESSAGE_ROUTER_INSTANCE_FILE)
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (!INSTANCE_ID_PATTERN.test(existing)) {
      throw new Error(`invalid message router identity in ${path}`)
    }
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  mkdirSync(configRoot, { recursive: true })
  const created = randomUUID()
  try {
    writeFileSync(path, `${created}\n`, { flag: 'wx', mode: 0o600 })
    return created
  } catch (error) {
    // Concurrent config initialization may have won the exclusive create.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readFileSync(path, 'utf8').trim()
    if (!INSTANCE_ID_PATTERN.test(existing)) {
      throw new Error(`invalid message router identity in ${path}`)
    }
    return existing
  }
}

/**
 * Stable broker-local service address for one Tinstar data root.
 *
 * Multiple Tinstar instances can share an external NATS broker. Scoping the
 * responder by data root prevents a request from being accepted against the
 * wrong session registry, while keeping the address stable across restarts.
 * The internal prefix deliberately does not overlap managed `tinstar.*`
 * subjects, so a control request cannot look like an agent message in Saloon.
 */
export function messageRouterSubject(configRoot: string): string {
  const instance = createHash('sha256')
    .update(messageRouterInstanceId(configRoot))
    .digest('hex')
    .slice(0, 24)
  return `${MESSAGE_ROUTE_SUBJECT_PREFIX}.${instance}`
}
