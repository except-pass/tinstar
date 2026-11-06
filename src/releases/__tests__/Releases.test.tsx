import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Releases } from '../Releases'
import { releaseAssociations, type ReleasesRead } from '../../shared/releases'
import { releaseFixture } from './fixtures'

const observed = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
// Ask's existing provider/transport is covered in ask tests; keep the same card-bound affordance here.
vi.mock('../../ask/Ask', () => ({ AskProvider: ({ children }: { children: React.ReactNode }) => children, AskCardAction: ({ cardId }: { cardId: string }) => <button aria-label={`Ask about ${cardId}`}>Ask</button> }))
let data: ReleasesRead
beforeEach(() => {
  const scene = releaseFixture(); observed.scene = scene; data = releaseAssociations(scene)
  for (const pull of data.pulls) Object.assign(pull, { title: `Receipt change ${pull.number}`, state: 'merged', freshness: 'fresh', mergedAt: '2026-11-06T18:00:00Z' })
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
})
afterEach(cleanup)
const mount = () => render(<Releases data={data} error={null} refresh={vi.fn()} />)
describe('PR-first Releases', () => {
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
})
