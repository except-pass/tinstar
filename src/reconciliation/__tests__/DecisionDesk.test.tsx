import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DecisionDesk as Decisions } from '../DecisionDesk'
import { AskProvider } from '../../ask/Ask'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { initialPresentation } from '../presentation'
import { workflowMarkers } from '../../shared/workflowMarkers'
import { preparedDecisionFixture } from '../../../test-fixtures/reconciliation/preparedDecision'
import type { DeskPacket, DeskSubmit } from '../decisionDeskClient'
const workspace = vi.hoisted(() => ({ value: {} as Record<string, unknown>, consumed: null as string | null }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => ({ ...workspace.value, decisionTarget: (workspace.value.decisionTarget as { id: string } | undefined)?.id === workspace.consumed ? undefined : workspace.value.decisionTarget, consumeDecisionTarget: (target: string) => { workspace.consumed = target } }) }))

let leaseToken: string, claimCode: string | undefined
let packet: DeskPacket, outcome: string, submits: DeskSubmit[], policy: { version: number; values: { target_ready: number; max_preparers: number; automatic_replenishment: boolean } }
beforeEach(() => {
  workspace.consumed = null
  workspace.value = {}
  sessionStorage.clear(); submits = []; outcome = 'not-saved'; claimCode = undefined; leaseToken = 'secret-lease'
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const fixture = preparedDecisionFixture()
  packet = { id: '00000000-0000-4000-8000-000000000001', version: 1, content_hash: 'fixture', prepared_by: 'Test preparer', published_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), packet: fixture.packet, validation: { valid: true, reasons: [], valid_until: new Date(Date.now() + 60_000).toISOString() }, ready: false, reasons: [] }
  policy = { version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: false } }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = String(url).split('/').pop()!, body = init?.body ? JSON.parse(String(init.body)) : null
    let data: unknown
    if (String(url).includes('/card-context?')) data = { blocks: [{ id: 'source', text: 'Exact supporting evidence' }] }
    else if (path === 'sessions') data = body ? { session: { id: 'actual-session' }, review_session_token: 'secret-session' } : { sessions: [{ id: 'actual-session', expires_at: new Date(Date.now() + 86400000).toISOString(), label: 'Browser review', device: 'desktop', held: null }] }
    else if (path.startsWith('packet?id=')) data = packet
    else if (path === 'submission-state') data = { submissions: [] }
    else if (path === 'claim') data = claimCode ? { outcome: 'not-saved', code: claimCode, message: 'This exact card is held by another context' } : { outcome: 'held', packet, lease_token: leaseToken, lease: { card_id: packet.packet.binding.card_id, generation: 1, holder: 'Browser review', expires_at: new Date(Date.now() + 60_000).toISOString() } }
    else if (path === 'snapshot') data = { counts: { ready: null, leased: 1, preparing: 0, requests: 1 }, coverage: 'unknown', omissions: ['Fixture source coverage is partial'], runner: { configured: false, preparer: 'Tinstar Decision Prep', explanation: 'The preparer webhook is not configured.' }, ready: [], recorded_requests: [], pending: [] }
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
  await ready(); expect(screen.getByText('— / unavailable')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Preparation' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Target ready depth' }), { target: { value: '16' } })
  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole('slider', { name: 'Target ready depth' })).toHaveValue('16')
  fireEvent.click(screen.getByRole('switch'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save queue policy' })))
  expect(policy.values).toEqual({ target_ready: 16, max_preparers: 3, automatic_replenishment: true })
  await screen.findByText('Queue policy saved. The preparer webhook is not configured.')
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

it('consumes an unavailable source binding without claiming a substitute, and only retries it explicitly', async () => {
  packet.packet.binding.request_key = 'exact-return'
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: 'exact-return' }, origin: { section: 'decisions', target: { kind: 'decision', id: 'exact-return' } }, state: { selection: { kind: 'card', id: 'another-card' } } }
  const view = render(<Decisions />)
  await screen.findByText('Requested source request is not ready for review.')
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/claim'))).toHaveLength(0)
  workspace.value = { ...workspace.value, queue: { items: [{ id: 'exact-return', cardIds: [packet.packet.binding.card_id] }] } }
  view.rerender(<Decisions />)
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/claim'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Try this decision again' }))
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  const claim = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/claim'))!
  expect(JSON.parse(String(claim[1]?.body)).card_id).toBe(packet.packet.binding.card_id)
})

