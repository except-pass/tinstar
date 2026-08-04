import {
  parseProviderCurrentObservationsWire,
  providerAccountQuotaObservationWireSchema,
  providerCurrentObservationsWireSchema,
  providerSessionContextObservationWireSchema,
  providerSessionUsageObservationWireSchema,
  type ProviderAccountQuotaObservationWire,
  type ProviderCurrentObservationsWire,
  type ProviderSessionContextObservationWire,
  type ProviderSessionUsageObservationWire,
} from '../../domain/provider-observation-wire'

export interface ProviderObservationStoreOptions {
  /** Injected clock used only to resolve `fresh` snapshots past their stale deadline. */
  now?: () => number
}

export type ProviderSessionObservationChange =
  | {
      kind: 'session-usage'
      providerId: string
      sessionId: string
      observation: ProviderSessionUsageObservationWire | undefined
    }
  | {
      kind: 'session-context'
      providerId: string
      sessionId: string
      observation: ProviderSessionContextObservationWire | undefined
    }

export interface ProviderQuotaObservationChange {
  kind: 'provider-quota'
  providerId: string
  accountRef: string
  observation: ProviderAccountQuotaObservationWire | undefined
}

type SessionListener = (change: ProviderSessionObservationChange) => void
type QuotaListener = (change: ProviderQuotaObservationChange) => void

/** Current per-session usage and context, partitioned first by provider ID. */
export class ProviderSessionObservationStore {
  private readonly usage = new Map<
    string,
    Map<string, ProviderSessionUsageObservationWire>
  >()

  private readonly context = new Map<
    string,
    Map<string, ProviderSessionContextObservationWire>
  >()

  private readonly listeners = new Set<SessionListener>()
  private readonly now: () => number

  constructor(options: ProviderObservationStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  setUsage(input: ProviderSessionUsageObservationWire): boolean {
    const observation = providerSessionUsageObservationWireSchema.parse(input)
    const changed = setNested(
      this.usage,
      observation.providerId,
      observation.scope.sessionId,
      observation,
    )
    if (changed && this.listeners.size > 0) {
      this.emit({
        kind: 'session-usage',
        providerId: observation.providerId,
        sessionId: observation.scope.sessionId,
        observation: this.resolveUsage(observation),
      })
    }
    return changed
  }

  setContext(input: ProviderSessionContextObservationWire): boolean {
    const observation = providerSessionContextObservationWireSchema.parse(input)
    const changed = setNested(
      this.context,
      observation.providerId,
      observation.scope.sessionId,
      observation,
    )
    if (changed && this.listeners.size > 0) {
      this.emit({
        kind: 'session-context',
        providerId: observation.providerId,
        sessionId: observation.scope.sessionId,
        observation: this.resolveContext(observation),
      })
    }
    return changed
  }

  getUsage(
    providerId: string,
    sessionId: string,
  ): ProviderSessionUsageObservationWire | undefined {
    const observation = getNested(this.usage, providerId, sessionId)
    return observation ? this.resolveUsage(observation) : undefined
  }

  getContext(
    providerId: string,
    sessionId: string,
  ): ProviderSessionContextObservationWire | undefined {
    const observation = getNested(this.context, providerId, sessionId)
    return observation ? this.resolveContext(observation) : undefined
  }

  listUsage(): ProviderSessionUsageObservationWire[] {
    return listNested(this.usage).map(observation => this.resolveUsage(observation))
  }

  listContext(): ProviderSessionContextObservationWire[] {
    return listNested(this.context).map(observation => this.resolveContext(observation))
  }

  delete(providerId: string, sessionId: string): boolean {
    const deletedUsage = deleteNested(this.usage, providerId, sessionId)
    const deletedContext = deleteNested(this.context, providerId, sessionId)
    if (deletedUsage) {
      this.emit({ kind: 'session-usage', providerId, sessionId, observation: undefined })
    }
    if (deletedContext) {
      this.emit({ kind: 'session-context', providerId, sessionId, observation: undefined })
    }
    return deletedUsage || deletedContext
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: ProviderSessionObservationChange): void {
    for (const listener of this.listeners) listener(change)
  }

  private resolveUsage(
    observation: ProviderSessionUsageObservationWire,
  ): ProviderSessionUsageObservationWire {
    return resolveFreshness(structuredClone(observation), this.now())
  }

  private resolveContext(
    observation: ProviderSessionContextObservationWire,
  ): ProviderSessionContextObservationWire {
    return resolveFreshness(structuredClone(observation), this.now())
  }
}

/** Current account quota, partitioned by provider ID and opaque account ref. */
export class ProviderQuotaObservationStore {
  private readonly observations = new Map<
    string,
    Map<string, ProviderAccountQuotaObservationWire>
  >()

  private readonly listeners = new Set<QuotaListener>()
  private readonly now: () => number

