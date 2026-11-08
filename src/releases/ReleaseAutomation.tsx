import { apiUrl } from '../apiClient'
import type { ReleaseAutomationPlan } from '../shared/releaseAutomation'

export function ReleaseAutomationSummary({ plan }: { plan?: ReleaseAutomationPlan }) {
  if (!plan) return null
  return <div className="rel-dry-run" aria-label="Release automation rollout">
    <strong>Automatic transitions OFF · review only</strong>
    {plan.requestedEnabled && <p role="alert">Enablement requested but blocked in this build.</p>}
    {plan.warnings.map(warning => <p key={warning}>{warning}</p>)}
    <p>{plan.proposals.filter(proposal => proposal.kind === 'complete').length} proposed completions · {plan.proposals.filter(proposal => proposal.kind === 'verify-in-production').length} proposed owner checks · {plan.held.length} held cards</p>
    <a href={apiUrl('/api/releases/automation')} target="_blank" rel="noreferrer">Inspect transition and Desk drafts ↗</a>
  </div>
}

export function CardReleaseProposal({ plan, cardId }: { plan?: ReleaseAutomationPlan; cardId: string }) {
  const proposal = plan?.proposals.find(proposal => proposal.cardId === cardId)
  const held = plan?.held.find(card => card.cardId === cardId)
  if (!proposal) return held ? <details className="rel-dry-run"><summary>Transition held · OFF</summary><ul>{held.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details> : null
  return <details className="rel-dry-run">
    <summary>Proposed {proposal.to}{proposal.desk ? ` · verification for ${proposal.desk.owner}` : ''} · OFF</summary>
    <p>{proposal.from} → {proposal.to}. No transition is executed.</p>
    {proposal.desk && <p>Desk draft for {proposal.desk.owner}: {proposal.desk.item.action} This draft has not been published to Your Desk.</p>}
    <p className="rel-evidence-text">{proposal.auditText}</p>
    <small>Proposal ID: {proposal.id}</small>
  </details>
}