it('offers one-click research refresh when source revision changes during submit, without an ambiguous-save control', async () => {
  outcome = 'packet-invalidated'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Refresh packet & next' })
  expect(screen.queryByRole('button', { name: 'Confirm retained save status' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
})

it('blocks a remotely lost claim and can explicitly claim next without releasing another session’s lease', async () => {
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  claimCode = 'card-held'
  await act(async () => { fireEvent.focus(window) })
  await screen.findByText('Lease expired or lost. Re-claim and revalidate before writing. Your selection is retained.')
  expect(screen.queryByText('Leased to this session')).toBeNull()
  expect(screen.getByRole('button', { name: 'Submit decision & next →' })).toBeDisabled()
  claimCode = undefined; packet = { ...packet, packet: { ...packet.packet, binding: { ...packet.packet.binding, card_id: 'b'.repeat(32) } } }
  fireEvent.click(screen.getByRole('button', { name: 'Claim next prepared decision' }))
  await waitFor(() => expect(document.querySelector('.dd-identifiers')).toHaveAttribute('data-semantic-id', `card:${'b'.repeat(32)}`))
  const calls = vi.mocked(fetch).mock.calls
  const input = JSON.parse(String(calls.filter(([url]) => String(url).endsWith('/claim')).at(-1)![1]?.body))
  expect(input).not.toHaveProperty('card_id')
  expect(input).not.toHaveProperty('lease_token')
  expect(calls.some(([url]) => String(url).endsWith('/release'))).toBe(false)
})

it('does not resurrect an abandoned invalidated answer into a newly prepared source revision after reload', async () => {
  outcome = 'packet-invalidated'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Refresh packet & next' })
  const first = submits[0]!, oldPacket = structuredClone(packet)
  cleanup()
  packet = { ...packet, id: '00000000-0000-4000-8000-000000000002', version: 2, packet: { ...packet.packet, binding: { ...packet.packet.binding, source_revision: 'new-semantic-source-revision' } } }
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith('/submission-state')
    ? new Response(JSON.stringify({ ok: true, data: { submissions: [{ operation_id: first.operation_id, selection: { packet_id: first.packet_id, packet_version: first.packet_version, request_id: first.request_id, option_id: first.option_id }, state: 'packet-invalidated', next: first.next }] } }))
    : String(url).includes('/packet?id=') ? new Response(JSON.stringify({ ok: true, data: oldPacket })) : fallback(url, init))
  await ready()
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Submit decision & next →' })).toBeDisabled()
  outcome = 'not-saved'
  fireEvent.click(screen.getByRole('radio', { name: 'Defer research' }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await waitFor(() => expect(submits).toHaveLength(2))
  expect(submits[1]!.operation_id).not.toBe(first.operation_id)
  expect(submits[1]).toMatchObject({ packet_id: packet.id, packet_version: 2, option_id: 'defer' })
})

it('renews an expired session on mobile while retaining a selected answer', async () => {
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  const fallback = vi.mocked(fetch).getMockImplementation()!
  let renewed = false
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/sessions')) {
      if (init?.method === 'GET') return new Response(JSON.stringify({ ok: true, data: { sessions: [] } }))
      renewed = true
    }
    return fallback(url, init)
  })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
  await act(async () => { fireEvent.focus(window) })
  await waitFor(() => expect(renewed).toBe(true))
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/claim'))
  expect(JSON.parse(String(calls.at(-1)![1]?.body))).not.toHaveProperty('lease_token')
})

it('recovers an ambiguous operation through an expired session without changing its write capability or ID', async () => {
  outcome = 'save-unconfirmed'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Confirm save status' })
  const original = submits[0]!
  cleanup()
  const fallback = vi.mocked(fetch).getMockImplementation()!
  let recovery: Record<string, unknown> | undefined
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/sessions') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, data: { sessions: [] } }))
    if (String(url).endsWith('/submission-state')) recovery = JSON.parse(String(init?.body))
    return fallback(url, init)
  })
  await ready()
  await waitFor(() => expect(recovery).toMatchObject({ original_lease_token: 'secret-lease' }))
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await screen.findByText('No prepared decisions ready.')
  expect(submits[1]).toEqual(original)
})

it('refreshes reviewed metrics after consecutive successes with identical notices', async () => {
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/metrics')) return new Response(JSON.stringify({ ok: true, data: { reviewed_today_utc: submits.length, scope: 'test', recording_started_at: new Date().toISOString() } }))
    if (String(url).endsWith('/submit')) {
      const input = JSON.parse(String(init?.body)); submits.push(input)
      return new Response(JSON.stringify({ ok: true, data: { outcome: 'recorded', operation_id: input.operation_id, selection: input, next: { outcome: 'held', packet, lease_token: leaseToken, lease: { expires_at: new Date(Date.now() + 60000).toISOString() } } } }))
    }
    return fallback(url, init)
  })
  await ready()
  for (let count = 1; count <= 2; count++) {
    fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
    await waitFor(() => expect(screen.getByText('Reviewed today (UTC)', { exact: false })).toHaveTextContent(`Reviewed today (UTC) ${count}`))
  }
})

