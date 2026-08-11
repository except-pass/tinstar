import { registerReachOrigin, unregisterReachOrigin } from '../api/originAllowlist'
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

/** What `revokeOurMapping` observed — not what it intended. */
type RevokeOutcome =
  /** Nothing recorded at all — there was genuinely nothing of ours to take down. */
  | { kind: 'nothing' }
  | { kind: 'revoked' }
  | { kind: 'failed'; url: string; detail: string }
  /**
   * A mapping IS recorded but it belongs to another instance. Distinct from
   * 'nothing': we revoked nothing in both cases, but here something is still
   * published, so answering 'off' would spend a host-global grant we do not own.
   */
  | { kind: 'foreign'; url: string }

export interface ReachCoordinatorOptions {
  configRoot: string
  provider: ReachProvider
  /**
   * Run this instance with reach off entirely — no state, no provider calls.
   * A second backend on one host must be usable rather than blocked (R24).
   */
  disabled: boolean
  now?: () => string
  /**
   * How long shutdown will wait for the provider before giving up. The shipped
   * systemd unit sets TimeoutStopSec=10 and the provider CLI carries a 30s exec
   * timeout, so an unbounded revoke can eat the entire stop grace and get the
   * process SIGKILLed before the docstore flushes.
   */
  shutdownTimeoutMs?: number
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
  private readonly shutdownTimeoutMs: number

  constructor(opts: ReachCoordinatorOptions) {
    this.configRoot = opts.configRoot
    this.provider = opts.provider
    this.disabled = opts.disabled
    this.instanceId = reachInstanceId(opts.configRoot)
    this.now = opts.now ?? (() => new Date().toISOString())
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 5_000
  }

  async status(): Promise<ReachStatus> {
    if (this.disabled) return { state: 'off', detail: 'reach disabled for this instance' }
    const mapping = readReachMapping(this.configRoot)
    if (!mapping || !mappingIsOurs(mapping, this.instanceId)) return { state: 'off' }
    // Preference off but our mapping still recorded is the stranded shape, and
    // it has to be derivable from the files alone — the process that failed the
    // revoke may be long gone, and a fresh one must reach the same conclusion
    // rather than reporting a mapping the operator already asked to remove.
    const preference = readReachPreference(this.configRoot)
    if (!preference?.enabled) {
      return this.stranded(mapping.url, 'reach was turned off but the mapping was not removed')
    }
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
    // 'off' is a claim that this instance CHECKED and nothing of ours is
    // published. An instance with reach disabled checked nothing, so it may not
    // make that claim: the CLI treats 'off' as confirmation and deletes the
    // host-global sudoers grant, which a second backend legitimately holding a
    // mapping still needs.
    if (this.disabled) {
      return {
        state: 'refused',
        detail: 'reach is disabled for this instance, so it cannot confirm any mapping is down',
      }
    }
    // The preference records the operator's wish and is written first: that much
    // is never in doubt, even when the provider will not cooperate.
    writeReachPreference(this.configRoot, { enabled: false, provider: this.provider.name })
    const outcome = await this.revokeOurMapping()
    if (outcome.kind === 'failed') return this.stranded(outcome.url, outcome.detail)
    if (outcome.kind === 'foreign') {
      return {
        state: 'refused',
        detail: `${this.provider.name} serves ${outcome.url} for another instance — `
          + 'this one revoked nothing, so the privilege grant must stay',
      }
    }
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
    // Bounded well under the unit's stop grace. Losing the revoke costs one
    // stale mapping that the next start's reconcile repairs; losing the
    // shutdown costs an unflushed docstore, which is not recoverable.
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        log.warn(
          'reach',
          `revoke exceeded ${this.shutdownTimeoutMs}ms at shutdown; leaving the `
          + 'mapping for the next start to reconcile',
        )
        resolve()
      }, this.shutdownTimeoutMs)
    })
    try {
      await Promise.race([this.revokeOurMapping(), bound])
    } finally {
      if (timer) clearTimeout(timer)
    }
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
      //
      // The origin still has to be registered: the mapping survives a restart on
      // disk, the in-memory allowlist does not. Registering only on the establish
      // path below tied the upgrade gate to which process created the mapping
      // rather than to which mapping is live, so a reconciled reach reported
      // active while every terminal upgrade from it was refused.
      registerReachOrigin(ours.url)
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
    // For the lifetime of this reach, and no longer (R19). Without it the
    // remote canvas loads but every credentialed API call it makes is refused.
    registerReachOrigin(mapping.url)
    log.info('reach', `${this.provider.name} now fronts :${mapping.port} at ${mapping.url}`)
    return { state: 'active', url: mapping.url }
  }

  /**
   * Takes our mapping down and says whether it actually went.
   *
   * The return value is the whole point. This used to be `Promise<void>`, so a
   * revoke that threw was indistinguishable from one that worked, and every
   * caller reported success either way.
   */
  private async revokeOurMapping(): Promise<RevokeOutcome> {
    const recorded = readReachMapping(this.configRoot)
    if (!recorded) return { kind: 'nothing' }
    if (!mappingIsOurs(recorded, this.instanceId)) return { kind: 'foreign', url: recorded.url }
    try {
      await this.provider.revoke({ port: recorded.port, url: recorded.url })
    } catch (err) {
      const detail = (err as Error).message
      log.warn('reach', `revoke failed, leaving the record for reconcile: ${detail}`)
      // The record stays: it is how `tinstar doctor` finds the stranded mapping
      // and how a retry knows which URL to take down.
      return { kind: 'failed', url: recorded.url, detail }
    }
    unregisterReachOrigin(recorded.url)
    clearReachMapping(this.configRoot)
    return { kind: 'revoked' }
  }

  /** The state a failed revoke leaves behind, phrased for an operator. */
  private stranded(url: string, detail: string): ReachStatus {
    return {
      state: 'stranded',
      url,
      detail: `${detail} — ${this.provider.name} may still serve ${url}. `
        + 'Re-run `tinstar reach off` once the provider is reachable, or run '
        + '`tinstar doctor` to see the current exposure.',
    }
  }

  private refuse(detail: string): ReachStatus {
    log.warn('reach', `not established — ${detail}`)
    return { state: 'refused', detail }
  }
}
