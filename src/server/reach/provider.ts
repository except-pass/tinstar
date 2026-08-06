/**
 * The reach provider port.
 *
 * Deliberately abstract: exactly one adapter ships (Tailscale), but rooms and
 * presence work will share this seam, and a provider that is not a tailnet must
 * be addable without touching callers.
 *
 * Note what is NOT here. There is no start/stop of a child process, because
 * establishing reach mutates provider daemon configuration and returns — there
 * is no pid and no port for Tinstar to own. Durability therefore comes from a
 * state file plus reconcile-on-start, which is the trade KTD4 accepted: the
 * mapping survives a reboot, at the cost of repairing drift after a crash.
 */

/** One mapping the provider currently serves, as the provider reports it. */
export interface ReachProviderMapping {
  /** The loopback port this mapping fronts. */
  port: number
  url: string
}

export type ReachState =
  /** No opt-in, or the operator turned it off. */
  | 'off'
  /** A mapping is live and the URL is usable. */
  | 'active'
  /** The provider accepted the mapping but the certificate is not ready. */
  | 'provisioning'
  /** A precondition was unmet; `detail` names which. */
  | 'refused'

export interface ReachStatus {
  state: ReachState
  url?: string
  /** Human-readable reason, present whenever the state is not 'active'. */
  detail?: string
}

export interface ReachProvider {
  readonly name: string
  /**
   * Everything the provider currently serves — not just Tinstar's own mapping.
   * This is how a second instance discovers it is not the holder, and how
   * reconcile tells "my mapping is already there" from "someone else's is".
   */
  currentMappings(): Promise<ReachProviderMapping[]>
  establish(opts: { port: number }): Promise<ReachProviderMapping>
  /** Removes exactly this mapping — never the provider's reset form (KTD5). */
  revoke(mapping: ReachProviderMapping): Promise<void>
}
