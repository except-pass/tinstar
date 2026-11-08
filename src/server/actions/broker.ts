import { operationSchema, readerRepositories, type ActionOperation, type ActionSnapshot, type CheckPolicy, type InstalledAction, type ActionReceipt } from '../../shared/actions'
import { releasePull } from '../../shared/releases'
import { validateChecks } from './checkPolicy'

const readPermissions = { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', actions: 'read' } as const
export class BrokerEffectError extends Error {
  constructor(message: string, readonly outcome: 'not-sent' | 'unknown') { super(message) }
}
export const appProfiles = {
  Reader: { repositories: readerRepositories, permissions: readPermissions },
  Repair: { repositories: ['fortresspower/cmsandbox'], permissions: { ...readPermissions, contents: 'write', pull_requests: 'write', actions: 'write' } },
  Merge: { repositories: ['fortresspower/cmsandbox'], permissions: { ...readPermissions, contents: 'write' } },
} as const
export const profileFor = (kind: string) => kind === 'merge.admin' ? 'Merge' : kind.startsWith('repair.') ? 'Repair' : 'Reader'
const scoped = (value: string, patterns: string[]) => patterns.some(pattern => pattern === '**' || pattern === value || pattern.endsWith('/**') && value.startsWith(pattern.slice(0, -2)))
export interface BrokerInvocation { actor: string; explicit: boolean; origin: 'user' | 'ask-answer'; job?: { id: number; runId: number; head: string; status: string; conclusion: string | null; runAttempt: number; dependentJobs: number[] | null } }
export function validateTarget(installed: InstalledAction, captured: ActionSnapshot, live: ActionSnapshot, invocation: BrokerInvocation): string[] {
  const reasons: string[] = []
  const identity = releasePull(captured.url)
  if (!identity || identity.id !== captured.id || identity.repository !== captured.repository || identity.number !== captured.number || live.id !== captured.id || live.url !== captured.url || live.repository !== captured.repository || live.number !== captured.number) reasons.push('PR identity mismatch')
  if (!invocation.actor || !invocation.explicit || invocation.origin !== 'user') reasons.push('Explicit authenticated user invocation required; an Ask answer grants no authority')
  const { manifest, grant } = installed
  if (grant.digest !== manifest.digest || grant.version !== manifest.version) reasons.push('Installed version/grant mismatch')
  if (!manifest.repositories.includes(captured.repository as typeof readerRepositories[number]) || !grant.repositories.includes(captured.repository)) reasons.push(`Repository outside installed grant: ${captured.repository}`)
  if (!scoped(live.base, manifest.branches) || !scoped(live.base, grant.branches)) reasons.push('Target branch outside installed grant')
  if (!readerRepositories.includes(live.repository as typeof readerRepositories[number])) reasons.push('Repository outside approved Reader scope')
  if (captured.head !== live.head || captured.base !== live.base || captured.baseHead !== live.baseHead || captured.headRef !== live.headRef || captured.headRepository !== live.headRepository) reasons.push('Captured head/base changed; refresh and explicitly replan')
  if (live.changedPaths.some(path => !scoped(path, manifest.paths) || !scoped(path, grant.paths))) reasons.push('Changed path outside installed grant')
  if (!live.pathsComplete && (!manifest.paths.includes('**') || !grant.paths.includes('**'))) reasons.push('Complete changed paths required for scoped reads')
  if (Date.now() - Date.parse(live.observedAt) > 30_000 || !Number.isFinite(Date.parse(live.observedAt))) reasons.push('Fresh immediate provider observation required')
  return reasons
}
export function validateOperation(installed: InstalledAction, captured: ActionSnapshot, live: ActionSnapshot, raw: unknown, invocation: BrokerInvocation, policy: CheckPolicy): { operation: ActionOperation | null; reasons: string[] } {
  const parsed = operationSchema.safeParse(raw)
  if (!parsed.success) return { operation: null, reasons: ['Operation outside typed broker scope; Admin Merge is disabled'] }
  const operation = parsed.data, kind = operation.kind, reasons = validateTarget(installed, captured, live, invocation)
  if (!installed.manifest.capabilities.includes(kind) || !installed.grant.capabilities.includes(kind)) reasons.push(`Missing installed capability ${kind}`)
  if (kind.startsWith('repair.') || kind === 'merge.admin') {
    if (live.repository !== 'fortresspower/cmsandbox') reasons.push('Write proposals are cmsandbox only')
    if (live.state !== 'open' || live.draft) reasons.push('Selected real PR must be open and ready')
    if ('expectedHead' in operation && operation.expectedHead !== captured.head) reasons.push('Expected HEAD mismatch')
    if (!live.pathsComplete) reasons.push('Complete changed paths required')
  }
  if (kind.startsWith('repair.')) {
    if (live.headRepository !== live.repository || live.headRef === 'main' || !live.headRef || live.headRef.startsWith('refs/') || live.headRef.startsWith('release/') || live.protectedHead) reasons.push('Repair requires the selected unprotected same-repository head; never main, protected release refs, tags or forks')
    if ('ref' in operation && operation.ref !== `refs/heads/${live.headRef}`) reasons.push('Repair ref differs from selected PR head')
    if (kind === 'repair.patch') reasons.push('Patch held: independent semantic repair review and targeted test/worker dispatch contract unavailable; no branch-writing worker dispatched')
    if (kind === 'repair.rerun') {
      const job = invocation.job
      if (!job || job.id !== operation.jobId || job.runId !== operation.runId || job.head !== captured.head || job.status !== 'completed' || job.conclusion !== 'failure' || job.runAttempt !== 1 || job.dependentJobs === null || job.dependentJobs.length !== 0) reasons.push('One failed job on selected head/run at first attempt with proven zero dependent jobs required; GitHub rerun also restarts dependent jobs')
    }
  }
  if (kind === 'merge.admin') {
    reasons.push('Admin Merge is globally disabled; no live Merge adapter exists')
    if (live.base !== 'main') reasons.push('Admin Merge targets main only')
    if (live.pendingMerge !== false) reasons.push('Pending or ambiguous merge state')
    if (live.threadsResolved !== true) reasons.push('Resolved review threads must be proven')
    if (!live.rulesVerified) reasons.push('Current rule scope and unbypassed sibling requirements must be verified')
    reasons.push(...validateChecks(live, policy))
  }
  return { operation, reasons: [...new Set(reasons)] }
}
export function simulatedRequest(snapshot: ActionSnapshot, operation: ActionOperation): ActionReceipt['providerRequest'] {
  const prefix = `/repos/${snapshot.repository}`
  switch (operation.kind) {
    case 'merge.admin': return { method: 'PUT', path: `${prefix}/pulls/${snapshot.number}/merge`, body: { merge_method: 'squash', sha: operation.expectedHead }, ruleScope: { id: 6108448, mode: 'pull_request' } }
    case 'repair.update': return { method: 'PUT', path: `${prefix}/pulls/${snapshot.number}/update-branch`, body: { expected_head_sha: operation.expectedHead } }
    case 'repair.rerun': return { method: 'POST', path: `${prefix}/actions/jobs/${operation.jobId}/rerun`, body: {} }
    default: return null
  }
}
/** The only write adapter shipped. It has no provider client and cannot mutate GitHub. */
export class SimulatedWriteAdapter {
  perform(snapshot: ActionSnapshot, operation: ActionOperation) {
    return { providerRequest: simulatedRequest(snapshot, operation), actualGitHubWrites: 0 as const, resultingSha: null,
      verification: 'not-performed' as const, result: `SIMULATED: would perform ${operation.kind}. No GitHub writes, repair, merge or deployment verified.` }
  }
}
/** Acknowledgment/enqueue is not a merge. A future adapter must independently read
 * the PR and resulting commit before recording a final SHA; this is fixture-tested. */
export function verifyFinalSquash(expected: { head: string; base: string }, response: { merged: boolean; sha: string | null }, observed: { merged: boolean; head: string; base: string; mergeSha: string | null; commitSha: string | null; parents: string[] }) {
  return expected.base === 'main' && response.merged === true && observed.merged === true && observed.head === expected.head && observed.base === expected.base && !!response.sha && /^[a-f0-9]{40,64}$/.test(response.sha) && response.sha === observed.mergeSha && observed.mergeSha === observed.commitSha && observed.parents.length === 1
}
