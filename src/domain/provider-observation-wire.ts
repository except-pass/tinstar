import { z } from 'zod'
import type { ProviderObservationSnapshotFor } from './provider-capabilities'

/**
 * Provider-neutral current-observation payloads exposed across process and UI
 * boundaries. Provider-owned `detail` is intentionally omitted from this wire
 * shape; native identity is carried by `providerId` and `source` instead.
 */
export type ProviderSessionUsageObservationWire = Omit<
  ProviderObservationSnapshotFor<'session-usage'>,
  'detail'
>

export type ProviderSessionContextObservationWire = Omit<
  ProviderObservationSnapshotFor<'session-context'>,
  'detail'
>

export type ProviderAccountQuotaObservationWire = Omit<
  ProviderObservationSnapshotFor<'provider-quota'>,
  'detail'
>

const nonEmptyString = z.string().min(1).refine(
  value => value.trim().length > 0,
  { message: 'string must contain a non-whitespace character' },
)
const isoTimestamp = z.string().datetime({ offset: true })
const nonNegativeNumber = z.number().finite().nonnegative()
const percent = z.number().finite().min(0).max(100)

const providerSourceSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
}).strict()

const providerSnapshotFreshnessSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('fresh'),
    observedAt: isoTimestamp,
    checkedAt: isoTimestamp,
    staleAfterMs: z.number().finite().nonnegative().optional(),
  }).strict(),
  z.object({
    state: z.literal('stale'),
    observedAt: isoTimestamp,
    checkedAt: isoTimestamp,
    staleSince: isoTimestamp.optional(),
  }).strict(),
  z.object({
    state: z.literal('unknown'),
    observedAt: isoTimestamp.nullable(),
    checkedAt: isoTimestamp,
  }).strict(),
])

const unavailableReasonSchema = z.enum([
  'not-observed',
  'source-error',
  'session-not-running',
  'not-applicable',
  'temporarily-unavailable',
])

const providerTokenUsageSchema = z.object({
  input: nonNegativeNumber.optional(),
  output: nonNegativeNumber.optional(),
  cacheRead: nonNegativeNumber.optional(),
  cacheWrite: nonNegativeNumber.optional(),
  reasoning: nonNegativeNumber.optional(),
  total: nonNegativeNumber.optional(),
}).strict().refine(
  value => Object.values(value).some(counter => counter !== undefined),
  { message: 'token usage must contain at least one counter' },
)

const providerSessionUsageSchema = z.object({
  model: nonEmptyString.optional(),
  cumulativeTokens: providerTokenUsageSchema.optional(),
  latestTurnTokens: providerTokenUsageSchema.optional(),
}).strict().refine(
  value => value.cumulativeTokens !== undefined || value.latestTurnTokens !== undefined,
  { message: 'session usage must contain cumulative or latest-turn tokens' },
)

const providerSessionContextSchema = z.object({
  usedTokens: nonNegativeNumber.optional(),
  windowTokens: nonNegativeNumber.optional(),
  usedPercent: percent.optional(),
}).strict().refine(
  value => Object.values(value).some(field => field !== undefined),
  { message: 'session context must contain at least one value' },
)

const providerQuotaWindowSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  windowMinutes: z.number().finite().positive(),
  usedPercent: percent,
  resetsAt: isoTimestamp.optional(),
}).strict()

const providerQuotaSchema = z.object({
  windows: z.array(providerQuotaWindowSchema).superRefine((windows, ctx) => {
    reportDuplicateIdentities(windows, window => window.id, 'quota window', ctx)
  }),
}).strict()

function availabilitySchema<TValue extends z.ZodTypeAny>(value: TValue) {
  return z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), value }).strict(),
    z.object({
      state: z.literal('unavailable'),
      reason: unavailableReasonSchema,
      message: z.string().optional(),
    }).strict(),
    z.object({ state: z.literal('unsupported'), reason: nonEmptyString }).strict(),
  ])
}

const providerSessionScopeSchema = z.object({
  kind: z.literal('session'),
  sessionId: nonEmptyString,
}).strict()

