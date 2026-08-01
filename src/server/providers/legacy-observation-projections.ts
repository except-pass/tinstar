import type { ProviderSessionContextObservationWire } from '../../domain/provider-observation-wire'
import type { SessionContextSnapshot } from '../cc-quota/types'

/** Compatibility projection for the pre-provider context-window route. */
export function projectLegacySessionContextWindow(
  observation: ProviderSessionContextObservationWire | undefined,
): SessionContextSnapshot | null {
  if (observation?.availability.state !== 'available') return null
  const value = observation.availability.value
  if (value.usedPercent === undefined || value.windowTokens === undefined) return null
  if (observation.freshness.observedAt === null) return null
  return {
    usedPercentage: value.usedPercent,
    windowSize: value.windowTokens,
    fetchedAt: observation.freshness.observedAt,
  }
}
