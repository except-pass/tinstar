import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AddWidgetPicker } from '../AddWidgetPicker'
import type { CatalogEntry } from '../../hooks/useWidgetCatalog'

const entries: CatalogEntry[] = [
  { type: 'terminal', label: 'Terminal', defaultSize: { width: 300, height: 200 } } as CatalogEntry,
  { type: 'browser', label: 'Browser', defaultSize: { width: 300, height: 200 } } as CatalogEntry,
]
const moveTargets = [
  { id: 'w-run42', label: 'run-42', slots: [1] },
  { id: 'w-notes', label: 'design doc', slots: [] },
]

function setup(overrides = {}) {
  const onPick = vi.fn(); const onMove = vi.fn(); const onClose = vi.fn()
  render(
    <AddWidgetPicker
      entries={entries} defaultType="terminal" anchor={{ x: 0, y: 0 }}
      moveTargets={moveTargets} onPick={onPick} onMove={onMove} onClose={onClose} {...overrides}
    />,
  )
  return { onPick, onMove, onClose }
}

describe('AddWidgetPicker move mode', () => {
  it('shows the pinned move row above the catalog in create mode', () => {
    setup()
    expect(screen.getByTestId('add-widget-move-existing')).toBeInTheDocument()
    expect(screen.getByTestId('add-widget-option-terminal')).toBeInTheDocument()
  })

  it('hides the pinned row when there are no move targets', () => {
    setup({ moveTargets: [] })
    expect(screen.queryByTestId('add-widget-move-existing')).not.toBeInTheDocument()
  })

  it('selecting the pinned row swaps to the move list; picking a target fires onMove', () => {
    const { onMove } = setup()
    fireEvent.click(screen.getByTestId('add-widget-move-existing'))
    // catalog gone, targets shown
    expect(screen.queryByTestId('add-widget-option-terminal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('add-widget-move-target-w-run42'))
    expect(onMove).toHaveBeenCalledWith('w-run42')
  })

  it('Escape in move mode returns to create mode (does not close)', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByTestId('add-widget-move-existing'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('add-widget-option-terminal')).toBeInTheDocument()
  })
})
