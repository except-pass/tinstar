// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Pulls } from '../Pulls'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import type { PullSummary } from '../../shared/pulls'
const clock = vi.hoisted(() => ({ now: 0, scene: null as FloorScene | null }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => ({ scene: clock.scene, now: clock.now }) }))
const fileData = { head: 'a'.repeat(40), baseHead: 'b'.repeat(40), files: [], expectedFiles: 0, complete: true, observedAt: '2026-11-06T20:00:00Z', freshness: 'fresh', error: null }
const pulls: PullSummary[] = Array.from({ length: 50 }, (_, index) => ({ id: `${index < 25 ? 'alpha/repo' : 'zeta/repo'}#${index + 1}`, repository: index < 25 ? 'alpha/repo' : 'zeta/repo', number: index + 1,
  url: `https://github.com/${index < 25 ? 'alpha/repo' : 'zeta/repo'}/pull/${index + 1}`, title: `Change ${index + 1}`, author: 'contributor', draft: false, head: 'a'.repeat(40), base: 'main', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-06T19:00:00Z', observedAt: '2026-11-06T20:00:00Z', freshness: 'fresh', links: [] }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clock.now = Date.parse(fileData.observedAt); clock.scene = null })
clock.now = Date.parse(fileData.observedAt)
it('renders 50 canonical rows, sorts repo both ways, searches, selects 10 and expands genuine detail', async () => {
  const read = vi.fn((input: string) => Promise.resolve(new Response(JSON.stringify({ ok: true, data: input.includes('/files?') ? fileData : input.includes('/detail?') ? { head: 'a'.repeat(40), state: 'open', body: 'Real PR body\nsecond paragraph', additions: 4, deletions: 2, files: 3, checks: 'failed', review: 'Changes requested', reviewsComplete: true, reviews: [], observedAt: '2026-11-06T20:00:00Z', freshness: 'fresh', error: null } : { pulls, repositories: [], warnings: [], associationsComplete: true } }))))
  vi.stubGlobal('fetch', read)
  render(<Pulls />)
  await screen.findByText('50 observed open')
  expect(screen.getAllByRole('row')).toHaveLength(51)
  const tableRows = () => screen.getAllByRole('row').slice(1)
  expect(within(tableRows()[0]!).getByText('alpha/repo')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Repository ↑' }))
  expect(within(tableRows()[0]!).getByText('zeta/repo')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Repository ↓' }))
  const boxes = screen.getAllByRole('checkbox').slice(1, 11)
  boxes.forEach(box => fireEvent.click(box))
  expect(screen.getByText('10 selected')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect alpha/repo#1' }))
  expect(await screen.findByText('Real PR body second paragraph')).toBeTruthy()
  expect(screen.getByText('failed', { selector: 'td' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '#1 Change 1' }).getAttribute('href')).toBe('https://github.com/alpha/repo/pull/1')
  fireEvent.change(screen.getByRole('textbox', { name: 'Find PRs' }), { target: { value: 'zeta/repo' } })
  expect(tableRows()).toHaveLength(25)
  expect(screen.getByText('10 selected')).toBeTruthy()
})
it('makes missing reader/partial source errors visible rather than remaining pending', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ok: true, data: { pulls: [], repositories: [{ repository: 'alpha/repo', complete: false, status: 'unavailable', observedAt: null, error: 'gh-axi is missing from the server PATH.' }], warnings: [], associationsComplete: false } }))))
  render(<Pulls />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'alpha/repo: gh-axi is missing from the server PATH.')
  expect(screen.getByText('No PRs observed. Check repository coverage above.')).toBeTruthy()
})

it('shows the owner authorization error for inventory and detail', async () => {
  const message = 'Authorized tailnet owner required for PR Operations.'
  const denied = () => new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message } }), { status: 403 })
  vi.stubGlobal('fetch', () => Promise.resolve(denied()))
  const view = render(<Pulls />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', `${message} `)
  view.unmount()
  vi.stubGlobal('fetch', (input: string) => Promise.resolve((input.includes('/detail?') || input.includes('/files?')) ? denied() : new Response(JSON.stringify({ ok: true, data: { pulls: [pulls[0]], repositories: [], warnings: [], associationsComplete: true } }))))
  render(<Pulls />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect alpha/repo#1' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', message)
})
it('retains active card associations when scene context is unavailable', async () => {
  const pull = { ...pulls[0], links: [{ cardId: 'linked-card', active: true, sources: ['audit'], events: [] }, { cardId: 'old-card', active: false, sources: ['audit'], events: [] }] }
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ok: true, data: { pulls: [pull], repositories: [], warnings: [], associationsComplete: true } }))))
  render(<Pulls />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect alpha/repo#1' }))
  expect(screen.getByText('Linked work · Confirmed')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'linked-card' }).getAttribute('href')).toBe('?card=linked-card')
  expect(screen.getByText(/Card context unavailable/)).toBeTruthy()
  expect(screen.queryByText(/No verified operational card/)).toBeNull()
  expect(screen.queryByRole('link', { name: 'old-card' })).toBeNull()
})