it('restores the current unresolved packet after successive expiries before attempting an exact claim', async () => {
  await ready()
  const fallback = vi.mocked(fetch).getMockImplementation()!
  let expired = true
  const recoveryTokens: string[] = []
  const claimCards: string[] = []
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (String(url).endsWith('/sessions') && init?.method === 'GET' && expired) return new Response(JSON.stringify({ ok: true, data: { sessions: [] } }))
    if (String(url).endsWith('/submission-state')) recoveryTokens.push(body.original_lease_token)
    if (String(url).endsWith('/claim')) claimCards.push(body.card_id)
    return fallback(url, init)
  })
  await act(async () => { fireEvent.focus(window) })
  await waitFor(() => expect(claimCards.length).toBeGreaterThan(0))
  expired = false
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByText('No prepared decisions ready.')
  cleanup()
  packet = { ...packet, id: '00000000-0000-4000-8000-000000000002', packet: { ...packet.packet, binding: { ...packet.packet.binding, card_id: 'b'.repeat(32), request_id: 'second-request' } } }
  leaseToken = 'session-b-lease'
  await ready()
  outcome = 'save-unconfirmed'
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Confirm save status' })
  const original = submits.at(-1)!
  cleanup(); expired = true; claimCards.length = 0
  await ready()
  await waitFor(() => expect(recoveryTokens.at(-1)).toBe('session-b-lease'))
  await waitFor(() => expect(claimCards).toEqual(['b'.repeat(32)]))
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await screen.findByText('No prepared decisions ready.')
  expect(submits.at(-1)).toEqual(original)
})

it('advances transfer proof through repeated failed transfers of one source operation', async () => {
  outcome = 'lease-lost'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Re-claim & revalidate' })
  const original = submits[0]!
  const fallback = vi.mocked(fetch).getMockImplementation()!
  let bound = original.lease_token
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/sessions') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, data: { sessions: [] } }))
    if (String(url).endsWith('/submission-state')) {
      const body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true, data: { submissions: body.original_lease_token === bound ? [{ operation_id: original.operation_id, selection: original, state: 'lease-lost', next: original.next, binding_matches_original_lease: true }] : [] } }))
    }
    if (String(url).endsWith('/submit')) {
      const input = JSON.parse(String(init?.body))
      if (input.lease_token !== bound) {
        expect(input.original_lease_token).toBe(bound)
        bound = input.lease_token
      }
    }
    return fallback(url, init)
  })
  for (const replacement of ['session-b-lease', 'session-c-lease']) {
    leaseToken = replacement
    fireEvent.click(screen.getByRole('button', { name: 'Re-claim & revalidate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeEnabled())
    outcome = 'not-saved'
    fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
    await screen.findByText('Answer was not saved. Your selection is retained. Retry without advancing.')
    expect(bound).toBe(replacement)
    expect(submits.at(-1)).toMatchObject({ operation_id: original.operation_id, option_id: original.option_id, request_id: original.request_id })
    expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
    outcome = 'lease-lost'
    fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
    await screen.findByRole('button', { name: 'Re-claim & revalidate' })
  }
})

it('submits only exact source option IDs and vocabulary with the bounded next state', async () => {
  packet.packet.binding.options = [{ id: 'r1', label: 'One copy' }, { id: 'r3', label: 'Three copies' }]
  packet.packet.recommended_option_id = 'r1'
  render(<Decisions />)
  fireEvent.click(await screen.findByRole('radio', { name: 'Three copies' }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await waitFor(() => expect(submits).toHaveLength(1))
  expect(submits[0]).toMatchObject({ packet_id: packet.id, packet_version: packet.version, request_id: packet.packet.binding.request_id, option_id: 'r3', next: { owner: 'Firstmate', status: 'Queued' } })
  expect(vi.mocked(fetch).mock.calls.some(([url]) => /dismiss|workflow/.test(String(url)))).toBe(false)
})

it('shows real source evidence read-only, cleans protocol metadata and keeps canonical links', async () => {
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url).includes('/card-context?')
    ? new Response(JSON.stringify({ ok: true, data: { blocks: [{ id: 'source', text: ['Question: Keep one replica or recommend three?', ...Object.values(workflowMarkers).map(marker => `${marker} {"id":"private-request"}`)].join('\n') }] } })) : fallback(url, init))
  workspace.value = { scene: fixtureScene(), send: vi.fn() }
  await ready()
  fireEvent.click(screen.getAllByRole('button', { name: 'Source request & discussion' })[0]!)
  const evidence = await screen.findByText('Question: Keep one replica or recommend three?', { selector: 'p' })
  expect(evidence).toBeVisible()
  expect(evidence).not.toHaveTextContent('private-request')
  const source = document.querySelector('.dd-source-context')! as HTMLElement
  expect(within(source).getByRole('link', { name: /Read Notion card/ })).toHaveAttribute('href', `https://www.notion.so/${packet.packet.binding.card_id}`)
  expect(within(source).queryByText('Answer decision')).toBeNull()
  fireEvent.click(within(source).getByRole('button', { name: 'Open related work' }))
  expect(workspace.value.send).toHaveBeenCalledWith({ type: 'navigate-card', cardId: packet.packet.binding.card_id })
  expect(submits).toHaveLength(0)
})

it.each(['firstmate', 'card-native'])('sends text and voice-capable %s discussion with exact request context without answering', async kind => {
  if (kind === 'card-native') { packet.packet.binding.source_request = null; packet.packet.binding.source_spawn_gen = null }
  const fallback = vi.mocked(fetch).getMockImplementation()!
  const questions: unknown[] = []
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/api/ask/')) {
      if (init?.body) { questions.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: false, error: { message: 'Fixture delivery unavailable' } })) }
      return new Response(JSON.stringify({ ok: true, data: [] }))
    }
    return fallback(url, init)
  })
  const scene = fixtureScene()
  workspace.value = { scene }
  render(<AskProvider scene={scene} state={initialPresentation()} send={vi.fn()} onReturn={vi.fn()}><Decisions /></AskProvider>)
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  fireEvent.click(screen.getAllByRole('button', { name: 'Source request & discussion' })[0]!)
  expect(await screen.findByText('Exact supporting evidence')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Record voice question' })).toBeVisible()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'What evidence supports this choice?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(questions).toHaveLength(1))
  expect(questions[0]).toMatchObject({ target: { kind: 'decision', id: packet.packet.binding.request_key }, view: { scene: 'decisions', request_key: packet.packet.binding.request_key }, question: 'What evidence supports this choice?' })
  expect(submits).toHaveLength(0)
})

