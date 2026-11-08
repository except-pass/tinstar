import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../../App'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { askItemSchema, type AskItem, type AskTarget } from '../../shared/ask'
import type { ReleasesRead } from '../../shared/releases'
import type { PullSummary } from '../../shared/pulls'
const fixture = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: fixture.scene, error: null, now: Date.now() }) }))
vi.mock('../../reconciliation/useDeskQueue', () => ({ useDeskQueue: () => ({ queue: null, error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
const head = 'a'.repeat(40), date = '2026-11-08T12:00:00.000Z'
const receipt = { id: 'receipt-17', repository: 'owner/repo', environment: 'production', target: 'production', component: 'web', deployedSha: head, artifactDigest: null, version: '6.0', deployedAt: date, workflowUrl: 'https://github.com/owner/repo/actions/runs/17', receiptUrl: 'https://github.com/owner/repo/releases/tag/v6', outcome: 'succeeded' as const, exceptions: [] }
const pull: PullSummary = { id: 'owner/repo#17', repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17', title: 'Exact artifact title', author: 'owner', draft: false, head, base: 'main', createdAt: date, updatedAt: date, observedAt: date, freshness: 'fresh', links: [] }
let inventory: PullSummary[], originResult: PullSummary | null
let records: AskItem[], requests: Array<Record<string, unknown>>, releases: ReleasesRead
function item(target: AskTarget, section: 'pulls' | 'releases'): AskItem {
  return askItemSchema.parse({ request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), question: 'What is the artifact evidence?', input_mode: 'text', context: { schema_version: 2, anchor: { kind: target.kind, page_id: target.id, label: 'Captured artifact', url: pull.url, observed_at: date }, target, view: { scene: section, query: 'a filter hiding this row' }, return_to: { section, target, view: { scene: section, query: 'a filter hiding this row' } } }, created_at: date, updated_at: date, status: 'answered', reply: { summary: 'Real-shaped test answer', detail: 'Evidence detail', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null })
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/?view=pulls'); fixture.scene = fixtureScene(); records = []; requests = []; inventory = [pull, { ...pull, id: 'other/repo#17', repository: 'other/repo', url: 'https://github.com/other/repo/pull/17' }]; originResult = null
  releases = { generatedAt: date, pulls: [{ ...pull, state: 'merged', mergedAt: date, mergeSha: head, exceptions: [], deployment: { state: 'shipped', targets: [{ target: 'production', component: 'web', state: 'live', reason: 'Verified evidence', ancestry: 'ancestor', receipt }] } }], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false }
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : null
    let data: unknown = {}
    if (path === '/api/quota') return new Response(JSON.stringify({ providers: [], checkedAt: null, fetchedAt: null, commandError: null }))
    if (path === '/api/fleet') data = { ready: true, workers: [], attention: [], errors: [] }
    if (path === '/api/fleet/messages') data = []
    if (path === '/api/releases') data = releases
    if (path === '/api/pulls') data = { pulls: inventory, repositories: [], warnings: [], associationsComplete: true }
    if (path.startsWith('/api/pulls/origin')) return new Response(JSON.stringify(originResult ? { ok: true, data: originResult } : { ok: false, error: { message: 'Not accessible in current scope.' } }), { status: originResult ? 200 : 403 })
    if (path.startsWith('/api/pulls/files')) data = { head, baseHead: head, files: [], expectedFiles: 0, complete: true, freshness: 'fresh', observedAt: date, error: null }
    if (path.startsWith('/api/pulls/detail')) data = { head, state: 'open', body: 'PR description', additions: 3, deletions: 1, files: 2, checks: 'failed', review: 'Changes requested', reviews: [], reviewsComplete: true, freshness: 'fresh', observedAt: date, error: null }
    if (path === '/api/reconciliation/ui') data = body?.type === 'register' ? { scene_id: 'artifact-ui', key: 'key' } : { commands: [] }
    if (path === '/api/ask/requests') {
      if (body) { requests.push(body); const saved = { ...item(body.target, body.view.scene), question: body.question, status: 'sent' as const, reply: null }; records.push(saved); data = saved }
      else data = records
    }
    if (path.endsWith('/read')) { const saved = records.find(record => path.includes(record.request_id))!; saved.read_at = date; data = saved }
    return new Response(JSON.stringify({ ok: true, data }))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState(null, '', '/') })
it('keeps PR inspect normal while CI right-click opens the shared editable, genuinely PR-bound Ask', async () => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect owner/repo#17' }))
  const ci = await screen.findByText('failed', { selector: 'td' })
  fireEvent.contextMenu(ci)
  const question = screen.getByRole('textbox', { name: 'Question' })
  expect(question).toHaveValue('What is happening with CI for this PR?')
  expect(screen.getByRole('dialog')).toHaveTextContent('owner/repo#17')
  expect(requests).toHaveLength(0)
  fireEvent.change(question, { target: { value: 'Explain this exact CI failure.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: { kind: 'pull', id: pull.id, head }, field_key: 'ci', field_value: 'failed', view: { scene: 'pulls' } })
  expect(requests[0]).not.toHaveProperty('card_id')
})
it('asks about a Releases PR row as a PR and receipt evidence as its exact immutable receipt', async () => {
  window.history.replaceState(null, '', '/?view=releases')
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Shipped' }))
  const row = (await screen.findByRole('button', { name: 'Inspect owner/repo#17' })).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: 'Ask about this item' }))
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('')
  expect(screen.getByRole('dialog')).toHaveTextContent(pull.id)
  fireEvent.click(screen.getByRole('button', { name: 'Close question' }))
  fireEvent.click(within(row).getByRole('button', { name: 'Inspect owner/repo#17' }))
  const evidence = document.querySelector('[data-receipt-id="receipt-17"]')!
  fireEvent.contextMenu(evidence.querySelector('p')!)
  const question = screen.getByRole('textbox', { name: 'Question' })
  expect(question).toHaveValue('What does this deployment receipt establish?')
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: { kind: 'receipt', id: pull.id, target: 'production', component: 'web', receipt_id: receipt.id }, field_key: 'receipt', view: { scene: 'releases' } })
})
it('returns a retained PR Ask from Releases to its exact authorized row, with canonical URL and browser Back', async () => {
  window.history.replaceState(null, '', '/?view=releases')
  records = [item({ kind: 'pull', id: pull.id, head }, 'pulls')]
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  await screen.findByRole('region', { name: 'Pull requests' })
  const returned = document.querySelector<HTMLElement>('.pr-row.ask-origin')!
  expect(await screen.findByRole('region', { name: `Details ${pull.id}` })).toBeTruthy()
  expect(await screen.findByText('PR description')).toBeTruthy()
  expect(returned).toHaveAttribute('data-ask-origin', pull.id)
  expect(document.querySelectorAll('.pr-row')).toHaveLength(1)
  expect(window.location.search).toContain('view=pulls')
  expect(JSON.parse(new URLSearchParams(window.location.search).get('origin')!)).toMatchObject({ section: 'pulls', target: { kind: 'pull', id: pull.id } })
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Real-shaped test answer')
  expect(returned).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse answer' }))
  const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { window.history.back(); await popped })
  expect(window.location.search).toBe('?view=releases')
})
it('reveals and highlights exact receipt evidence in Releases without replacing the global Desk', async () => {
  records = [item({ kind: 'receipt', id: pull.id, target: 'production', component: 'web', receipt_id: receipt.id }, 'releases')]
  render(<App />)
  const desk = screen.getByLabelText('Your desk')
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  await waitFor(() => expect(document.querySelector('[data-receipt-id="receipt-17"].ask-origin')).toBeTruthy())
  expect(screen.getByLabelText('Your desk')).toBe(desk)
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Real-shaped test answer')
})


it('keeps neighbor previews inline and restores Releases filter and grouping with one Back', async () => {
  window.history.replaceState(null, '', '/?view=releases')
  const first = item({ kind: 'pull', id: pull.id, head }, 'pulls')
  const neighbor = { ...item({ kind: 'pull', id: 'other/repo#17', head }, 'pulls'), question: 'Second independent question' }
  records = [first, neighbor]
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Shipped' }))
  fireEvent.click(screen.getByRole('button', { name: 'Repository' }))
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Evidence detail')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: /New answer.*Second independent question/ })).toBeVisible()
  await waitFor(() => expect(document.querySelector('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', pull.id))
  const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Back to previous view' }))
  await act(async () => { await popped })
  expect(screen.getByRole('button', { name: 'Shipped' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Repository' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Evidence detail')
  fireEvent.click(screen.getByRole('button', { name: /New answer.*Second independent question/ }))
  expect(screen.getAllByRole('region', { name: /Answer thread/ })).toHaveLength(1)
  await waitFor(() => expect(document.querySelector('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', 'other/repo#17'))
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Second independent question')
})

it('restores PR query and sort with one browser Back', async () => {
  records = [item({ kind: 'receipt', id: pull.id, target: 'production', component: 'web', receipt_id: receipt.id }, 'releases')]
  render(<App />)
  await screen.findByRole('button', { name: 'Inspect owner/repo#17' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Find PRs' }), { target: { value: 'owner/repo' } })
  fireEvent.click(screen.getByRole('button', { name: /^Author/ }))
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  await screen.findByRole('region', { name: 'Releases' })
  const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { history.back(); await popped })
  expect(screen.getByRole('textbox', { name: 'Find PRs' })).toHaveValue('owner/repo')
  expect(screen.getByRole('button', { name: /^Author/ }).closest('th')).toHaveAttribute('aria-sort', 'ascending')
  expect(screen.getByRole('region', { name: /Answer thread/ })).toBeVisible()
})


it('reveals both verified relationship endpoints and only its link from another section, retaining the inline answer', async () => {
  history.replaceState(null, '', '/?view=releases')
  const scene = fixtureScene(), claim = scene.claims.find(link => link.verification === 'confirmed' && link.state === 'current')!
  const context = { target: { kind: 'claim', id: claim.id }, view: { scene: 'overview' }, anchor: { kind: 'link', page_id: claim.id, label: 'Verified relationship', url: null, observed_at: date }, return_to: { section: 'overview', target: { kind: 'claim', id: claim.id } } }
  records = [askItemSchema.parse({ ...item({ kind: 'pull', id: pull.id }, 'pulls'), context })]
  const view = render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  await screen.findByRole('region', { name: 'Overview' })
  const card = [...view.container.querySelectorAll<HTMLElement>('.ov-card')].find(row => row.dataset.entityId === claim.cardId)!
  const worker = [...view.container.querySelectorAll<HTMLElement>('.ov-execution')].find(row => row.dataset.entityId === claim.executionId)!
  expect(card).toBeVisible(); expect(worker).toBeVisible()
  expect(card).toHaveClass('flashed'); expect(worker).toHaveClass('flashed')
  const lines = view.container.querySelectorAll('.ov-line.flashed')
  expect(lines).toHaveLength(1)
  expect(lines[0]!.parentElement!.querySelector('[data-claim-id]')).toHaveAttribute('data-claim-id', claim.id)
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Evidence detail')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([
  ['description', 'PR description', 'Explain this PR and its current situation.'],
  ['changes', 'Change footprint', 'What is risky in these changes?'],
  ['worker', 'Unlinked / unknown', 'What is this worker doing on the PR?'],
])('opens editable %s Ask from inspected PR detail or a keyboard field without sending', async (key, label, draft) => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect owner/repo#17' }))
  await screen.findByText('PR description')
  const field = key === 'changes' ? screen.getByRole('region', { name: label }).parentElement! : key === 'worker' ? within(screen.getByRole('button', { name: 'Inspect owner/repo#17' }).closest('tr')!).getByText(label) : screen.getByText(label)
  fireEvent.keyDown(field, { key: 'F10', shiftKey: true })
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue(draft)
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: { kind: 'pull', id: pull.id, head }, field_key: key })
})
it('asks about the explicit Notion link while retaining normal link navigation', async () => {
  const scene = fixture.scene as ReturnType<typeof fixtureScene>, cardId = scene.cards[0]!.id
  inventory[0] = { ...pull, links: [{ cardId, active: true, sources: ['Notion Link/GitHub property'], events: [] }] }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect owner/repo#17' }))
  const detail = await screen.findByRole('region', { name: `Details ${pull.id}` })
  const link = detail.querySelector<HTMLAnchorElement>('a[data-ask-field="relationship"]')!
  expect(link.getAttribute('href')).toBe(`?card=${cardId}`)
  fireEvent.contextMenu(link)
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('How are these two items related?')
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: { kind: 'pull', id: pull.id, head }, field_key: 'relationship' })
})
it('reveals a now-closed changed-head PR, inspects it and restores the captured filter when reveal ends', async () => {
  window.history.replaceState(null, '', '/?view=releases')
  inventory = inventory.slice(1)
  originResult = { ...pull, state: 'merged', head: 'b'.repeat(40) }
  records = [item({ kind: 'pull', id: pull.id, head }, 'pulls')]
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  expect(await screen.findByText(/Showing originating PR owner\/repo#17 \(merged\)/)).toHaveTextContent('head changed')
  expect(await screen.findByRole('region', { name: `Details ${pull.id}` })).toBeTruthy()
  expect(document.querySelectorAll('.pr-row')).toHaveLength(1)
  expect(screen.getByRole('textbox', { name: 'Find PRs' })).toHaveValue('a filter hiding this row')
  expect(screen.getByRole('dialog')).toHaveTextContent('Real-shaped test answer')
  fireEvent.click(screen.getByRole('button', { name: 'Back to task' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show all PRs in this view' }))
  expect(screen.getByRole('textbox', { name: 'Find PRs' })).toHaveValue('a filter hiding this row')
  expect(document.querySelectorAll('.pr-row')).toHaveLength(0)
})
it('retains the answer and original GitHub link when the PR is inaccessible', async () => {
  inventory = []; records = [item({ kind: 'pull', id: pull.id, head }, 'pulls')]
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  expect(await screen.findByText(/originating PR.*missing or inaccessible/)).toHaveTextContent('Not accessible in current scope')
  expect(screen.getByRole('link', { name: 'Open originating PR in GitHub ↗' })).toHaveAttribute('href', pull.url)
  expect(document.querySelector('.pr-row')).toBeNull()
  expect(screen.getByRole('dialog')).toHaveTextContent('Real-shaped test answer')
})

it.each([false, true])('handles a deferred Overview origin deep link with newer manual navigation=%s', async navigateAway => {
  const scene = fixtureScene(), target = { kind: 'card' as const, id: scene.cards[0]!.id }
  history.replaceState(null, '', `/?origin=${encodeURIComponent(JSON.stringify({ section: 'overview', target }))}`)
  fixture.scene = null
  const view = render(<App />)
  if (navigateAway) fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity' })).getByRole('button', { name: /^Releases/ }))
  fixture.scene = scene
  view.rerender(<App />)
  if (navigateAway) {
    expect(location.search).toContain('view=releases')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity' })).getByRole('button', { name: 'Overview' }))
    expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
    expect(view.container.querySelector('.ov-card.flashed')).toBeNull()
  } else {
    expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
    expect(view.container.querySelector(`.ov-card[data-entity-id="${target.id}"].flashed`)).toBeTruthy()
  }
})


it.each(['Clear', 'Escape'])('recovers a direct Overview origin using %s', method => {
  const scene = fixtureScene(), target = { kind: 'card' as const, id: scene.cards[0]!.id }
  history.replaceState(null, '', `/?origin=${encodeURIComponent(JSON.stringify({ section: 'overview', target }))}`)
  const view = render(<App />)
  expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  if (method === 'Clear') fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
  else fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  expect(view.container.querySelectorAll('.ov-card').length).toBeGreaterThan(1)
})

it.each((['card', 'execution', 'claim'] as const).flatMap(kind => [false, true].map(cancel => ({ kind, cancel }))))('resolves a fresh $kind origin from a non-null older scene, cancellation=$cancel', async ({ kind, cancel }) => {
  const scene = fixtureScene()
  const id = kind === 'card' ? scene.cards[0]!.id : kind === 'execution' ? scene.executions[0]!.id : scene.claims.find(claim => claim.verification === 'confirmed' && claim.state === 'current')!.id
  const target = { kind, id }
  fixture.scene = { ...scene, cards: kind === 'card' ? scene.cards.filter(row => row.id !== id) : scene.cards,
    executions: kind === 'execution' ? scene.executions.filter(row => row.id !== id) : scene.executions,
    claims: kind === 'claim' ? scene.claims.filter(row => row.id !== id) : scene.claims, claimHistory: [] }
  history.replaceState(null, '', `/?origin=${encodeURIComponent(JSON.stringify({ section: 'overview', target }))}`)
  const view = render(<App />)
  expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  if (cancel) fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity' })).getByRole('button', { name: /^Releases/ }))
  fixture.scene = scene
  view.rerender(<App />)
  if (cancel) {
    expect(location.search).toContain('view=releases')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity' })).getByRole('button', { name: 'Overview' }))
    expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
    return
  }
  expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  expect(view.container.querySelector('.flashed')).toBeTruthy()
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity' })).getByRole('button', { name: /^Releases/ }))
  fixture.scene = { ...scene }
  view.rerender(<App />)
  expect(location.search).toContain('view=releases')
})

it.each((['card', 'execution', 'claim'] as const).flatMap(kind => ['Back', 'reload'].map(mode => ({ kind, mode }))))('resolves an unresolved $kind entry after $mode and later scene arrival', async ({ kind, mode }) => {
  const scene = fixtureScene()
  const id = kind === 'card' ? scene.cards[0]!.id : kind === 'execution' ? scene.executions[0]!.id : scene.claims.find(claim => claim.verification === 'confirmed' && claim.state === 'current')!.id
  const target = { kind, id }
  fixture.scene = { ...scene, cards: kind === 'card' ? scene.cards.filter(row => row.id !== id) : scene.cards,
    executions: kind === 'execution' ? scene.executions.filter(row => row.id !== id) : scene.executions,
    claims: kind === 'claim' ? scene.claims.filter(row => row.id !== id) : scene.claims, claimHistory: [] }
  history.replaceState(null, '', `/?origin=${encodeURIComponent(JSON.stringify({ section: 'overview', target }))}`)
  records = [item({ kind: 'pull', id: pull.id }, 'pulls')]
  let view = render(<App />)
  expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  if (mode === 'Back') {
    fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
    await screen.findByRole('region', { name: 'Pull requests' })
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    await act(async () => { history.back(); await popped })
  } else {
    fireEvent(window, new Event('pagehide'))
    view.unmount()
    view = render(<App />)
  }
  expect(history.state.tinstarWorkspace.section).toBe('overview')
  expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  fixture.scene = scene
  view.rerender(<App />)
  expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  expect(view.container.querySelector('.flashed')).toBeTruthy()
})

it.each([false, true])('captures PR query and sort edits while inventory loads, descending=%s', async descending => {
  records = [item({ kind: 'receipt', id: pull.id, target: 'production', component: 'web', receipt_id: receipt.id }, 'releases')]
  const read = vi.mocked(fetch).getMockImplementation()!
  let releaseInventory!: () => void
  const inventoryReady = new Promise<void>(resolve => { releaseInventory = resolve })
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === '/api/pulls') await inventoryReady
    return read(input, init)
  })
  render(<App />)
  expect(screen.getByText('Reading GitHub…')).toBeVisible()
  fireEvent.change(screen.getByRole('textbox', { name: 'Find PRs' }), { target: { value: 'artifact' } })
  fireEvent.click(screen.getByRole('button', { name: 'Author', exact: true }))
  if (descending) fireEvent.click(screen.getByRole('button', { name: 'Author ↑' }))
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  await screen.findByRole('region', { name: 'Releases' })
  const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { history.back(); await popped })
  expect(screen.getByText('Reading GitHub…')).toBeVisible()
  await act(async () => { releaseInventory() })
  await screen.findByText('2 observed open')
  expect(screen.getByRole('textbox', { name: 'Find PRs' })).toHaveValue('artifact')
  expect(screen.getByRole('button', { name: descending ? 'Author ↓' : 'Author ↑' })).toBeVisible()
})

it('reveals a Work answer using its canonical card return locator', async () => {
  history.replaceState(null, '', '/?view=releases')
  const scene = fixtureScene(), target = { kind: 'card' as const, id: scene.cards[0]!.id }
  records = [askItemSchema.parse({ ...item({ kind: 'pull', id: pull.id }, 'pulls'), question: 'Work evidence', context: {
    anchor: { kind: 'work', page_id: target.id, label: 'Work source', url: null, observed_at: date },
    view: { scene: 'overview' }, return_to: { section: 'overview', target },
  } })]
  const view = render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*Work evidence/ }))
  expect(view.container.querySelector(`.ov-card[data-entity-id="${target.id}"].flashed`)).toBeTruthy()
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Evidence detail')
  fireEvent.click(screen.getByRole('button', { name: 'Return to source' }))
  expect(view.container.querySelector(`.ov-card[data-entity-id="${target.id}"].flashed`)).toBeTruthy()
})

