import type { ActionReceipt } from '../../shared/actions'
import type { AskContext, AskField, AskView, ArtifactAskTarget } from '../../shared/ask'
import { pullSource } from '../../shared/ask'
import type { PullSummary, PullsRead } from '../../shared/pulls'
import type { ReleasesRead } from '../../shared/releases'
import { AskNotFound } from './store'

export interface AskArtifactSources { actionReceipt?: (id: string) => Promise<ActionReceipt | undefined>; pulls: () => Promise<PullsRead>; releases: () => Promise<ReleasesRead>; pullOrigin?: (url: string) => Promise<PullSummary>; pullRelationships?: (id: string) => Promise<AskContext['relationships']> }
/** Only records in the existing authorized projections may become Ask origins.
 * Captured field text and head are hints; the source observation is server-owned. */
export async function artifactContext(target: ArtifactAskTarget, view: AskView, fields: { field_key?: AskField; field_value?: string }, sources: AskArtifactSources): Promise<AskContext> {
  const identity = pullSource(target.id)
  if (!identity) throw new AskNotFound('Artifact identity unavailable')
  const release = target.kind !== 'pull' || view.scene === 'releases' ? (await sources.releases()).pulls.find(pull => pull.id === target.id) : undefined
  const pull = target.kind === 'pull' && !release ? ((await sources.pulls()).pulls.find(pull => pull.id === target.id) ?? await sources.pullOrigin?.(identity.url)) : undefined
  const observed = release ?? pull
  if (!observed) throw new AskNotFound('Artifact unavailable in the authorized source')
  const actionReceipt = target.kind === 'pull' && target.action_receipt_id ? await sources.actionReceipt?.(target.action_receipt_id) : undefined
  if (target.kind === 'pull' && target.action_receipt_id && (!actionReceipt || actionReceipt.captured.url !== identity.url)) throw new AskNotFound('Action receipt unavailable for this PR')
  const deployment = target.kind !== 'pull' ? release?.deployment?.targets.find(row => row.target === target.target && row.component === target.component) : undefined
  if (target.kind !== 'pull' && !deployment) throw new AskNotFound('Deployment target unavailable in the authorized source')
  const receipt = deployment?.receipt
  if (target.kind === 'receipt' && (!receipt || receipt.id !== target.receipt_id)) throw new AskNotFound('Receipt unavailable or superseded in the authorized source')
  const section = target.kind === 'pull' && view.scene !== 'releases' ? 'pulls' : 'releases'
  const label = `${identity.repository}#${identity.number}${target.kind !== 'pull' ? ` · ${target.component} / ${target.target}` : ''}${target.kind === 'receipt' ? ` · receipt ${target.receipt_id}` : observed.title ? ` · ${observed.title}` : ''}`
  return {
    schema_version: 2, target, view, ...fields,
    ...(actionReceipt ? { action_receipt: { id: actionReceipt.id, action: actionReceipt.actionId, version: actionReceipt.version, digest: actionReceipt.digest, actor: actionReceipt.actor, outcome: actionReceipt.outcome, intended_effect: actionReceipt.intendedEffect, result: actionReceipt.result, reasons: actionReceipt.reasons, actual_github_writes: 0 as const } } : {}),
    ...(target.kind === 'pull' && sources.pullRelationships ? { relationships: await sources.pullRelationships(target.id) } : {}),
    anchor: { kind: target.kind, page_id: target.id, label: label.slice(0, 512), url: target.kind === 'receipt' ? receipt!.receiptUrl : identity.url,
      observed_at: observed.observedAt, freshness: observed.freshness, expires_at: null },
    return_to: { section, target, view },
    source: { kind: target.kind === 'pull' ? 'github' : 'deployment', repository: identity.repository, number: identity.number,
      head: observed.head ?? null, merge_sha: release?.mergeSha, observed_at: observed.observedAt,
      ...(target.kind !== 'pull' ? { target: target.target, component: target.component } : {}),
      ...(receipt ? { receipt_id: receipt.id, receipt_url: receipt.receiptUrl, workflow_url: receipt.workflowUrl, deployed_sha: receipt.deployedSha } : {}),
    },
  }
}