it('retains source-delivery receipts and worker replies in Preparation without treating delivery as acceptance', async () => {
  workspace.value = { messages: [{ kind: 'message', requestId: 'receipt', home: 'fixture-home', taskId: 'retired-worker', text: 'Retained source delivery', state: 'saved', announced: true, reply: 'Please verify source evidence' }], workers: [] }
  await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Preparation' }))
  fireEvent.click(screen.getByText('Source delivery details'))
  expect(screen.getByText('Retained source delivery')).toBeVisible()
  expect(screen.getByText('First Mate replied')).toBeVisible()
  expect(screen.getByText('Please verify source evidence')).toBeVisible()
  expect(screen.getByText('Delivery details').closest('details')).not.toHaveAttribute('open')
  expect(submits).toHaveLength(0)
})

it.each(['lost response', 'expired during observation'])('reconciles a transfer after %s, reload and another session transfer', async failure => {
  outcome = 'lease-lost'; await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: 'Re-claim & revalidate' })
  const original = submits[0]!
  let bound = original.lease_token
  let transferred = false
  const claims: string[] = []
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (String(url).endsWith('/sessions') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, data: { sessions: [] } }))
    if (String(url).endsWith('/submission-state')) return new Response(JSON.stringify({ ok: true, data: { submissions: body.original_lease_token === bound ? [{ operation_id: original.operation_id, selection: original, state: 'lease-lost', next: original.next, binding_matches_original_lease: true }] : [] } }))
    if (String(url).endsWith('/claim')) claims.push(body.card_id)
    if (String(url).endsWith('/submit')) {
      expect(body.operation_id).toBe(original.operation_id)
      expect(body.option_id).toBe(original.option_id)
      if (body.lease_token !== bound) {
        expect(body.original_lease_token).toBe(bound)
        bound = body.lease_token
      }
      if (bound === 'session-b-lease' && !transferred) {
        transferred = true
        if (failure === 'lost response') throw new Error('Transfer response lost')
      }
    }
    return fallback(url, init)
  })
  leaseToken = 'session-b-lease'
  fireEvent.click(screen.getByRole('button', { name: 'Re-claim & revalidate' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await waitFor(() => expect(transferred).toBe(true))
  await waitFor(() => expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked())
  await waitFor(() => expect(screen.queryByText('Decision Desk operation in progress.')).toBeNull())
  cleanup(); leaseToken = 'session-c-lease'
  await ready()
  fireEvent.click(await screen.findByRole('button', { name: 'Re-claim & revalidate' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry without advancing' })).toBeEnabled())
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('button', { name: 'Retry without advancing' }))
  await screen.findByText('No prepared decisions ready.')
  expect(bound).toBe('session-c-lease')
  expect(submits.at(-1)).toMatchObject({ operation_id: original.operation_id, option_id: original.option_id, original_lease_token: 'session-b-lease' })
  expect(claims.every(card => card === packet.packet.binding.card_id)).toBe(true)
})

it.each(['first request returned', 'second request returned', 'release unavailable'])('preserves a Discuss return to the second independent request on one card: %s', async scenario => {
  const first = structuredClone(packet)
  first.packet.binding.request_key = 'request-a'
  first.packet.binding.request_id = 'source-a'
  first.packet.title = 'First independent request'
  const second = structuredClone(packet)
  second.id = '00000000-0000-4000-8000-000000000002'
  second.packet.binding.request_key = 'request-b'
  second.packet.binding.request_id = 'source-b'
  second.packet.title = 'Second independent request'
  packet = scenario === 'second request returned' ? second : first
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: 'request-b' }, origin: { section: 'decisions', target: { kind: 'decision', id: 'request-b' } }, queue: { items: [{ id: 'request-a', cardIds: [first.packet.binding.card_id] }, { id: 'request-b', cardIds: [second.packet.binding.card_id] }] } }
  const releases: Record<string, unknown>[] = []
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/release')) {
      releases.push(JSON.parse(String(init?.body)))
      if (scenario === 'release unavailable') throw new Error('Release response unavailable')
      return new Response(JSON.stringify({ ok: true, data: { outcome: 'released' } }))
    }
    if (String(url).endsWith('/claim')) {
      const response = await fallback(url, init)
      const body = await response.json()
      body.data.outcome = 'claimed'
      return new Response(JSON.stringify(body))
    }
    return fallback(url, init)
  })
  render(<Decisions />)
  if (scenario === 'second request returned') {
    await screen.findByRole('heading', { name: second.packet.title })
    expect(screen.getByText('Request source-b', { selector: '.dd-choices .dd-caption' })).toBeVisible()
    expect(releases).toHaveLength(0)
  } else {
    await screen.findByRole('heading', { name: 'Requested source request is not ready for review.' })
    await waitFor(() => expect(releases).toHaveLength(1))
    expect(releases[0]).toMatchObject({ action: 'release', lease_token: 'secret-lease', review_session_token: 'secret-session' })
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('heading', { name: first.packet.title })).toBeNull()
  }
  expect(submits).toHaveLength(0)
})

