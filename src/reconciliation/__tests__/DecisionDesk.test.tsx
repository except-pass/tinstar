import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Decisions } from '../Decisions'
import { preparedDecisionFixture } from '../../../test-fixtures/reconciliation/preparedDecision'
import type { DeskPacket, DeskSubmit } from '../decisionDeskClient'
const workspace = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => workspace.value }))
vi.mock('../DecisionSourceContext', () => ({ DecisionSourceContext: () => <p>Canonical source context</p>, DecisionCardContext: () => <p>Canonical source evidence</p> }))
let leaseToken: string
let packet: DeskPacket, outcome: string, submits: DeskSubmit[], policy: { version: number; values: { target_ready: number; max_preparers: number; automatic_replenishment: boolean } }
beforeEach(() => {
  workspace.value = {}
  sessionStorage.clear(); submits = []; outcome = 'not-saved'; leaseToken = 'secret-lease'
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const fixture = preparedDecisionFixture()
  packet = { id: '00000000-0000-4000-8000-000000000001', version: 1, content_hash: 'fixture', prepared_by: 'Test preparer', published_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), packet: fixture.packet, validation: { valid: true, reasons: [], valid_until: new Date(Date.now() + 60_000).toISOString() }, ready: false, reasons: [] }
  policy = { version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: true } }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = String(url).split('/').pop()!, body = init?.body ? JSON.parse(String(init.body)) : null
    let data: unknown
    if (path === 'sessions') data = body ? { session: { id: 'actual-session' }, review_session_token: 'secret-session' } : { sessions: [{ id: 'actual-session', label: 'Browser review', device: 'desktop', held: null }] }
    else if (path === 'submission-state') data = { submissions: [] }
    else if (path === 'claim') data = { outcome: 'held', packet, lease_token: leaseToken, lease: { card_id: packet.packet.binding.card_id, generation: 1, holder: 'Browser review', expires_at: new Date(Date.now() + 60_000).toISOString() } }
    else if (path === 'snapshot') data = { counts: { ready: null, leased: 1, preparing: 0, requests: 1 }, coverage: 'unknown', omissions: ['Fixture source coverage is partial'], runner: { configured: false, explanation: 'No preparation runner is configured.' }, ready: [], recorded_requests: [], pending: [] }
    else if (path === 'policy') { if (body) policy = { version: policy.version + 1, values: body.values }; data = policy }
    else if (path === 'metrics') data = { reviewed_today_utc: 0, scope: 'test', recording_started_at: new Date().toISOString() }
    else if (path === 'submit') { submits.push(body); data = { outcome, selection: body, message: outcome, operation_id: body.operation_id, ...(outcome === 'recorded-empty' ? { next: { outcome: 'no-prepared-decisions' } } : {}) } }
    else throw new Error(`Unexpected request ${path}`)
    return new Response(JSON.stringify({ ok: true, data }))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function ready() { render(<Decisions />); await screen.findByRole('radio', { name: /Authorize preview only/ }) }
