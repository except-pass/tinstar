import { z } from 'zod'
import type { ReleaseChange, ReleaseObject } from './releaseObjects'

const text = z.string().trim().min(1)
export const acceptanceContractSchema = z.object({
  notes: z.object({
    audience: z.enum(['internal', 'customer']), internal: text.optional(), customer: text.optional(),
  }).strict().optional(),
  checks: z.array(z.object({
    id: text, successCondition: text, method: z.enum(['workflow', 'human', 'observation']),
    ref: text, owner: text.optional(), fixture: text.optional(),
  }).strict()).min(1).max(30),
}).strict().superRefine(({ checks }, context) => {
  if (new Set(checks.map(check => check.id)).size !== checks.length) context.addIssue({ code: 'custom', message: 'Check IDs must be unique' })
  if (checks.some(check => check.method !== 'workflow' && !check.owner)) context.addIssue({ code: 'custom', message: 'Human and observation checks need a named owner' })
})
export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>
export type AcceptanceCheck = AcceptanceContract['checks'][number]
export type AcceptanceOutcome = 'missing' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'skipped'
export interface AcceptanceEvent {
  dispatched?: boolean
  at: string; actor: string; outcome: AcceptanceOutcome; reason: string
  evidence: string | null; runId: number | null; runUrl: string | null
}
/** Execution evidence only, in the existing workflow receipt store; never a release ledger. */
export interface AcceptanceRecord {
  key: string; releaseId: string; changeId: string; checkId: string
  events: AcceptanceEvent[]
}
export interface AcceptanceResult extends AcceptanceCheck {
  key: string; outcome: AcceptanceOutcome; record: AcceptanceRecord | null
}
export function readAcceptanceContract(value: unknown): { contract: AcceptanceContract | null; gap: string | null } {
  if (value == null || value === '') return { contract: null, gap: 'No acceptance contract defined' }
  try {
    const result = acceptanceContractSchema.safeParse(typeof value === 'string' ? JSON.parse(value) : value)
    return result.success ? { contract: result.data, gap: null } : { contract: null, gap: 'Production acceptance contract is invalid; supply unique checks, success conditions, methods, references and named reviewers.' }
  } catch { return { contract: null, gap: 'Production acceptance contract is invalid JSON.' } }
}
/** A tagged section in the existing Evidence rich text avoids a new board property. */
export function cardAcceptanceContract(value: unknown) {
  const section = typeof value === 'string' ? /```production-acceptance\s*\n([\s\S]*?)```/.exec(value)?.[1] : null
  return readAcceptanceContract(section ?? null)
}
/** Compare meaning: exact attempt, required merge identities, target receipts and
 * assertion. Formatting, timestamps and source ordering do not invalidate proof. */
export interface AcceptanceWorkflow {
  repository: string; workflow: string; ref: string; inputs: Record<string, string>
}
export function acceptanceExecution(release: ReleaseObject, change: ReleaseChange, check: AcceptanceCheck, workflows: Record<string, AcceptanceWorkflow> = {}) {
  const approved = workflows[check.ref]
  if (check.method !== 'workflow' || !approved || approved.repository.toLowerCase() !== release.repository.toLowerCase()) return null
  const values: Record<string, string> = { releaseId: release.id, fixture: check.fixture ?? '', sourceSha: release.sourceSha ?? '',
    receiptIds: change.targets.map(target => target.receipt?.id ?? '').sort().join(','),
    targets: change.targets.map(target => `${target.component}:${target.target}`).sort().join(',') }
  return { repository: approved.repository.toLowerCase(), workflow: approved.workflow, ref: approved.ref,
    inputs: Object.fromEntries(Object.entries(approved.inputs).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.replace(/\{(releaseId|fixture|sourceSha|receiptIds|targets)\}/g, (_, name: string) => values[name]!)])) }
}
export function acceptanceKey(release: ReleaseObject, change: ReleaseChange, check: AcceptanceCheck, workflows?: Record<string, AcceptanceWorkflow>): string {
  return 'release-acceptance:' + JSON.stringify({ release: release.id, change: change.id,
    check: [check.id, check.successCondition, check.method, check.ref, check.owner ?? null, check.fixture ?? null],
    execution: acceptanceExecution(release, change, check, workflows),
    pulls: change.requiredPulls.slice().sort().map(url => [url, change.pulls.find(pull => pull.url === url)?.mergeSha ?? null]),
    targets: change.targets.map(target => [target.component, target.target, target.receipt?.id ?? null, target.receipt?.deployedSha ?? null, target.receipt?.artifactDigest ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })
}
export function acceptanceState(checks: AcceptanceResult[], deployed: boolean): ReleaseChange['acceptance'] {
  if (!deployed || !checks.length) return 'Unknown'
  if (checks.some(check => check.outcome === 'failed')) return 'Failed'
  if (checks.every(check => check.outcome === 'passed')) return 'Passed'
  if (checks.some(check => check.outcome === 'running')) return 'Running'
  if (checks.some(check => check.outcome === 'inconclusive')) return 'Inconclusive'
  if (checks.some(check => check.outcome === 'skipped')) return 'Skipped'
  return checks.some(check => check.method !== 'workflow') ? 'Human review' : 'Missing'
}
