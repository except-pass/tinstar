import type { Server } from 'node:http'

/**
 * The one place the loopback address is written down.
 *
 * The dashboard listener and every spawned ttyd both key on it — the listener
 * as its default bind, the terminal spawner as the address it hands ttyd's
 * `-i`. Two independent literals would be two independent defaults, and a
 * later edit to one of them would silently widen the other's blast radius.
 * Deliberately import-light so a test can read it without dragging in the
 * sessions/NATS chain.
 */
export const LOOPBACK_BIND_ADDRESS = '127.0.0.1'

/**
 * The IPv6 loopback, bound alongside the IPv4 one because `localhost` resolves
 * `::1` first on most modern hosts — binding only `127.0.0.1` would leave
 * `http://localhost:<port>` looking down to anything that does not fall back.
 */
export const LOOPBACK_BIND_ADDRESS_V6 = '::1'

export interface BindTarget {
  host: string
  /**
   * Whether a bind failure on this address is fatal. False only for the IPv6
   * loopback we add ourselves: the listener loop rolls every listener back when
   * one fails, so an unconditional `::1` would stop an IPv6-disabled host from
   * booting at all. An address the operator explicitly named is always required
   * — silently not binding what they asked for is worse than refusing to start.
   */
  required: boolean
}

export interface ResolvedBind {
  /** Addresses to listen on, in order. Never empty. */
  targets: BindTarget[]
  /** Host for the browser-open URL and the startup log line. */
  preferredHost: string
  /**
   * Value written to `server.host`. Never an IPv6 literal: `bin/apiBase.js`
   * builds `http://${host}:${port}` with no bracketing, so `::1` there would
   * produce `http://::1:5273` and break every `tinstar` subcommand.
   */
  hostFileValue: string
}

/** A wildcard or loopback host already reaches host-local callers. */
function coversLocalhost(hosts: string[]): boolean {
  return hosts.some(h =>
    h === '0.0.0.0' || h === '::' || h === LOOPBACK_BIND_ADDRESS || h === 'localhost')
}

function isIPv6Literal(host: string): boolean {
  return host.includes(':')
}

/**
 * Decide what the server binds.
 *
 * No host is the case that changed: it used to mean `listen(port)` with no
 * address — one listener on every interface, which is how a machine with no
 * firewall ended up serving an unauthenticated writable shell to its whole
 * LAN. It now means the loopback pair, and widening is an explicit act.
 *
 * Pure so the default, the explicit-host path and the localhost force-add can
 * be asserted without booting a server.
 */
export function resolveBindTargets(host?: string | string[]): ResolvedBind {
  const explicit = (Array.isArray(host) ? host : (host ? [host] : []))
    .filter(h => h && h.length > 0)

  if (explicit.length === 0) {
    return {
      targets: [
        { host: LOOPBACK_BIND_ADDRESS, required: true },
        { host: LOOPBACK_BIND_ADDRESS_V6, required: false },
      ],
      preferredHost: 'localhost',
      hostFileValue: LOOPBACK_BIND_ADDRESS,
    }
  }

  const targets: BindTarget[] = explicit.map(h => ({ host: h, required: true }))
  // Keep localhost-pointing hooks (project .claude/settings.json, the cc-quota
  // statusline, bin/apiBase.js) working when the server is exposed on a
  // specific external interface. Keyed on the IPv4 literal on purpose: an
  // explicit `::1` must still gain 127.0.0.1, or the host file has no
  // unbracketable address to record.
  if (!coversLocalhost(explicit)) {
    targets.push({ host: LOOPBACK_BIND_ADDRESS, required: true })
  }

  const addressable = explicit.find(h => !isIPv6Literal(h)) ?? LOOPBACK_BIND_ADDRESS
  return { targets, preferredHost: addressable, hostFileValue: addressable }
}

/**
 * Bind failures a best-effort address may be skipped for: the address family
 * is unavailable, or the address itself does not exist on this host. Notably
 * NOT `EADDRINUSE` — that one must stay fatal so the caller's port-fallback
 * path still runs, rather than the server quietly serving on fewer addresses
 * than it reported.
 */
function isAddressUnavailable(err: NodeJS.ErrnoException): boolean {
  return err.code === 'EAFNOSUPPORT'
    || err.code === 'EADDRNOTAVAIL'
    || err.code === 'EPROTONOSUPPORT'
    || err.code === 'EINVAL'
}

/**
 * Open one listener per target on the same port, rolling every listener back
 * if a required one fails — a half-bound server is worse than an unstarted
 * one, and the caller retries the whole set on the next port.
 */
export async function openListeners(
  targets: readonly BindTarget[],
  port: number,
  makeServer: () => Server,
  onSkipped?: (target: BindTarget, err: NodeJS.ErrnoException) => void,
): Promise<Server[]> {
  const opened: Server[] = []
  try {
    for (const target of targets) {
      const s = makeServer()
      try {
        await new Promise<void>((resolve, reject) => {
          const onErr = (err: NodeJS.ErrnoException) => {
            s.removeListener('listening', onOk)
            reject(err)
          }
          const onOk = () => { s.removeListener('error', onErr); resolve() }
          s.once('error', onErr)
          s.once('listening', onOk)
          s.listen(port, target.host)
        })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (!target.required && isAddressUnavailable(e)) {
          try { s.close() } catch { /* never bound */ }
          onSkipped?.(target, e)
          continue
        }
        throw err
      }
      opened.push(s)
    }
    return opened
  } catch (err) {
    for (const s of opened) { try { s.close() } catch { /* best effort */ } }
    throw err
  }
}
