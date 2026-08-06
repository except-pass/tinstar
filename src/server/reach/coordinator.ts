import { log } from '../logger'
import type { ReachProvider, ReachProviderMapping, ReachStatus } from './provider'
import {
  clearReachMapping,
  mappingIsOurs,
  reachInstanceId,
  readReachMapping,
  readReachPreference,
  writeReachMapping,
  writeReachPreference,
  type ReachMapping,
} from './state'

export interface ReachCoordinatorOptions {
  configRoot: string
  provider: ReachProvider
  /**
   * Run this instance with reach off entirely — no state, no provider calls.
   * A second backend on one host must be usable rather than blocked (R24).
   */
  disabled: boolean
  now?: () => string
}

/**
 * Owns the reach lifecycle: opt-in, establish, reconcile, revoke.
 *
 * Every failure path returns a `refused` status instead of throwing. This runs
 * from the listener's post-bind callback and from the shutdown block, and
 * neither may be taken down by a provider that is missing, out of date, or
 * simply not running.
 */
export class ReachCoordinator {
  private readonly configRoot: string
  private readonly provider: ReachProvider
  private readonly disabled: boolean
  private readonly instanceId: string
  private readonly now: () => string

  constructor(opts: ReachCoordinatorOptions) {
    this.configRoot = opts.configRoot
    this.provider = opts.provider
    this.disabled = opts.disabled
    this.instanceId = reachInstanceId(opts.configRoot)
    this.now = opts.now ?? (() => new Date().toISOString())
  }

  async status(): Promise<ReachStatus> {
    if (this.disabled) return { state: 'off', detail: 'reach disabled for this instance' }
    const mapping = readReachMapping(this.configRoot)
    if (!mapping || !mappingIsOurs(mapping, this.instanceId)) return { state: 'off' }
    return { state: 'active', url: mapping.url }
  }

  /**
   * The operator's explicit opt-in (R6). The preference is written even when
   * establishing fails, so a transient provider outage does not silently
   * discard the decision — reconcile picks it up on the next start.
   */
  async enable(boundPort: number): Promise<ReachStatus> {
    if (this.disabled) {
      return { state: 'refused', detail: 'reach is disabled for this instance' }
    }
    writeReachPreference(this.configRoot, { enabled: true, provider: this.provider.name })
    return this.establish(boundPort)
  }

  /** Turns the opt-in off, and takes down our mapping if we hold one. */
  async disable(): Promise<ReachStatus> {
    if (this.disabled) return { state: 'off' }
    writeReachPreference(this.configRoot, { enabled: false, provider: this.provider.name })
    await this.revokeOurMapping()
    return { state: 'off' }
  }

  /**
   * Called from the listener's post-bind callback with the port that actually
   * bound. The configured port is the wrong input: the listener falls back to a
   * higher one when it is busy, and fronting the configured port would leave
   * the remote URL pointing at nothing while `localhost` worked fine.
   */
  async onListening(boundPort: number): Promise<ReachStatus> {
    if (this.disabled) return { state: 'off' }
    const preference = readReachPreference(this.configRoot)
    if (!preference?.enabled) return { state: 'off' }
    return this.establish(boundPort)
  }

  /**
   * Clean shutdown clears the mapping and NEVER the preference. Erasing the
   * opt-in here is the failure this shape exists to prevent: reach would come
   * down at every stop and silently never come back.
   */
  async shutdown(): Promise<void> {
    if (this.disabled) return
    await this.revokeOurMapping()
  }

  private async establish(boundPort: number): Promise<ReachStatus> {
    let existing: ReachProviderMapping[]
    try {
      existing = await this.provider.currentMappings()
    } catch (err) {
      return this.refuse(`could not read ${this.provider.name} state: ${(err as Error).message}`)
    }

    const recorded = readReachMapping(this.configRoot)
    const ours = mappingIsOurs(recorded, this.instanceId) ? recorded : null

    // Anything the provider serves that we did not record belongs to another
    // Tinstar instance or to the operator's own hand-made configuration. Taking
    // it over would redirect their remote URL at us (KTD16).
    const foreign = existing.filter(m => !(ours && m.port === ours.port && m.url === ours.url))
    if (foreign.length > 0) {
      return this.refuse(
        `${this.provider.name} already serves ${foreign.map(m => m.url).join(', ')}`
        + ' — another Tinstar instance or a hand-made mapping holds it',
      )
    }

    if (ours && ours.port === boundPort) {
      // Already correct. Confirming rather than re-establishing is what keeps
      // repeated reconciles from stacking duplicates.
      return { state: 'active', url: ours.url }
    }

    if (ours) {
      // The port moved under us — repair rather than add a second mapping.
      try {
        await this.provider.revoke({ port: ours.port, url: ours.url })
      } catch (err) {
        log.warn('reach', `could not remove the stale mapping on :${ours.port}: ${(err as Error).message}`)
      }
      clearReachMapping(this.configRoot)
    }

    let mapping: ReachProviderMapping
    try {
      mapping = await this.provider.establish({ port: boundPort })
    } catch (err) {
      return this.refuse((err as Error).message)
    }

    const record: Omit<ReachMapping, 'version'> = {
      provider: this.provider.name,
      instanceId: this.instanceId,
      url: mapping.url,
      port: mapping.port,
      establishedAt: this.now(),
    }
    writeReachMapping(this.configRoot, record)
    log.info('reach', `${this.provider.name} now fronts :${mapping.port} at ${mapping.url}`)
    return { state: 'active', url: mapping.url }
  }

  private async revokeOurMapping(): Promise<void> {
    const recorded = readReachMapping(this.configRoot)
    if (!mappingIsOurs(recorded, this.instanceId) || !recorded) return
    try {
      await this.provider.revoke({ port: recorded.port, url: recorded.url })
    } catch (err) {
      log.warn('reach', `revoke failed, leaving the record for reconcile: ${(err as Error).message}`)
      return
    }
    clearReachMapping(this.configRoot)
  }

  private refuse(detail: string): ReachStatus {
    log.warn('reach', `not established — ${detail}`)
    return { state: 'refused', detail }
  }
}
