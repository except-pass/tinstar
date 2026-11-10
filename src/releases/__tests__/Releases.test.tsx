import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Releases } from '../Releases'
import { releaseAssociations, type ReleasesRead } from '../../shared/releases'
import type { AskReturn } from '../../shared/ask'
import { installed } from '../../server/actions/__tests__/fixtures'
import { releaseFixture } from './fixtures'

const observed = vi.hoisted(() => ({ scene: null as unknown, origin: undefined as AskReturn | undefined }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => {
  const [origin, setOrigin] = React.useState(observed.origin)
  return { scene: observed.scene, origin, clearOrigin: () => setOrigin(undefined), error: null, now: Date.now() }
} }))
// Ask's existing provider/transport is covered in ask tests; keep the same card-bound affordance here.
vi.mock('../../ask/AskSurface', () => ({ AskSurface: ({ as = 'tr', children, subject: _subject, ...props }: React.HTMLAttributes<HTMLElement> & { as?: string; subject: unknown }) => React.createElement(as, props, children) }))
vi.mock('../../ask/Ask', () => ({ useAskControls: () => null, AskContextComposer: () => null, AskProvider: ({ children }: { children: React.ReactNode }) => children, AskCardAction: ({ cardId }: { cardId: string }) => <button aria-label={`Ask about ${cardId}`}>Ask</button> }))
let data: ReleasesRead
beforeEach(() => {
  observed.origin = undefined
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const scene = releaseFixture(); observed.scene = scene; data = releaseAssociations(scene)
  for (const pull of data.pulls) Object.assign(pull, { title: `Receipt change ${pull.number}`, state: 'merged', freshness: 'fresh', mergedAt: '2026-11-06T18:00:00Z' })
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const mount = () => render(<Releases data={data} error={null} refresh={vi.fn()} />)
describe('PR-first Releases', () => {
  it('shows an unknown total for incomplete empty sources and retained failed reads', () => {
    data.pulls = []
    data.associationsComplete = false
    data.warnings = ['Notion association source unavailable']
    const view = mount()
    expect(screen.getByText('Releases').querySelector('small')).toHaveTextContent('?')
    expect(screen.getByText(/Sync incomplete/)).toBeTruthy()
    expect(screen.getByText('Notion association source unavailable')).toBeTruthy()
    data.associationsComplete = true
    view.rerender(<Releases data={data} error="Read failed" refresh={vi.fn()} />)
    expect(screen.getByText('Releases').querySelector('small')).toHaveTextContent('?')
  })
  it('keeps one PR row per group reference, canonical selection and same-row direct card/GitHub links', () => {
    const { container } = mount()
    const rows = container.querySelectorAll('[data-pull-id]')
    expect(rows).toHaveLength(3)
    const first = rows[0]! as HTMLElement
    expect(within(first).getByRole('link', { name: 'owner/repo#1 ↗' })).toHaveAttribute('href', 'https://github.com/owner/repo/pull/1')
    expect(first.querySelectorAll('a[href^="?card="]')).toHaveLength(2)
    fireEvent.click(within(first).getByRole('checkbox'))
    expect(screen.getByText('1 unique PRs selected')).toBeTruthy()
    expect(screen.getAllByLabelText('Select owner/repo#1').every(input => (input as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Repository' }))
    expect(container.querySelectorAll('[data-pull-id]')).toHaveLength(2)
    expect(screen.getByText('1 unique PRs selected')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('opens provenance only on demand, keeps unlink audit visible, and supports keyboard search focus/restore', () => {
    mount()
    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect owner/repo#1' })[0]!)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText('Notion Link/GitHub property')).toHaveLength(2)
    expect(within(dialog).getByRole('link', { name: 'Open PR in GitHub ↗' })).toHaveAttribute('href', 'https://github.com/owner/repo/pull/1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close release details' }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = screen.getByRole('combobox', { name: 'Find names, IDs and text' })
    fireEvent.change(search, { target: { value: 'PR #2' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getAllByRole('link', { name: /owner\/repo#/ })).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getAllByRole('link', { name: /owner\/repo#/ })).toHaveLength(3)
  })
  it('exposes unresolved cards under Exceptions without turning cards into table rows or fabricating shipped history', () => {
    data.unassociatedCards.push({ id: 'f'.repeat(32), title: 'Missing PR declaration', reason: 'No explicit link' })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Exceptions (1)' }))
    expect(screen.getByRole('link', { name: 'Missing PR declaration' })).toHaveAttribute('href', `?card=${'f'.repeat(32)}`)
    expect(screen.getByRole('table').querySelectorAll('[data-pull-id]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Shipped' }))
    expect(screen.getByText('No verified production evidence available yet.')).toBeTruthy()
  })
  it('shows reader failures prominently in production sync rather than silently pending', () => {
    data.githubSync = { status: 'error', errors: ['gh-axi is unavailable on the server PATH; configure the service PATH'] }
    mount()
    expect(screen.getByText(/Sync error: gh-axi unavailable on server PATH/)).toBeTruthy()
    expect(screen.getByRole('alert')).toHaveTextContent('configure the service PATH')
  })
  it('surfaces opt-in verification separately from unflagged dry-run completion without executing either transition', () => {
    const pull = data.pulls[0]!, cards = pull.links.map(link => link.cardId)
    pull.deployment = { state: 'shipped', verificationRequired: true, targets: [] }
    data.reconciliation = { mode: 'dry-run', id: 'report', sourceStatus: 'fresh', collectedAt: new Date().toISOString(), lastSuccessfulAt: null, warnings: [], targets: [], cards: cards.map((cardId, index) => ({ cardId, status: 'Waiting for Prod Release', owner: index ? 'Firstmate' : 'Will', requiredPulls: [pull.url], requiresProductionVerification: !index, decision: index ? 'would-complete' : 'would-verify', eligible: !!index, reasons: [], receiptIds: [] })) }
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Verify in Prod' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect owner/repo#1' })[0]!)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Dry run: Requires production verification')).toBeTruthy()
    expect(within(dialog).getByText('Dry run: Would mark Done')).toBeTruthy()
    expect(within(dialog).getAllByText('No Notion or decision transition is performed.')).toHaveLength(2)
    expect(within(dialog).queryByRole('button', { name: /mark Done|complete card/i })).toBeNull()
  })

})

describe('release origin identity', () => {
  it('lets a manual Smart Search selection replace the Desk origin and restore the prior filter', () => {
    observed.origin = { section: 'releases', target: { kind: 'pull', id: data.pulls[0]!.id } }
    mount()
    expect(screen.getByText(/Showing originating release owner\/repo#1/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'owner/repo#2 ↗' })).toBeNull()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = screen.getByRole('combobox', { name: 'Find names, IDs and text' })
    fireEvent.change(search, { target: { value: 'PR #2' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(screen.getByRole('link', { name: 'owner/repo#2 ↗' })).toBeTruthy()
    expect(screen.queryAllByRole('link', { name: 'owner/repo#1 ↗' })).toHaveLength(0)
    expect(screen.queryByText(/Showing originating release/)).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getAllByRole('link', { name: /owner\/repo#/ })).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'In Queue' })).toHaveAttribute('aria-pressed', 'true')
  })
  function prepare(kind: 'release' | 'receipt') {
    const pull = data.pulls[0]!
    pull.deployment = { state: 'in-queue', targets: [
      { component: 'web', target: 'production', state: 'unknown', reason: 'Pending', ancestry: 'unknown', receipt: { id: 'receipt-1', repository: pull.repository, component: 'web', target: 'production', environment: 'production', deployedSha: null, artifactDigest: null, version: null, deployedAt: '2026-11-06', workflowUrl: 'https://example.com/workflow', receiptUrl: 'https://example.com/receipt', outcome: 'succeeded', exceptions: [] } },
      { component: 'api', target: 'production', state: 'unknown', reason: 'Pending', ancestry: 'unknown', receipt: null },
    ] }
    observed.origin = { section: 'releases', target: { kind, id: pull.id, component: 'web', target: 'production', ...(kind === 'receipt' ? { receipt_id: 'receipt-1' } : {}) } } as AskReturn
    return pull
  }
  it('reports a removed deployment mapping instead of claiming return success', () => {
    const pull = prepare('release')
    pull.deployment!.targets.shift()
    mount()
    expect(screen.queryByText(/Showing originating release/)).toBeNull()
    expect(screen.getByText(/original deployment target is missing/i)).toBeTruthy()
  })
  it('highlights and focuses the exact deployment target', () => {
    prepare('release')
    const { container } = mount()
    const target = container.querySelector('[data-deployment-target]')!
    expect(target).toHaveClass('ask-origin')
    expect(target).toHaveFocus()
  })
  it('rejects the same receipt ID on a different component', () => {
    const pull = prepare('receipt')
    pull.deployment!.targets[1]!.receipt = pull.deployment!.targets[0]!.receipt
    pull.deployment!.targets.shift()
    mount()
    expect(screen.queryByText(/Showing originating release/)).toBeNull()
    expect(screen.getByText(/original receipt is missing or has been superseded/i)).toBeTruthy()
  })
  it('warns when the originating PR head changed', () => {
    const pull = data.pulls[0]!
    pull.head = 'b'.repeat(40)
    observed.origin = { section: 'releases', target: { kind: 'pull', id: pull.id, head: 'a'.repeat(40) } }
    mount()
    expect(screen.getByText(/PR head changed since this question/)).toBeTruthy()
  })
})

it.each(['toolbar', 'drawer', 'receipt'] as const)('preserves a stacked Releases PR identity in the %s Explain request', async entry => {
  const pull = data.pulls[0]!
  Object.assign(pull, { head: 'a'.repeat(40), base: 'stack-base' })
  const action = installed('explain')
  action.grant.repositories = [pull.repository]
  const catalog = { installed: [action], examples: [], receipts: [], policy: {}, runner: '' }
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: init?.method === 'POST' ? {} : catalog })))
  vi.stubGlobal('fetch', fetch)
  if (entry === 'receipt') observed.origin = { section: 'releases', target: { kind: 'pull', id: pull.id, head: pull.head!, action_receipt_id: 'receipt-1' } }
  mount()
  if (entry === 'toolbar') fireEvent.click(screen.getAllByLabelText(`Select ${pull.id}`)[0]!)
  if (entry === 'drawer') fireEvent.click(screen.getAllByRole('button', { name: `Inspect ${pull.id}` })[0]!)
  const scope = entry === 'drawer' ? within(screen.getByRole('dialog')) : screen
  const buttons = await scope.findAllByRole('button', { name: 'Explain · Simulated' })
  fireEvent.click(buttons.find(button => !(button as HTMLButtonElement).disabled)!)
  await waitFor(() => expect(fetch.mock.calls.some(([path]) => path === '/api/actions/run')).toBe(true))
  const payload = JSON.parse(String(fetch.mock.calls.find(([path]) => path === '/api/actions/run')![1]!.body))
  expect(payload).toMatchObject({ action: 'explain', view: { scene: 'releases' }, targets: [{ url: pull.url, head: pull.head, base: 'stack-base' }] })
})
