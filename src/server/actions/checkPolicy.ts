import policyData from '../../../data/tinstar-pr-ops-actions/cmsandbox-check-policy.v2.json'
import type { ActionSnapshot, CheckPolicy } from '../../shared/actions'

export const cmsandboxCheckPolicy: CheckPolicy = policyData
/** No vacuous success: workflow coverage and exact publisher identity are required.
 * Retain all matching observations: a passing retry cannot hide a failed observation. */
export function validateChecks(snapshot: ActionSnapshot, policy: CheckPolicy): string[] {
  const reasons: string[] = []
  if (policy.workloads.some(workload => !workload.complete)) reasons.push(`Admin Merge disabled: incomplete check inventory ${policy.version}`)
  if (policy.repository !== snapshot.repository || !policy.version || !policy.common.length || !policy.workloads.length) reasons.push('Nonempty versioned check inventory unavailable')
  if (!snapshot.pathsComplete || !snapshot.changedPaths.length) reasons.push('Complete changed-path inventory required')
  const matching = policy.workloads.filter(workload => snapshot.changedPaths.some(path => workload.prefixes.some(prefix => path.startsWith(prefix)) && !workload.excludedPrefixes.some(prefix => path.startsWith(prefix))))
  for (const path of snapshot.changedPaths) if (!matching.some(workload => workload.complete && workload.prefixes.some(prefix => path.startsWith(prefix)) && !workload.excludedPrefixes.some(prefix => path.startsWith(prefix)))) reasons.push(`Admin Merge disabled for ${path}: ${policy.unknownReason}`)
  const required = [...policy.common, ...matching.flatMap(workload => workload.checks)]
  if (!required.length) reasons.push('No applicable required checks established')
  if (!snapshot.checksComplete) reasons.push('Check observations incomplete')
  for (const expected of required) {
    const exact = snapshot.checks.filter(check => check.name === expected.name && check.appId === expected.appId && check.appSlug === expected.appSlug)
    if (!exact.length) { reasons.push(`Missing required check ${expected.name} from ${expected.appSlug} (${expected.appId})`); continue }
    for (const check of exact) {
      if (check.head !== snapshot.head) reasons.push(`Stale check ${check.name}: head mismatch`)
      if (check.status !== 'completed' || check.conclusion !== 'success' || !check.completedAt) reasons.push(`Required check ${check.name}: ${check.conclusion ?? check.status}`)
    }
  }
  // Extra observed failures also block; an incomplete matrix must never hide a real failure.
  for (const check of snapshot.checks) if (check.head !== snapshot.head || check.status !== 'completed' || !['success', 'skipped', 'neutral'].includes(check.conclusion ?? '')) reasons.push(`Observed check ${check.name}: ${check.head !== snapshot.head ? 'stale' : check.conclusion ?? check.status}`)
  return [...new Set(reasons)]
}
