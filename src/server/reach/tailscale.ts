import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION_PROXY_HOST } from '../sessionProxy'
import type { ReachProvider, ReachProviderMapping } from './provider'

const execFileAsync = promisify(execFile)

/**
 * The Tailscale reach adapter — the one adapter that ships.
 *
 * Talks to the CLI rather than the local socket API: the socket API is
 * explicitly unstable for third parties and platform-specific, while the CLI is
 * the supported surface (KTD6). Mutations shell out; reads use the
 * machine-readable status forms, which need no privilege.
 */

/**
 * Bulletins TS-2026-005, TS-2026-007 and TS-2026-008 are all fixed in 1.98.9.
 * TS-2026-008 in particular pins a CPU core indefinitely from a single
 * malformed HTTP request to a node running Serve, reachable by any tailnet
 * peer — that is, an unauthenticated denial of service against the exact
 * surface this feature turns on. Refused below the floor rather than warned
 * (KTD12).
 */
export const TAILSCALE_MIN_VERSION = '1.98.9'

/**
 * When the floor above was last checked against the published bulletin index.
 * Surfaced by `tinstar doctor` because a floor that has gone stale after a
 * later advisory is otherwise invisible — nothing else in the system would
 * ever mention it.
 */
export const TAILSCALE_FLOOR_VERIFIED_ON = '2026-08-05'

