import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Releases } from '../Releases'
import { apiFetch } from '../../apiClient'
import { notesFixture } from '../../../test-fixtures/releases/notes'
import { releaseChanges } from '../../shared/releaseChanges'
import type { FloorScene } from '../../shared/reconciliationPresentation'

const observed = vi.hoisted(() => ({ scene: null as FloorScene | null }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => ({ scene: observed.scene, now: Date.now(), error: null }) }))
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks() })

it.each(['Done', 'Archived'])('retains %s accepted work alongside active work in visible and copied notes', async status => {
  const f = notesFixture()
  f.scene.cards[1]!.source.properties.Status!.value = status
  f.scene.cards[0]!.source.properties.Evidence!.value = String(f.scene.cards[0]!.source.properties.Evidence!.value).replace('"audience":"internal"', '"audience":"customer"')
  for (const change of releaseChanges(f.release, f.data, f.scene)) {
    const record = f.data.acceptanceRecords!.find(record => record.changeId === change.id)
    if (record) record.key = change.checks![0]!.key
  }
  observed.scene = { ...f.scene, cards: f.scene.cards.filter(card => !['Done', 'Archived'].includes(String(card.source.properties.Status!.value))) }
  vi.mocked(apiFetch).mockImplementation(async url => {
    const request = new URL(String(url), 'https://synthetic.test')
    if (request.pathname !== '/api/reconciliation/scene') throw new Error('Unexpected source request')
    return new Response(JSON.stringify({ ok: true, data: request.searchParams.get('history') === '1' ? f.scene : observed.scene }))
  })
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<Releases data={f.data} error={null} refresh={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Verify' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Release notes' }))
  expect(await screen.findByText('Internal: Hide absent generator frequency.')).toBeTruthy()
  const paper = document.querySelector('.notes-paper')!
  expect(paper).toHaveTextContent('Internal: Bound query load.')
  expect(paper).toHaveTextContent('2 included changes')
  expect(screen.getByText('4 changes excluded because linked work, deployment or feature acceptance is not evidenced.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }))
  expect(await screen.findByText('Release notes copied')).toBeTruthy()
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Internal: Hide absent generator frequency.'))
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Internal: Bound query load.'))
  fireEvent.click(screen.getByRole('button', { name: 'Customer' }))
  expect(paper).toHaveTextContent('Customer: Hide absent generator frequency.')
  expect(paper).toHaveTextContent('Customer: Bound query load.')
  expect(paper).toHaveTextContent('2 included changes')
  expect(paper).not.toHaveTextContent('Internal:')
  fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }))
  expect(await screen.findByText('Release notes copied')).toBeTruthy()
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Customer: Hide absent generator frequency.'))
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Customer: Bound query load.'))
  expect(writeText.mock.calls.at(-1)![0]).not.toMatch(/Internal:|Correct enum mappings|Preserve controller identity|Remove expired history/)
})