it.each(['held', 'packet-invalidated'])('retains a same-card %s request and selection when Discuss requests another request', async claimOutcome => {
  packet.packet.binding.request_key = 'request-a'
  const view = render(<Decisions />)
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/claim')) {
      const response = await fallback(url, init)
      const body = await response.json()
      body.data.outcome = claimOutcome
      return new Response(JSON.stringify(body))
    }
    return fallback(url, init)
  })
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: 'request-b' }, origin: { section: 'decisions', target: { kind: 'decision', id: 'request-b' } }, queue: { items: [{ id: 'request-b', cardIds: [packet.packet.binding.card_id] }] } }
  view.rerender(<Decisions />)
  await screen.findByText('This session already holds a different decision. Finish or skip it before switching.')
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  expect(JSON.parse(sessionStorage.getItem('tinstar-decision-review-v1')!).lease).toBe('secret-lease')
  expect(screen.queryByRole('heading', { name: 'Requested source request is not ready for review.' })).toBeNull()
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(0)
  expect(submits).toHaveLength(0)
})

it('retains an already-held decision when a different request is requested', async () => {
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/claim')) return new Response(JSON.stringify({ ok: true, data: { outcome: 'already-holding', packet, lease_token: leaseToken, lease: { card_id: packet.packet.binding.card_id, generation: 1, holder: 'Browser review', expires_at: new Date(Date.now() + 60_000).toISOString() } } }))
    return fallback(url, init)
  })
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: 'other-request' }, origin: { section: 'decisions', target: { kind: 'decision', id: 'other-request' } }, queue: { items: [{ id: 'other-request', cardIds: ['other-card'] }] } }
  // Keep the mounted reviewing context while delivering a new destination.
  fireEvent.click(screen.getByRole('button', { name: 'Preparation' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  await screen.findByText('This session already holds a different decision. Finish or skip it before switching.')
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(0)
  expect(submits).toHaveLength(0)
})

it.each([
  ['submit', 'manual'], ['submit', 'focus'],
  ['skip', 'manual'], ['skip', 'focus'],
  ['research', 'manual'], ['research', 'focus'],
])('consumes explicit navigation after confirmed %s advancement before %s refresh', async (action, refresh) => {
  const first = structuredClone(packet)
  const second = structuredClone(packet)
  second.id = '00000000-0000-4000-8000-000000000002'
  second.packet.binding.card_id = 'b'.repeat(32)
  second.packet.binding.request_key = 'request-b'
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: first.packet.binding.request_key }, origin: { section: 'decisions', target: { kind: 'decision', id: first.packet.binding.request_key } }, queue: { items: [{ id: first.packet.binding.request_key, cardIds: [first.packet.binding.card_id] }] }, state: { revision: 1 } }
  let advanced = false, available = false
  const claims: Record<string, unknown>[] = []
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url).split('/').pop()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    let data: unknown
    if (path === 'claim') {
      claims.push(body)
      data = !advanced ? { outcome: 'held', packet: first, lease_token: 'secret-lease', lease: { card_id: first.packet.binding.card_id, generation: 1, holder: 'Browser review', expires_at: new Date(Date.now() + 60_000).toISOString() } }
        : available && !body.card_id ? { outcome: 'held', packet: second, lease_token: 'second-lease' }
          : { outcome: 'no-prepared-decisions' }
    } else if (path === 'submit') {
      submits.push(body); advanced = true
      data = { outcome: 'recorded-empty', selection: body, operation_id: body.operation_id, next: { outcome: 'no-prepared-decisions' } }
    } else if (path === 'release') {
      expect(body.action).toBe(action); advanced = true
      data = { outcome: 'released', next: { outcome: 'no-prepared-decisions' } }
    } else return fallback(url, init)
    return new Response(JSON.stringify({ ok: true, data }))
  })
  const view = render(<Decisions />)
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  expect(claims[0]).toMatchObject({ card_id: first.packet.binding.card_id })
  if (action === 'submit') {
    fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  } else if (action === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Need more research' }))
    fireEvent.click(screen.getByRole('button', { name: 'Request research & next' }))
  }
  await screen.findByText('No prepared decisions ready.')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh prepared decisions' })).toBeEnabled())
  workspace.value = { ...workspace.value, queue: { items: [] }, state: { revision: 2 } }
  view.rerender(<Decisions />)
  expect(screen.queryByText('Requested source request is not ready for review.')).toBeNull()
  available = true
  if (refresh === 'manual') fireEvent.click(screen.getByRole('button', { name: 'Refresh prepared decisions' }))
  else await act(async () => { fireEvent.focus(window) })
  await waitFor(() => expect(document.querySelector('.dd-identifiers')).toHaveAttribute('data-semantic-id', `card:${second.packet.binding.card_id}`))
  expect(claims.at(-1)).not.toHaveProperty('card_id')
  expect(claims.at(-1)).not.toHaveProperty('lease_token')
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), cardId: first.packet.binding.card_id }, state: { revision: 3, queueCardId: first.packet.binding.card_id, navigation: { cardId: first.packet.binding.card_id, revision: 3 } } }
  view.rerender(<Decisions />)
  await waitFor(() => expect(claims.at(-1)).toMatchObject({ card_id: first.packet.binding.card_id }))
})

