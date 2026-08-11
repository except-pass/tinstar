import { getConfigRoot } from '../configRoot'
import { ReachCoordinator } from './coordinator'
import type { ReachProvider, ReachProviderMapping } from './provider'
import { TailscaleReachProvider } from './tailscale'

export { ReachCoordinator } from './coordinator'
export type {
  ReachProvider,
  ReachProviderMapping,
  ReachState,
  ReachStatus,
} from './provider'
export type { ReachMapping, ReachPreference } from './state'
export {
  TAILSCALE_FLOOR_VERIFIED_ON,
  TAILSCALE_MIN_VERSION,
  TailscaleReachProvider,
  compareVersions,
} from './tailscale'

/**
 * The inert adapter, kept for tests and for any build that ships without one.
 * It never claims a mapping, so a host using it behaves exactly as it did
 * before reach existed.
 */
export const unconfiguredReachProvider: ReachProvider = {
  name: 'none',
  async currentMappings(): Promise<ReachProviderMapping[]> { return [] },
  async establish(): Promise<ReachProviderMapping> {
    throw new Error('no reach adapter is configured on this build')
  },
  async revoke(): Promise<void> { /* nothing was ever established */ },
}

/**
 * Reach is off unless the operator opted in, and can be forced off for this
 * process with `--no-reach` / `TINSTAR_NO_REACH=1` — which is what makes a
 * second backend on one host usable rather than blocked (R24).
 */
export function reachDisabledByStartupFlag(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--no-reach') || process.env.TINSTAR_NO_REACH === '1'
}

let coordinator: ReachCoordinator | null = null

/** One coordinator per process, built from the live config root. */
export function getReachCoordinator(
  provider: ReachProvider = new TailscaleReachProvider(),
): ReachCoordinator {
  coordinator ??= new ReachCoordinator({
    configRoot: getConfigRoot(),
    provider,
    disabled: reachDisabledByStartupFlag(),
  })
  return coordinator
}

/** Tests only — the singleton would otherwise outlive a temp config root. */
export function resetReachCoordinatorForTests(): void {
  coordinator = null
}
