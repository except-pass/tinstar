import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReleaseAutomationPlan } from '../../shared/releaseAutomation'
import { CardReleaseProposal, ReleaseAutomationSummary } from '../ReleaseAutomation'

afterEach(cleanup)
const plan = (): ReleaseAutomationPlan => ({ mode: 'review-only', enabled: false, requestedEnabled: false, configuration: 'default', warnings: ['Parent approval and policy rollout required.'], held: [], proposals: [] })
describe('release automation review UI', () => {
  it('shows OFF and read-only inspection rather than activation or completion controls', () => {
    const data = plan()
    render(<ReleaseAutomationSummary plan={data} />)
    expect(screen.getByText('Automatic transitions OFF · review only')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Inspect transition and Desk drafts ↗' })).toHaveAttribute('href', '/api/releases/automation')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('0 proposed completions · 0 proposed owner checks · 0 held cards')).toBeTruthy()
  })
  it('makes a requested but unavailable enablement visible and retains OFF', () => {
    const data = { ...plan(), requestedEnabled: true }
    render(<ReleaseAutomationSummary plan={data} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Enablement requested but blocked')
    expect(screen.getByText('Automatic transitions OFF · review only')).toBeTruthy()
  })
  it('discloses owner verification, release evidence and proposal identity without publishing the draft', () => {
    const data = plan()
    data.proposals.push({ id: 'stable-release-bound-id', cardId: 'card', owner: 'Ada', from: 'Waiting for Prod Release', to: 'In Progress', kind: 'verify-in-production', requiredPulls: ['https://github.com/owner/repo/pull/1'], evidence: [], auditText: 'api-prod v1, source bbbb, workflow https://github.com/owner/repo/actions/runs/1', desk: { owner: 'Ada', item: { id: 'draft', title: 'Verify in production', kind: 'decision', action: 'Record the explicit production check.', readiness: 'future-or-conditional', reasons: [], cardIds: ['card'], executionIds: [], homeIds: [], decisionKeys: [], evidence: [], sources: [], checkpoint: null, oneTouch: false } } })
    render(<CardReleaseProposal plan={data} cardId="card" />)
    fireEvent.click(screen.getByText('Proposed In Progress · verification for Ada · OFF'))
    expect(screen.getByText(/Desk draft for Ada/)).toHaveTextContent('has not been published to Your Desk')
    expect(screen.getByText(/source bbbb/)).toBeTruthy()
    expect(screen.getByText('Proposal ID: stable-release-bound-id')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('explains why a card cannot be routed when its owner or evidence is unresolved', () => {
    const data = plan(); data.held.push({ cardId: 'card', reasons: ['Assign the responsible owner before routing'] })
    render(<CardReleaseProposal plan={data} cardId="card" />)
    fireEvent.click(screen.getByText('Transition held · OFF'))
    expect(screen.getByText('Assign the responsible owner before routing')).toBeTruthy()
  })
})