it.each(['not-saved', 'save-unconfirmed'])('retains exact navigation and operation after %s', async failure => {
  outcome = failure
  packet.packet.binding.request_key = 'request-a'
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: 'request-a' }, origin: { section: 'decisions', target: { kind: 'decision', id: 'request-a' } }, queue: { items: [{ id: 'request-a', cardIds: [packet.packet.binding.card_id] }] } }
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByRole('button', { name: failure === 'not-saved' ? 'Retry without advancing' : 'Confirm save status' })
  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: failure === 'not-saved' ? 'Retry without advancing' : 'Confirm save status' }))
  await waitFor(() => expect(submits).toHaveLength(2))
  expect(submits[1]).toEqual(submits[0])
  expect(screen.queryByText('No prepared decisions ready.')).toBeNull()
})

it.each([
  ['skip', 'focus'], ['research', 'focus'],
  ['skip', 'reload'], ['research', 'reload'],
])('reconciles a lost %s response through %s before releasing the next card', async (action, recovery) => {
  const first = structuredClone(packet), second = structuredClone(packet)
  second.id = '00000000-0000-4000-8000-000000000002'
  second.packet.binding.card_id = 'b'.repeat(32)
  second.packet.binding.request_key = 'request-b'
  let committed = false, lost = false, finished = false
  const releases: Record<string, unknown>[] = []
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url).split('/').pop()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === 'submit') throw new Error('Release must not answer')
    if (path === 'claim') {
      expect(committed).toBe(false)
      return new Response(JSON.stringify({ ok: true, data: { outcome: 'held', packet: first, lease_token: 'secret-lease' } }))
    }
    if (path === 'release') {
      releases.push(body)
      if (!committed) {
        committed = true; lost = true
        throw new Error('Dropped release response')
      }
      const originalRelease = releases[0]
      if (!originalRelease) throw new Error('Expected the original release request')
      if (body.operation_id === originalRelease.operation_id) {
        expect(body).toEqual(releases[0])
        return new Response(JSON.stringify({ ok: true, data: { outcome: 'released', next: { outcome: 'held', packet: second, lease_token: 'second-lease' } } }))
      }
      expect(body.lease_token).toBe('second-lease')
      finished = true
      return new Response(JSON.stringify({ ok: true, data: { outcome: 'released', next: { outcome: 'no-prepared-decisions' } } }))
    }
    return fallback(url, init)
  })
  await ready()
  const release = () => {
    if (action === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Need more research' }))
      fireEvent.click(screen.getByRole('button', { name: 'Request research & next' }))
    }
  }
  release()
  await waitFor(() => expect(lost).toBe(true))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled())
  if (recovery === 'reload') { cleanup(); render(<Decisions />) }
  else await act(async () => { fireEvent.focus(window) })
  await waitFor(() => expect(document.querySelector('.dd-identifiers')).toHaveAttribute('data-semantic-id', `card:${second.packet.binding.card_id}`))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled())
  release()
  await screen.findByText('No prepared decisions ready.')
  expect(finished).toBe(true)
  expect(releases).toHaveLength(3)
  const originalRelease = releases[0]
  const nextRelease = releases[2]
  if (!originalRelease || !nextRelease) throw new Error('Expected original and next release requests')
  expect(nextRelease.operation_id).not.toBe(originalRelease.operation_id)
  expect(submits).toHaveLength(0)
})