it.each([true, false])('ages an expanded footprint independently of coverage (complete=%s) and refreshes it', async complete => {
  const observed = Date.parse(fileData.observedAt)
  clock.now = observed
  const files = vi.fn(() => ({ ...fileData, complete, observedAt: new Date(clock.now).toISOString() }))
  vi.stubGlobal('fetch', (input: string) => Promise.resolve(new Response(JSON.stringify({ ok: true, data: input.includes('/files?') ? files() : input.includes('/detail?') ? { head: fileData.head, reviews: [], observedAt: fileData.observedAt, freshness: 'fresh' } : { pulls: [pulls[0]], repositories: [], warnings: [], associationsComplete: true } }))))
  const view = render(<Pulls />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect alpha/repo#1' }))
  const heading = `Change footprint · 0 / 0 files · ${complete ? 'Complete' : 'Partial'}`
  await screen.findByRole('heading', { name: heading })
  clock.now = observed + 119_999
  view.rerender(<Pulls />)
  expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
  clock.now = observed + 120_000
  view.rerender(<Pulls />)
  expect(screen.getByRole('heading', { name: `${heading} · stale` })).toBeTruthy()
  expect(files).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Read current detail' }))
  await screen.findByRole('heading', { name: heading })
  expect(files).toHaveBeenCalledTimes(2)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Read current detail' }).hasAttribute('disabled')).toBe(false))
  if (complete) {
    fireEvent.click(screen.getByRole('button', { name: 'Read current detail' }))
    expect(files).toHaveBeenCalledTimes(2)
  }
})

it.each([
  ['last-known', 'confirmed', 'Last known', 'fresh'],
  ['historical', 'confirmed', 'Historical', 'failed'],
  ['current', 'confirmed', 'Confirmed', 'fresh'],
  ['current', 'confirmed', 'Last known', 'failed'],
  ['current', 'confirmed', 'Last known', 'intentions-expired'],
  ['current', 'confirmed', 'Last known', 'execution-expired'],
  ['current', 'confirmed', 'Last known', 'execution-unavailable'],
  ['current', 'conflicting', 'Conflicting / unknown', 'failed'],
  ['current', 'unverified', 'Suggested / unverified', 'failed'],
] as const)('labels %s/%s claim evidence as %s work', async (state, verification, label, condition) => {
  const scene: FloorScene = fixtureScene({ now: clock.now })
  const worker = scene.executions[0]!
  worker.source.pr = { url: pulls[0]!.url, head: fileData.head, source: 'task metadata' }
  const claim = scene.claims.find(claim => claim.executionId === worker.id)!
  scene.claims = [{ ...claim, state, verification, sources: ['Notion declaration'], observedAt: fileData.observedAt }]
  scene.claimHistory = []
  if (condition === 'failed') scene.searchReadFailed = true
  if (condition === 'intentions-expired') scene.coverage.intentions.expiresAt = new Date(clock.now).toISOString()
  if (condition === 'execution-expired') worker.observation.expiresAt = new Date(clock.now).toISOString()
  if (condition === 'execution-unavailable') worker.observation.status = 'unknown'
  clock.scene = scene
  vi.stubGlobal('fetch', (input: string) => Promise.resolve(new Response(JSON.stringify({ ok: true, data: input.includes('/files?') ? fileData : input.includes('/detail?') ? { head: fileData.head, reviews: [], observedAt: fileData.observedAt, freshness: 'fresh' } : { pulls: [pulls[0]], repositories: [], warnings: [], associationsComplete: true } }))))
  render(<Pulls />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect alpha/repo#1' }))
  await screen.findByRole('heading', { name: /Change footprint/ })
  const evidence = screen.getByText((_, element) => element?.tagName === 'P' && !!element.textContent?.startsWith(`${label} work:`))
  expect(evidence.textContent).toContain(`Notion declaration · observed ${fileData.observedAt}`)
  expect(within(evidence).getByRole('link').getAttribute('href')).toBe(`?card=${claim.cardId}`)
  if (condition === 'failed' || condition.startsWith('execution-')) {
    const contributor = evidence.closest('article')!
    expect(within(contributor).getByText('Last known', { selector: 'strong' })).toBeTruthy()
    expect(within(contributor).getByText(/Source task metadata/).textContent).not.toContain(' · fresh · ')
  }
  if (label !== 'Confirmed') expect(screen.queryByText(/^Confirmed work:/)).toBeNull()
})
