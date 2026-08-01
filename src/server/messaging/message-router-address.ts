import { createHash } from 'node:crypto'

export const MESSAGE_ROUTE_SUBJECT_PREFIX = '_TINSTAR.delivery.route.v1'
export const TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV = 'TINSTAR_MESSAGE_ROUTER_SUBJECT'
export const TINSTAR_NATS_URL_ENV = 'TINSTAR_NATS_URL'
export const TINSTAR_SESSION_NAME_ENV = 'TINSTAR_SESSION_NAME'
export const TINSTAR_AGENT_INCARNATION_ENV = 'TINSTAR_AGENT_INCARNATION'

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
  const instance = createHash('sha256').update(configRoot).digest('hex').slice(0, 24)
  return `${MESSAGE_ROUTE_SUBJECT_PREFIX}.${instance}`
}