  constructor(options: ProviderObservationStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  set(input: ProviderAccountQuotaObservationWire): boolean {
    const observation = providerAccountQuotaObservationWireSchema.parse(input)
    const changed = setNested(
      this.observations,
      observation.providerId,
      observation.scope.accountRef,
      observation,
    )
    if (changed && this.listeners.size > 0) {
      this.emit({
        kind: 'provider-quota',
        providerId: observation.providerId,
        accountRef: observation.scope.accountRef,
        observation: this.resolve(observation),
      })
    }
    return changed
  }

  get(
    providerId: string,
    accountRef: string,
  ): ProviderAccountQuotaObservationWire | undefined {
    const observation = getNested(this.observations, providerId, accountRef)
    return observation ? this.resolve(observation) : undefined
  }

  list(): ProviderAccountQuotaObservationWire[] {
    return listNested(this.observations).map(observation => this.resolve(observation))
  }

  delete(providerId: string, accountRef: string): boolean {
    const deleted = deleteNested(this.observations, providerId, accountRef)
    if (deleted) {
      this.emit({
        kind: 'provider-quota',
        providerId,
        accountRef,
        observation: undefined,
      })
    }
    return deleted
  }

  subscribe(listener: QuotaListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: ProviderQuotaObservationChange): void {
    for (const listener of this.listeners) listener(change)
  }

  private resolve(
    observation: ProviderAccountQuotaObservationWire,
  ): ProviderAccountQuotaObservationWire {
    return resolveFreshness(structuredClone(observation), this.now())
  }
}

/**
 * Shared server-owned observation state. The two stores remain separate so a
 * session key can never be mistaken for an account key, and quota has no API
 * that arithmetically combines provider/account partitions.
 */
export class ProviderCurrentObservationStores {
  readonly sessions: ProviderSessionObservationStore
  readonly quotas: ProviderQuotaObservationStore

  constructor(options: ProviderObservationStoreOptions = {}) {
    this.sessions = new ProviderSessionObservationStore(options)
    this.quotas = new ProviderQuotaObservationStore(options)
  }

  toWire(): ProviderCurrentObservationsWire {
    return providerCurrentObservationsWireSchema.parse({
      version: 1,
      sessionUsage: this.sessions.listUsage(),
      sessionContext: this.sessions.listContext(),
      providerQuota: this.quotas.list(),
    })
  }

  static fromWire(
    input: unknown,
    options: ProviderObservationStoreOptions = {},
  ): ProviderCurrentObservationStores {
    const wire = parseProviderCurrentObservationsWire(input)
    const stores = new ProviderCurrentObservationStores(options)
    for (const observation of wire.sessionUsage) stores.sessions.setUsage(observation)
    for (const observation of wire.sessionContext) stores.sessions.setContext(observation)
    for (const observation of wire.providerQuota) stores.quotas.set(observation)
    return stores
  }
}

function getNested<T>(
  root: Map<string, Map<string, T>>,
  outerKey: string,
  innerKey: string,
): T | undefined {
  return root.get(outerKey)?.get(innerKey)
}

function setNested<T>(
  root: Map<string, Map<string, T>>,
  outerKey: string,
  innerKey: string,
  value: T,
): boolean {
  let partition = root.get(outerKey)
  if (!partition) {
    partition = new Map()
    root.set(outerKey, partition)
  }
  if (JSON.stringify(partition.get(innerKey)) === JSON.stringify(value)) return false
  partition.set(innerKey, value)
  return true
}

function deleteNested<T>(
  root: Map<string, Map<string, T>>,
  outerKey: string,
  innerKey: string,
): boolean {
  const partition = root.get(outerKey)
  if (!partition?.delete(innerKey)) return false
  if (partition.size === 0) root.delete(outerKey)
  return true
}

function listNested<T>(root: Map<string, Map<string, T>>): T[] {
  const entries: Array<{ outerKey: string; innerKey: string; value: T }> = []
  for (const [outerKey, partition] of root) {
    for (const [innerKey, value] of partition) {
      entries.push({ outerKey, innerKey, value })
    }
  }
  entries.sort((left, right) => (
    left.outerKey.localeCompare(right.outerKey)
    || left.innerKey.localeCompare(right.innerKey)
  ))
  return entries.map(entry => entry.value)
}

function resolveFreshness<T extends
  | ProviderSessionUsageObservationWire
  | ProviderSessionContextObservationWire
  | ProviderAccountQuotaObservationWire
>(observation: T, now: number): T {
  const freshness = observation.freshness
  if (freshness.state !== 'fresh' || freshness.staleAfterMs === undefined) {
    return observation
  }
  const staleAt = Date.parse(freshness.observedAt) + freshness.staleAfterMs
  if (now < staleAt) return observation
  return {
    ...observation,
    freshness: {
      state: 'stale',
      observedAt: freshness.observedAt,
      checkedAt: freshness.checkedAt,
      staleSince: new Date(staleAt).toISOString(),
    },
  }
}