/** `tailscale version` prints the version alone on its first line. */
export function parseTailscaleVersion(stdout: string): string | null {
  const first = stdout.split('\n')[0]?.trim() ?? ''
  const match = first.match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

/**
 * Numeric, component-wise. A lexical compare would put '1.98.10' *below*
 * '1.98.9' and silently admit a vulnerable build.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Establishing is a background mutation that must never wait on a human. */
export function serveEstablishArgv(port: number): string[] {
  return ['serve', '--bg', '--yes', '--https=443', `http://${SESSION_PROXY_HOST}:${port}`]
}

/**
 * The scoped removal, never `tailscale serve reset` — reset wipes the node's
 * entire serving configuration, including mappings the operator created by
 * hand (KTD5).
 */
export function serveRevokeArgv(_mapping: ReachProviderMapping): string[] {
  return ['serve', '--bg', '--yes', '--https=443', 'off']
}

interface ServeConfig {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

/**
 * Everything the node currently serves, as loopback-port-plus-URL pairs.
 *
 * Handlers that are not a loopback proxy (static text, a file share) are not
 * mappings this adapter could own, so they are skipped rather than reported as
 * a mapping with no port.
 */
export function parseServeMappings(stdout: string): ReachProviderMapping[] {
  let config: ServeConfig
  try {
    config = JSON.parse(stdout || '{}') as ServeConfig
  } catch {
    return []
  }
  const mappings: ReachProviderMapping[] = []
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    for (const handler of Object.values(web.Handlers ?? {})) {
      if (!handler.Proxy) continue
      let port: number
      try {
        port = Number(new URL(handler.Proxy).port)
      } catch {
        continue
      }
      if (!Number.isInteger(port) || port <= 0) continue
      mappings.push({ port, url: `https://${hostPort.replace(/:443$/, '')}` })
    }
  }
  return mappings
}

interface TailscaleStatus {
  BackendState?: string
  Self?: { DNSName?: string }
  CertDomains?: string[]
}

export type ReachExec = (
  argv: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ReachExec = async argv => {
  const { stdout, stderr } = await execFileAsync('tailscale', [...argv], { timeout: 30_000 })
  return { stdout, stderr }
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isPermissionRefusal(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? ''}`.toLowerCase()
  return text.includes('access denied')
    || text.includes('permission denied')
    || text.includes('operation not permitted')
    || text.includes('must be run as root')
    || text.includes('a password is required')
}

export class TailscaleReachProvider implements ReachProvider {
  readonly name = 'tailscale'
  private readonly exec: ReachExec

  constructor(opts: { exec?: ReachExec } = {}) {
    this.exec = opts.exec ?? defaultExec
  }

  /**
   * Read-only and unprivileged, so it is safe to call at every boot — including
   * on a host that has never heard of Tailscale, where it reports nothing
   * rather than failing a start.
   */
  async currentMappings(): Promise<ReachProviderMapping[]> {
    try {
      const { stdout } = await this.exec(['serve', 'status', '--json'])
      return parseServeMappings(stdout)
    } catch (err) {
      if (isMissingBinary(err)) return []
      throw new Error(`could not read tailscale serve status: ${(err as Error).message}`)
    }
  }

  async establish(opts: { port: number }): Promise<ReachProviderMapping> {
    const version = await this.requireVersion()
    const name = await this.requireServableNode()

    try {
      await this.exec(serveEstablishArgv(opts.port))
    } catch (err) {
      if (isPermissionRefusal(err)) {
        throw new Error(
          'tailscale serve needs privilege that is not available non-interactively. '
          + 'Install the scoped sudoers grant with `tinstar service install` — it '
          + 'permits exactly this serve invocation and no other subcommand. '
          + `(tailscale ${version})`,
        )
      }
      throw new Error(`tailscale serve failed: ${(err as Error).message}`)
    }

    // Read the mapping back rather than assuming it: the node's own URL is the
    // provider's to decide, and a certificate may still be provisioning.
    const mappings = await this.currentMappings()
    return mappings.find(m => m.port === opts.port)
      ?? { port: opts.port, url: `https://${name}` }
  }

  async revoke(mapping: ReachProviderMapping): Promise<void> {
    try {
      await this.exec(serveRevokeArgv(mapping))
    } catch (err) {
      if (isMissingBinary(err)) return
      throw new Error(`tailscale serve off failed: ${(err as Error).message}`)
    }
  }

  private async requireVersion(): Promise<string> {
    let stdout: string
    try {
      ({ stdout } = await this.exec(['version']))
    } catch (err) {
      if (isMissingBinary(err)) {
        throw new Error('tailscale is not installed or not on PATH')
      }
      throw new Error(`could not read the tailscale version: ${(err as Error).message}`)
    }
    const version = parseTailscaleVersion(stdout)
    if (!version) throw new Error('tailscale is not on PATH in a recognizable form')
    if (compareVersions(version, TAILSCALE_MIN_VERSION) < 0) {
      throw new Error(
        `tailscale ${version} is below the required ${TAILSCALE_MIN_VERSION}. `
        + 'Releases below that carry an unauthenticated denial of service against '
        + 'the serve path this feature turns on, so reach is refused rather than '
        + 'warned. Upgrade tailscale and retry.',
      )
    }
    return version
  }

  /** Returns the node's DNS name once every tailnet-wide prerequisite holds. */
  private async requireServableNode(): Promise<string> {
    let status: TailscaleStatus
    try {
      const { stdout } = await this.exec(['status', '--json'])
      status = JSON.parse(stdout) as TailscaleStatus
    } catch (err) {
      throw new Error(`could not read tailscale status: ${(err as Error).message}`)
    }

    if (status.BackendState !== 'Running') {
      throw new Error(
        `tailscale is not running (state: ${status.BackendState ?? 'unknown'}). `
        + 'Run `tailscale up` first.',
      )
    }

    // MagicDNS and HTTPS certificates are tailnet-wide ADMIN settings, not
    // device settings. A node with either off fails to serve with no local
    // cause to find, so both are named explicitly rather than surfaced as a
    // generic serve failure.
    const name = status.Self?.DNSName?.replace(/\.$/, '')
    if (!name) {
      throw new Error(
        'this node has no MagicDNS name. Enable MagicDNS for the tailnet in the '
        + 'Tailscale admin console (DNS settings) — it is a tailnet-wide setting.',
      )
    }
    if (!status.CertDomains?.length) {
      throw new Error(
        'HTTPS certificates are not enabled for this tailnet. Enable HTTPS in the '
        + 'Tailscale admin console (DNS settings) — it is a tailnet-wide setting, '
        + 'and serve cannot issue a certificate without it.',
      )
    }
    return name
  }
}
