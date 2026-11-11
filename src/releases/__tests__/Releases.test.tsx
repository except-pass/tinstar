import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Releases, ReleaseCanvas, ReleaseDetail } from '../Releases'
import { releaseAssociations, type ReleasesRead } from '../../shared/releases'
import { releaseFixture } from './fixtures'
import { changeFixture, objectFixture } from '../../../test-fixtures/releases/objects'
import type { AskReturn } from '../../shared/ask'
import { notesFixture } from '../../../test-fixtures/releases/notes'
import { draftReleaseNotes } from '../../shared/releaseNotes'
import { releaseChanges } from '../../shared/releaseChanges'

const observed = vi.hoisted(() => ({ scene: null as unknown, origin: undefined as AskReturn | undefined }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => ({ scene: observed.scene, origin: observed.origin, error: null, now: Date.now(), clearOrigin: vi.fn() }) }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now(), refresh: vi.fn() }) }))
let data: ReleasesRead
beforeEach(() => {
  observed.origin = undefined
  const scene = releaseFixture(); observed.scene = scene; data = releaseAssociations(scene)
  for (const pull of data.pulls) Object.assign(pull, { title: `Actual change ${pull.number}`, state: 'merged', mergeSha: 'a'.repeat(40), freshness: 'fresh' })
  const first = { ...objectFixture(), pulls: data.pulls }
  const second = { ...objectFixture('draft', 'draft-next'), version: 'v1.25.0', candidateId: null, planId: null, state: 'Planning', pulls: [data.pulls[1]!] }
  const production = { ...objectFixture('production'), pulls: data.pulls }
  data.releases = [first, second, production]
  Element.prototype.scrollIntoView = vi.fn()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const mount = () => render(<Releases data={data} error={null} refresh={vi.fn()} />)

describe('release-first V3 surfaces', () => {
  it('changes the entire release atomically and keeps Draft distinct from RC', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'RC v1.24.1' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Changes in this release' })).toBeTruthy()
    expect(screen.getByRole('tabpanel').querySelectorAll('.data-row')).toHaveLength(3)
    fireEvent.click(screen.getByRole('tab', { name: 'Release notes' }))
    expect(screen.getByText('Not publishable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /v1.25.0 DRAFT/ }))
    expect(screen.getByRole('heading', { name: 'Draft v1.25.0' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel').querySelectorAll('.data-row')).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Verify' }))
    expect(screen.getByRole('heading', { name: 'v1.24.0' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Production acceptance' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /DRAFT/ })).toBeNull()
    expect(screen.getAllByText('No acceptance contract defined')).toHaveLength(3)
    expect(screen.queryByText('Passed')).toBeNull()
  })
  it('opens the contextual drawer with outcome and next step, exact release identity and explicit PR/card links', () => {
    const { container } = mount()
    const row = container.querySelector('.data-row') as HTMLButtonElement
    row.focus(); fireEvent.click(row)
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByText('Awaiting delivery · Acceptance unknown')).toBeTruthy()
    expect(within(drawer).getByText(/Define the feature-specific success condition/)).toBeTruthy()
    expect(within(drawer).getByText('RC v1.24.1 · owner/repo')).toBeTruthy()
    expect(within(drawer).getByRole('link', { name: 'owner/repo#1 ↗' })).toHaveAttribute('href', data.pulls[0]!.url)
    expect(within(drawer).getByRole('link', { name: 'Open linked card ↗' })).toHaveAttribute('href', expect.stringContaining('?card='))
    const close = within(drawer).getByRole('button', { name: 'Close details' })
    close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(within(drawer).getByText('Exact source identities')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(close).toHaveFocus()
    fireEvent.click(close)
    expect(screen.queryByRole('dialog')).toBeNull(); expect(row).toHaveFocus()
  })
  it('provides precise source-aware empty and retained-error views without falling back to a global PR table', () => {
    data.releases = []
    const view = mount()
    expect(screen.getByRole('heading', { name: 'No release candidates' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Verify' }))
    expect(screen.getByRole('heading', { name: 'No recorded production releases' })).toBeTruthy()
    view.rerender(<Releases data={data} error="Source unavailable" refresh={vi.fn()} />)
    expect(screen.getByText(/Retained records are last known/)).toBeTruthy()
  })
  it('shows truthful empty production notes, audience toggle and copy without publishing or dispatching', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mount(); fireEvent.click(screen.getByRole('tab', { name: 'Verify' })); fireEvent.click(screen.getByRole('tab', { name: 'Release notes' }))
    expect(screen.getByText('No changes are currently eligible for this audience.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Customer' }))
    expect(screen.getByText(/Customer-facing notes/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Draft release notes (not published)'))
    expect(await screen.findByText('Release notes copied')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(Publish|Deploy|Retry release|Advance status)$/ })).toBeNull()
  })
  it('keeps search scoped to the selected release and opens a real work row from a PR match', () => {
    mount()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = screen.getByRole('combobox', { name: 'Find names, IDs and text' })
    fireEvent.change(search, { target: { value: 'PR #2' } }); fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toHaveTextContent('owner/repo#2')
  })
  it('copies the selected audience only, explains exclusions internally and resets all notes on release selection', async () => {
    const f = notesFixture(); observed.scene = f.scene; data = f.data
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mount(); fireEvent.click(screen.getByRole('tab', { name: 'Verify' })); fireEvent.click(screen.getByRole('tab', { name: 'Release notes' }))
    const paper = document.querySelector('.notes-paper')!
    expect(paper).toHaveTextContent('Internal: Bound query load.')
    expect(paper).not.toHaveTextContent('Correct enum mappings')
    fireEvent.click(screen.getByText('Excluded from Customer notes (5)'))
    expect(screen.getByText('Internal-only work')).toBeTruthy()
    expect(screen.getByText('Acceptance: Failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Customer' }))
    expect(screen.queryByText('Excluded from Customer notes (5)')).toBeNull()
    expect(paper).toHaveTextContent('Customer: Hide absent generator frequency.')
    expect(paper).not.toHaveTextContent('Bound query load')
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }))
    expect(writeText).toHaveBeenLastCalledWith(draftReleaseNotes(f.release, releaseChanges(f.release, data, f.scene), 'customer').text)
    expect(await screen.findByText('Release notes copied')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /v1.23.9 PROD/ }))
    expect(screen.getByRole('heading', { name: 'v1.23.9' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Release notes' }))
    expect(screen.getByRole('button', { name: 'Internal' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('No changes are currently eligible for this audience.')).toBeTruthy()
    expect(screen.queryByText('Release notes copied')).toBeNull()
  })
  it('restores a contextual PR origin once without reopening a dismissed drawer on refresh', () => {
    observed.origin = { section: 'releases', target: { kind: 'pull', id: data.pulls[0]!.id }, view: { scene: 'releases', release_id: 'production' } }
    const view = mount()
    expect(screen.getByRole('dialog')).toHaveTextContent('owner/repo#1')
    expect(screen.getByRole('heading', { name: 'v1.24.0' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Verify' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    view.rerender(<Releases data={{ ...data }} error={null} refresh={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('returns supporting PR evidence to its associated work drawer in the selected release', () => {
    const supporting = data.pulls[0]!
    const member = { ...data.pulls[1]!, links: supporting.links }
    const production = data.releases!.find(release => release.id === 'production')!
    production.pulls = [member]
    production.supportingPulls = [supporting]
    observed.origin = { section: 'releases', target: { kind: 'pull', id: supporting.id }, view: { scene: 'releases', release_id: production.id } }
    mount()
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByRole('link', { name: `${supporting.id} ↗` })).toBeTruthy()
    expect(drawer.querySelector('.ask-origin')).toHaveAttribute('data-ask-origin', supporting.id)
    expect(screen.getByRole('heading', { name: 'v1.24.0' })).toBeTruthy()
    expect(production.pulls).toEqual([member])
  })
  it('highlights and focuses the originating supporting receipt when a member shares it', () => {
    const receipt = { id: 'shared-receipt', repository: 'owner/repo', environment: 'production', component: 'web', target: 'production', deployedSha: 'a'.repeat(40), artifactDigest: null, version: 'v1.24.0', deployedAt: '2026-11-10T12:00:00Z', receiptUrl: 'https://example.com/receipt', workflowUrl: 'https://example.com/workflow', outcome: 'succeeded' as const, exceptions: [] }
    const deployment = { state: 'shipped' as const, targets: [{ component: 'web', target: 'production', state: 'live' as const, reason: 'Verified readback', ancestry: 'ancestor' as const, receipt }] }
    const supporting = { ...data.pulls[0]!, deployment }
    const member = { ...data.pulls[1]!, links: supporting.links, deployment }
    data.pulls = [member, supporting]
    const production = data.releases!.find(release => release.id === 'production')!
    production.pulls = [member]
    production.supportingPulls = [supporting]
    production.targets = [{ component: 'web', target: 'production', receipt, readiness: 'Ready', readinessEvidence: [] }]
    observed.origin = { section: 'releases', target: { kind: 'receipt', id: supporting.id, component: 'web', target: 'production', receipt_id: receipt.id }, view: { scene: 'releases', release_id: production.id } }
    mount()
    const evidence = screen.getByRole('dialog').querySelector(`[data-receipt-id="${receipt.id}"]`)
    expect(evidence).toHaveClass('ask-origin')
    expect(evidence).toHaveFocus()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'v1.24.0' })).toBeTruthy()
    expect(production.pulls).toEqual([member])
  })
  it('renders fixture acceptance in attention/progress/passed/delivery order and excludes failed notes', () => {
    const release = objectFixture('production')
    const changes = [changeFixture(0, 'Passed'), changeFixture(1, 'Running'), changeFixture(2, 'Failed'), { ...changeFixture(3), delivery: 'Not deployed' as const }, changeFixture(4, 'Human review')]
    const view = render(<section className="rel-v3"><ReleaseCanvas release={release} changes={changes} tab="acceptance" setTab={vi.fn()} audience="internal" setAudience={vi.fn()} open={vi.fn()} /></section>)
    expect([...view.container.querySelectorAll('.group-label')].map(node => node.textContent)).toEqual(['NEEDS ATTENTION · 2', 'IN PROGRESS · 1', 'PASSED · 1', 'NOT YET DEPLOYED · 1'])
    view.rerender(<section className="rel-v3"><ReleaseCanvas release={release} changes={changes} tab="notes" setTab={vi.fn()} audience="internal" setAudience={vi.fn()} open={vi.fn()} /></section>)
    expect(screen.getByText('Fixture improvement 1.')).toBeTruthy()
    expect(screen.queryByText('Fixture improvement 3.')).toBeNull()
  })
})

it('shows latest failed evidence first and keeps the earlier failed/manual history explicit', () => {
  const release = objectFixture('production')
  const change = changeFixture(0, 'Failed')
  change.checks = [{ id: 'specific', method: 'workflow', ref: 'feature.prod', successCondition: change.successCondition!, fixture: 'safe fixture', key: 'bound', outcome: 'failed', record: {
    key: 'bound', releaseId: release.id, changeId: change.id, checkId: 'specific', events: [
      { at: '2026-11-10T12:00:00Z', actor: 'operator', outcome: 'inconclusive', reason: 'Dispatch intent', evidence: null, runId: null, runUrl: null },
      { at: '2026-11-10T12:01:00Z', actor: 'operator', outcome: 'failed', reason: 'Two of six feature assertions failed', evidence: 'https://example.com/results', runId: 42, runUrl: 'https://github.com/owner/repo/actions/runs/42' },
    ],
  } }]
  render(<ReleaseDetail release={release} change={change} close={vi.fn()} />)
  const drawer = screen.getByRole('dialog')
  expect(within(drawer).getByText('Deployed · Failed')).toBeTruthy()
  expect(within(drawer).getByText('Two of six feature assertions failed')).toBeTruthy()
  expect(within(drawer).getByRole('link', { name: 'Workflow run 42 ↗' })).toHaveAttribute('href', 'https://github.com/owner/repo/actions/runs/42')
  const history = within(drawer).getByText('Earlier check evidence (1)')
  expect(history.closest('details')).not.toHaveAttribute('open')
  fireEvent.click(history)
  expect(history.closest('details')).toHaveAttribute('open')
  expect(within(drawer).getByText(/Dispatch intent/)).toBeTruthy()
})
