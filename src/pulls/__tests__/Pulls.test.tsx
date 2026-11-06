// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Pulls } from '../Pulls'
import type { PullSummary } from '../../shared/pulls'
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: null, now: Date.parse('2026-11-06T20:00:00Z') }) }))
const pulls: PullSummary[] = Array.from({ length: 50 }, (_, index) => ({ id: `${index < 25 ? 'alpha/repo' : 'zeta/repo'}#${index + 1}`, repository: index < 25 ? 'alpha/repo' : 'zeta/repo', number: index + 1,
  url: `https://github.com/${index < 25 ? 'alpha/repo' : 'zeta/repo'}/pull/${index + 1}`, title: `Change ${index + 1}`, author: 'contributor', draft: false, head: 'a'.repeat(40), base: 'main', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-06T19:00:00Z', observedAt: '2026-11-06T20:00:00Z', freshness: 'fresh', links: [] }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('renders 50 canonical rows, sorts repo both ways, searches, selects 10 and expands genuine detail', async () => {
  const read = vi.fn((input: string) => Promise.resolve(new Response(JSON.stringify({ ok: true, data: input.includes('/detail?') ? { head: 'a'.repeat(40), state: 'open', body: 'Real PR body\nsecond paragraph', additions: 4, deletions: 2, files: 3, checks: 'failed', review: 'Changes requested', reviewsComplete: true, reviews: [], observedAt: '2026-11-06T20:00:00Z', freshness: 'fresh', error: null } : { pulls, repositories: [], warnings: [], associationsComplete: true } }))))
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
