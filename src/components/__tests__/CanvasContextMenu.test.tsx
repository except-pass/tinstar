// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CanvasContextMenu } from '../CanvasContextMenu'
import type { MoveTarget } from '../../domain/moveTargets'

const targets: MoveTarget[] = [
  { id: 'run-A', label: 'Run A', slots: [3] },
  { id: 'browser-1', label: 'Browser', slots: [] },
]

describe('CanvasContextMenu', () => {
  it('shows the Move-widget-here item; clicking reveals the open-widget list with slot chips', () => {
    render(<CanvasContextMenu anchor={{ x: 50, y: 60 }} targets={targets} onPick={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Move widget here'))
    expect(screen.getByText('Run A')).toBeTruthy()
    expect(screen.getByText('Browser')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy() // slot chip for run-A
  })
  it('picking a widget calls onPick with its id', () => {
    const onPick = vi.fn()
    render(<CanvasContextMenu anchor={{ x: 0, y: 0 }} targets={targets} onPick={onPick} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Move widget here'))
    fireEvent.click(screen.getByText('Browser'))
    expect(onPick).toHaveBeenCalledWith('browser-1')
  })
  it('empty target list shows a no-widgets note', () => {
    render(<CanvasContextMenu anchor={{ x: 0, y: 0 }} targets={[]} onPick={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Move widget here'))
    expect(screen.getByText(/no widgets/i)).toBeTruthy()
  })
  it('Escape calls onClose', () => {
    const onClose = vi.fn()
    render(<CanvasContextMenu anchor={{ x: 0, y: 0 }} targets={targets} onPick={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
  it('swallows wheel so it scrolls the list, not the canvas beneath', () => {
    // The canvas attaches a native, non-passive wheel listener to its container
    // for zoom/pan. The menu lives inside that container, so an un-stopped wheel
    // over the menu's list would zoom the canvas. Render inside a stand-in
    // "canvas" with a native wheel listener and assert it never fires.
    const canvasWheel = vi.fn()
    const canvas = document.createElement('div')
    canvas.addEventListener('wheel', canvasWheel)
    document.body.appendChild(canvas)
    render(<CanvasContextMenu anchor={{ x: 0, y: 0 }} targets={targets} onPick={vi.fn()} onClose={vi.fn()} />, { container: canvas })
    const menu = (screen.getByText('Move widget here').closest('div'))!
    fireEvent.wheel(menu)
    expect(canvasWheel).not.toHaveBeenCalled()
    document.body.removeChild(canvas)
  })
})