it.each(['skip', 'research'])('recovers a definitely rejected %s after expiry, focus and reload without losing selection', async action => {
  let rejected = false
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/release')) {
      rejected = true
      return new Response(JSON.stringify({ ok: true, data: { outcome: 'not-saved', code: 'claim-lost', message: 'Expired lease' } }))
    }
    return fallback(url, init)
  })
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  if (action === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Need more research' }))
    fireEvent.click(screen.getByRole('button', { name: 'Request research & next' }))
  }
  await waitFor(() => expect(rejected).toBe(true))
  await screen.findByRole('button', { name: 'Re-claim & revalidate' })
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  expect(JSON.parse(sessionStorage.getItem('tinstar-decision-review-v1')!).release).toBeUndefined()
  leaseToken = 'renewed-lease'
  await act(async () => { fireEvent.focus(window) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit decision & next →' })).toBeEnabled())
  cleanup(); await ready()
  expect(screen.getByRole('radio', { name: /Authorize preview only/ })).toBeChecked()
  outcome = 'recorded-empty'
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByText('No prepared decisions ready.')
  expect(submits).toHaveLength(1)
  const submission = submits[0]
  if (!submission) throw new Error('Expected a submission with the renewed lease')
  expect(submission.lease_token).toBe('renewed-lease')
})

it('keeps a completed Discuss target consumed across the Workbench and Desk mode boundary', async () => {
  const first = structuredClone(packet)
  workspace.value = { decisionTarget: { id: crypto.randomUUID(), requestKey: first.packet.binding.request_key }, origin: { section: 'decisions', target: { kind: 'decision', id: first.packet.binding.request_key } }, queue: { items: [{ id: first.packet.binding.request_key, cardIds: [first.packet.binding.card_id] }] } }
  outcome = 'recorded-empty'
  const view = render(<Decisions />)
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit decision & next →' }))
  await screen.findByText('No prepared decisions ready.')
  view.rerender(<div aria-label="Workbench mode" />)
  workspace.value = { ...workspace.value, queue: { items: [] } }
  packet = { ...packet, packet: { ...packet.packet, binding: { ...packet.packet.binding, card_id: 'b'.repeat(32), request_key: 'request-b' } } }
  view.rerender(<Decisions />)
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  const claims = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/claim'))
  expect(JSON.parse(String(claims.at(-1)![1]?.body))).not.toHaveProperty('card_id')
  expect(screen.queryByText('Requested source request is not ready for review.')).toBeNull()
})

