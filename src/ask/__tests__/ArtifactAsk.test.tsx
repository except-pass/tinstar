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
let records: AskItem[], requests: Array<Record<string, unknown>>, releases: ReleasesRead
function item(target: AskTarget, section: 'pulls' | 'releases'): AskItem {
  return askItemSchema.parse({ request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), question: 'What is the artifact evidence?', input_mode: 'text', context: { schema_version: 2, anchor: { kind: target.kind, page_id: target.id, label: 'Captured artifact', url: pull.url, observed_at: date }, target, view: { scene: section, query: 'a filter hiding this row' }, return_to: { section, target, view: { scene: section, query: 'a filter hiding this row' } } }, created_at: date, updated_at: date, status: 'answered', reply: { summary: 'Real-shaped test answer', detail: 'Evidence detail', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null })
}
beforeEach(() => {
  localStorage.clear(); window.history.replaceState(null, '', '/?view=pulls'); fixture.scene = fixtureScene(); records = []; requests = []
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
    if (path === '/api/pulls') data = { pulls: [pull, { ...pull, id: 'other/repo#17', repository: 'other/repo', url: 'https://github.com/other/repo/pull/17' }], repositories: [], warnings: [], associationsComplete: true }
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
  expect(returned).toHaveAttribute('data-ask-origin', pull.id)
  expect(document.querySelectorAll('.pr-row')).toHaveLength(1)
  expect(window.location.search).toContain('view=pulls')
  expect(JSON.parse(new URLSearchParams(window.location.search).get('origin')!)).toMatchObject({ section: 'pulls', target: { kind: 'pull', id: pull.id } })
  expect(screen.getByRole('dialog')).toHaveTextContent('Real-shaped test answer')
  fireEvent.click(screen.getByRole('button', { name: 'Back to task' }))
  expect(returned).toHaveFocus()
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
  expect(screen.getByRole('dialog')).toHaveTextContent('Real-shaped test answer')
})