const providerAccountScopeSchema = z.object({
  kind: z.literal('provider'),
  accountRef: nonEmptyString,
}).strict()

function observationSchema<
  TKind extends 'session-usage' | 'session-context' | 'provider-quota',
  TScope extends z.ZodTypeAny,
  TValue extends z.ZodTypeAny,
>(kind: TKind, scope: TScope, value: TValue) {
  return z.object({
    kind: z.literal(kind),
    providerId: nonEmptyString,
    scope,
    source: providerSourceSchema.nullable(),
    freshness: providerSnapshotFreshnessSchema,
    availability: availabilitySchema(value),
  }).superRefine((observation, ctx) => {
    const availability = observation.availability
    if (!availability) return
    const unsupported = availability.state === 'unsupported'
    if (unsupported !== (observation.source === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: unsupported
          ? 'unsupported observations must not declare a native source'
          : 'supported observations must declare their native source',
        path: ['source'],
      })
    }
    if (unsupported && (
      observation.freshness.state !== 'unknown'
      || observation.freshness.observedAt !== null
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unsupported observations must have unknown freshness and no observation time',
        path: ['freshness'],
      })
    }
    if (
      availability.state === 'available'
      && observation.freshness.state === 'unknown'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'available observations must have fresh or stale observation time',
        path: ['freshness'],
      })
    }
  })
}

export const providerSessionUsageObservationWireSchema: z.ZodType<
  ProviderSessionUsageObservationWire
> = observationSchema(
  'session-usage',
  providerSessionScopeSchema,
  providerSessionUsageSchema,
) as unknown as z.ZodType<ProviderSessionUsageObservationWire>

export const providerSessionContextObservationWireSchema: z.ZodType<
  ProviderSessionContextObservationWire
> = observationSchema(
  'session-context',
  providerSessionScopeSchema,
  providerSessionContextSchema,
) as unknown as z.ZodType<ProviderSessionContextObservationWire>

export const providerAccountQuotaObservationWireSchema: z.ZodType<
  ProviderAccountQuotaObservationWire
> = observationSchema(
  'provider-quota',
  providerAccountScopeSchema,
  providerQuotaSchema,
) as unknown as z.ZodType<ProviderAccountQuotaObservationWire>

export interface ProviderCurrentObservationsWire {
  version: 1
  sessionUsage: ProviderSessionUsageObservationWire[]
  sessionContext: ProviderSessionContextObservationWire[]
  providerQuota: ProviderAccountQuotaObservationWire[]
}

export const providerCurrentObservationsWireSchema: z.ZodType<
  ProviderCurrentObservationsWire
> = z.object({
  version: z.literal(1),
  sessionUsage: z.array(providerSessionUsageObservationWireSchema),
  sessionContext: z.array(providerSessionContextObservationWireSchema),
  providerQuota: z.array(providerAccountQuotaObservationWireSchema),
}).strict().superRefine((wire, ctx) => {
  reportDuplicateIdentities(
    wire.sessionUsage,
    observation => JSON.stringify([
      observation.providerId,
      observation.scope.sessionId,
    ]),
    'session usage observation',
    ctx,
  )
  reportDuplicateIdentities(
    wire.sessionContext,
    observation => JSON.stringify([
      observation.providerId,
      observation.scope.sessionId,
    ]),
    'session context observation',
    ctx,
  )
  reportDuplicateIdentities(
    wire.providerQuota,
    observation => JSON.stringify([
      observation.providerId,
      observation.scope.accountRef,
    ]),
    'provider quota observation',
    ctx,
  )
})

/** Validate and clone an untrusted JSON-compatible observation bundle. */
export function parseProviderCurrentObservationsWire(
  input: unknown,
): ProviderCurrentObservationsWire {
  return providerCurrentObservationsWireSchema.parse(input)
}

function reportDuplicateIdentities<T>(
  values: readonly T[],
  identityFor: (value: T) => string,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  for (let index = 0; index < values.length; index += 1) {
    const identity = identityFor(values[index]!)
    if (seen.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate ${label} identity`,
        path: [index],
      })
    }
    seen.add(identity)
  }
}