it.each(['claimed', 'held', 'already-holding', 'card-held', 'mismatch', 'card-only-mismatch', 'no-prepared-decisions'])('consumes a one-shot target after %s; refresh and unrelated revisions never re-target', async firstOutcome => {
  const original = structuredClone(packet)
  const next = structuredClone(packet)
  next.id = '00000000-0000-4000-8000-000000000002'
  next.packet.binding.card_id = 'b'.repeat(32)
  next.packet.binding.request_key = 'request-b'
  const target = { id: 'one-shot-intent', cardId: original.packet.binding.card_id, requestKey: firstOutcome === 'card-only-mismatch' ? undefined : original.packet.binding.request_key }
  workspace.value = { decisionTarget: target }
  const claims: Record<string, unknown>[] = [], releases: Record<string, unknown>[] = []
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const input = init?.body ? JSON.parse(String(init.body)) : undefined
    let data: unknown
    if (String(url).endsWith('/claim')) {
      claims.push(input)
      if (claims.length > 1) data = { outcome: 'held', packet: next, lease_token: 'next-lease' }
      else if (firstOutcome === 'card-held') data = { outcome: 'not-saved', code: 'card-held', lease: { holder: 'Other real context' } }
      else if (firstOutcome === 'no-prepared-decisions') data = { outcome: firstOutcome }
      else data = { outcome: firstOutcome.includes('mismatch') ? 'claimed' : firstOutcome, packet: ['mismatch', 'card-only-mismatch', 'already-holding'].includes(firstOutcome) ? next : original, lease_token: 'first-lease' }
    } else if (String(url).endsWith('/release')) { releases.push(input); data = { outcome: 'released' } }
    else return fallback(url, init)
    return new Response(JSON.stringify({ ok: true, data }))
  })
  const view = render(<Decisions />)
  await waitFor(() => expect(workspace.consumed).toBe(target.id))
  await waitFor(() => expect(screen.queryByText('Decision Desk operation in progress.')).toBeNull())
  expect(claims).toHaveLength(1)
  expect(claims[0]).toMatchObject({ card_id: target.cardId })
  expect(releases).toHaveLength(firstOutcome.includes('mismatch') ? 1 : 0)
  const blocked = ['already-holding', 'card-held', 'mismatch', 'card-only-mismatch', 'no-prepared-decisions'].includes(firstOutcome)
  if (blocked) {
    expect(screen.getByRole('button', { name: 'Claim next prepared decision' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try this decision again' })).toBeVisible()
  }
  // A new queue observation and a presentation revision are not navigation.
  workspace.value = { ...workspace.value, queue: { items: [] }, state: { revision: 99, queueCardId: target.cardId } }
  view.rerender(<Decisions />)
  await act(async () => {})
  expect(claims).toHaveLength(1)
  await act(async () => { fireEvent.focus(window) })
  await waitFor(() => expect(claims).toHaveLength(2))
  expect(claims[1]).not.toHaveProperty('card_id')
  await waitFor(() => expect(document.querySelector('.dd-identifiers')).toHaveAttribute('data-semantic-id', `card:${next.packet.binding.card_id}`))
  expect(screen.queryByRole('button', { name: 'Try this decision again' })).toBeNull()
  // Unmounting the opt-in Desk cannot resurrect a consumed source target.
  view.rerender(<div>Workbench</div>)
  view.rerender(<Decisions />)
  await waitFor(() => expect(claims).toHaveLength(3))
  expect(claims[2]).not.toHaveProperty('card_id')
})

it('allows a quiet explicit one-shot retry after conflict, then claims the next card without retrying the target', async () => {
  const target = { id: 'conflicting-return', cardId: packet.packet.binding.card_id }
  workspace.value = { decisionTarget: target }
  const claims: Record<string, unknown>[] = []
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (!String(url).endsWith('/claim')) return fallback(url, init)
    const input = JSON.parse(String(init?.body)); claims.push(input)
    const data = input.card_id ? { outcome: 'not-saved', code: 'card-held' } : { outcome: 'held', packet, lease_token: 'next-lease' }
    return new Response(JSON.stringify({ ok: true, data }))
  })
  render(<Decisions />)
  await screen.findByRole('button', { name: 'Try this decision again' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Try this decision again' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Try this decision again' }))
  await waitFor(() => expect(claims).toHaveLength(2))
  expect(claims[1]).toHaveProperty('card_id', target.cardId)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Claim next prepared decision' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Claim next prepared decision' }))
  await screen.findByRole('radio', { name: /Authorize preview only/ })
  expect(claims).toHaveLength(3)
  expect(claims[2]).not.toHaveProperty('card_id')
})

it('allows an unchanged packet past its legacy review deadline while source validation is current', async () => {
  packet.expires_at = new Date(Date.now() - 3600_000).toISOString()
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /Authorize preview only/ }))
  expect(screen.getByRole('button', { name: 'Submit decision & next →' })).toBeEnabled()
  expect(screen.queryByText('Packet invalidated')).toBeNull()
})
