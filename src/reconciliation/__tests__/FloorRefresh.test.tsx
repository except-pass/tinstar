import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { FloorRefresh } from '../FloorRefresh'
const now = Date.parse('2026-11-09T16:00:00Z')
afterEach(cleanup)
it('keeps success time in its accessible hover/focus label, disables overlap and labels failure/partial coverage', () => {
  const scene = fixtureScene({ now }), refresh = vi.fn().mockResolvedValue(undefined)
  const sync = { refresh, refreshing: false, lastSuccessfulSyncAt: scene.coverage.intentions.observedAt, error: null as string | null }
  const { rerender } = render(<FloorRefresh sync={sync} scene={scene} now={now} />)
  const button = screen.getByRole('button', { name: /Refresh work.*Sources current.*Last successful sync/ })
  expect(button).toHaveAttribute('title', button.getAttribute('aria-label'))
  fireEvent.click(button)
  expect(refresh).toHaveBeenCalledTimes(1)
  rerender(<FloorRefresh sync={{ ...sync, refreshing: true }} scene={scene} now={now} />)
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
  fireEvent.click(button)
  expect(refresh).toHaveBeenCalledTimes(1)
  rerender(<FloorRefresh sync={{ ...sync, error: 'offline' }} scene={scene} now={now} />)
  expect(button).toHaveAccessibleName(/Refresh failed; showing last-known data/)
  scene.coverage.intentions.coverage = 'partial'
  rerender(<FloorRefresh sync={sync} scene={scene} now={now} />)
  expect(button).toHaveAccessibleName(/coverage incomplete/)
  scene.coverage.intentions.error = 'Notion source read failed'
  rerender(<FloorRefresh sync={sync} scene={scene} now={now} />)
  expect(button).toHaveAccessibleName(/Refresh failed; showing last-known data/)
  expect(button).toHaveAccessibleName(new RegExp(new Date(sync.lastSuccessfulSyncAt!).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
