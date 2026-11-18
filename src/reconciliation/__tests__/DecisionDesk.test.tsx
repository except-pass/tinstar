// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DecisionDesk } from '../DecisionDesk'
import { fixtureId } from '../../../test-fixtures/reconciliation/scenes'
import { preparedDecisionFixture } from '../../../test-fixtures/reconciliation/preparedDecision'

const workspace = vi.hoisted(() => ({ target: undefined as { id: string; cardId: string } | undefined }))
vi.mock('../../ask/DeskWorkspace', () => ({
  useDeskWorkspace: () => ({ decisionTarget: workspace.target, consumeDecisionTarget: () => {} }),
}))

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
  workspace.target = undefined
})

it('sends exact answer text and the option ID using the held card lease, then shows the next card', async () => {
  const firstCard = fixtureId(1), nextCard = fixtureId(2)
  const claimed = (card: string) => ({ packet: { id: card, packet: { ...preparedDecisionFixture(card).packet, title: `Card ${card}` } },
    outcome: 'claimed', lease: { card_id: card }, lease_token: `lease-${card}` })
  const submissions: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('/').at(-1)
    const input = init?.body ? JSON.parse(String(init.body)) : null
    let data: unknown
    if (path === 'sessions') data = { review_session_token: 'session' }
    if (path === 'claim') data = claimed(firstCard)
    if (path === 'snapshot') data = { ready: [], counts: { ready: 1 }, omissions: [] }
    if (path === 'submit') {
      submissions.push(input)
      data = submissions.length === 1 ? { outcome: 'save-unconfirmed', message: 'Retry the save' } :
        { outcome: 'recorded', message: 'Decision recorded on the card.', next: claimed(nextCard) }
    }
    return Response.json({ ok: true, data })
  }))
  render(<DecisionDesk />)
  fireEvent.click(await screen.findByRole('radio', { name: /Authorize preview only/ }))
  const answer = '  Proceed only on the fixture.\nKeep the other card open.  '
  fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: answer } })
  fireEvent.click(screen.getByRole('button', { name: 'Record answer & next' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry save' }))
  await screen.findByRole('heading', { name: `Card ${nextCard}` })
  expect(submissions).toEqual([{
    operation_id: expect.any(String), review_session_token: 'session', lease_token: `lease-${firstCard}`, option_id: '1', answer,
  }, submissions[0]])
})

it('keeps an unavailable targeted claim scoped to that card until the reviewer picks next', async () => {
  const card = fixtureId(3)
  workspace.target = { id: 'target', cardId: card }
  const claims: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let data: unknown = { ready: [], omissions: [] }
    if (url.endsWith('/sessions')) data = { review_session_token: 'session' }
    if (url.endsWith('/claim')) {
      claims.push(JSON.parse(String(init?.body)))
      data = { outcome: 'no-prepared-decisions', message: 'No prepared, unleased card is ready.' }
    }
    return Response.json({ ok: true, data })
  }))
  render(<DecisionDesk />)
  await screen.findByText('No prepared, unleased card is ready.')
  expect(claims).toEqual([expect.objectContaining({ card_id: card })])
  fireEvent.click(screen.getByRole('button', { name: 'Claim next prepared decision' }))
  await waitFor(() => expect(claims).toHaveLength(2))
  expect(claims[1]).not.toHaveProperty('card_id')
})