it('requires deliberate selection, suppresses double submits and retries the same exact operation without advancing or exposing tokens', async () => {
  await ready()
  const submit = screen.getByRole('button', { name: 'Submit decision & next →' })
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(submit); fireEvent.click(submit)
  await screen.findByText('Answer was not saved. Your selection is retained. Retry without advancing.')
  expect(submits).toHaveLength(1)
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await waitFor(() => expect(submits).toHaveLength(2))
  expect(submits[1]).toEqual(submits[0])
  expect(document.body.textContent).not.toMatch(/secret-session|secret-lease/)
})
it('distinguishes an unconfirmed save and retains its operation through a reload, clearing the old card only on durable success', async () => {
  outcome = 'save-unconfirmed'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ })); fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Confirm save status' })
  const first = submits[0]
  cleanup(); await ready()
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await screen.findByText('No prepared decisions ready.')
  expect(submits[1]).toEqual(first)
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.getAllByText(/Decision recorded. Recorded; awaiting worker acknowledgment/).some(element => element.classList.contains('dd-notice'))).toBe(true)
})
it('shows explicit scoped high-risk confirmation; cancel retains the selected answer and confirmation is required before writing', async () => {
  packet.packet.risk.rating = 'High'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ })); fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  const modal = screen.getByRole('dialog')
  expect(within(modal).getByText(/Preview research only/)).toBeVisible()
  expect(within(modal).getByText(/No customer or device effects/)).toBeVisible()
  expect(submits).toHaveLength(0)
  fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm & submit decision' }))
  await waitFor(() => expect(submits).toHaveLength(1))
  expect(submits[0]?.confirmation).toEqual({ option_id: 'preview', scope: packet.packet.authorization.scope })
})
it('blocks invalidated packet submission and renders Markdown without executable raw HTML', async () => {
  packet.validation.valid = false; packet.packet.background = '<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(1))'
  await ready()
  expect(screen.getByText('Packet invalidated — source revision changed. Refresh research before deciding.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Submit decision & next →' })).toBeDisabled()
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
})
it('shows unavailable metrics honestly and persists effective policy through the backend', async () => {
  await ready(); expect(screen.getByText('— / unavailable / 10')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Preparation' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Target ready depth' }), { target: { value: '16' } })
  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole('slider', { name: 'Target ready depth' })).toHaveValue('16')
  fireEvent.click(screen.getByRole('switch'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save queue policy' })))
  expect(policy.values).toEqual({ target_ready: 16, max_preparers: 3, automatic_replenishment: false })
  await screen.findByText('Queue policy saved. No preparation runner is configured.')
})

it('blocks a lost lease, preserves the selection and reclaims before retrying the original source operation', async () => {
  outcome = 'lease-lost'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByText('Lease expired or lost. Re-claim and revalidate before writing. Your selection is retained.')
  expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveClass('dd-danger')
  leaseToken = 'replacement-capability'
  fireEvent.click(screen.getByRole('button', { name: 'Re-claim & revalidate' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await waitFor(() => expect(submits).toHaveLength(2))
  expect(submits[1]).toMatchObject({ operation_id: submits[0]!.operation_id, option_id: 'preview', lease_token: 'replacement-capability', original_lease_token: 'secret-lease' })
})
it('reviews one independently identified source request and never invents a multipart group', async () => {
  await ready()
  expect(screen.getAllByRole('group', { name: 'Choose one source option' })).toHaveLength(1)
  expect(screen.queryByText(/Submit A\/B/)).toBeNull()
  expect(screen.getByText('Request preview-question', { selector: '.dd-choices .dd-caption' })).toBeVisible()
})

it('reconciles an ambiguous original operation after reload even when its own partial source effects invalidate the displayed packet', async () => {
  outcome = 'save-unconfirmed'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Confirm save status' })
  const first = submits[0]!
  cleanup(); packet.validation.valid = false
  await ready()
  expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeDisabled()
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('button', { name: 'Confirm retained save status' }))
  await screen.findByText('No prepared decisions ready.')
  expect(submits[1]).toEqual(first)
})

it('waits for an exact source-return binding instead of claiming a substitute from an older scene selection', async () => {
  workspace.value = { origin: { section: 'decisions', target: { kind: 'decision', id: 'exact-return' } }, state: { selection: { kind: 'card', id: 'another-card' } } }
  const view = render(<Decisions />)
  await screen.findByText('Requested source request is not ready for review.')
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/claim'))).toHaveLength(0)
  workspace.value = { ...workspace.value, queue: { items: [{ id: 'exact-return', cardIds: [packet.packet.binding.card_id] }] } }
  view.rerender(<Decisions />)
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  const claim = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/claim'))!
  expect(JSON.parse(String(claim[1]?.body)).card_id).toBe(packet.packet.binding.card_id)
})