it('preserves a pending PR return when leaving again before inventory is ready', async () => {
  records = [item({ kind: 'receipt', id: pull.id, target: 'production', component: 'web', receipt_id: receipt.id }, 'releases')]
  const read = vi.mocked(fetch).getMockImplementation()!
  let block = false, releaseInventory!: () => void
  const inventoryReady = new Promise<void>(resolve => { releaseInventory = resolve })
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === '/api/pulls' && block) await inventoryReady
    return read(input, init)
  })
  render(<App />)
  await screen.findByText('2 observed open')
  fireEvent.change(screen.getByRole('textbox', { name: 'Find PRs' }), { target: { value: 'owner/repo' } })
  fireEvent.click(screen.getByRole('button', { name: 'Author', exact: true }))
  block = true
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*What is the artifact evidence/ }))
  await screen.findByRole('region', { name: 'Releases' })
  const pop = async (direction: 'back' | 'forward') => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    await act(async () => { history[direction](); await popped })
  }
  await pop('back')
  expect(screen.getByText('Reading GitHub…')).toBeVisible()
  fireEvent.change(screen.getByRole('textbox', { name: 'Find PRs' }), { target: { value: 'temporary loading edit' } })
  fireEvent(window, new Event('pagehide'))
  expect(history.state.tinstarWorkspace.query).toBe('owner/repo')
  await pop('forward'); await pop('back')
  await act(async () => { releaseInventory() })
  await screen.findByText('2 observed open')
  expect(screen.getByRole('textbox', { name: 'Find PRs' })).toHaveValue('owner/repo')
  expect(screen.getByRole('button', { name: 'Author ↑' })).toBeVisible()
})
