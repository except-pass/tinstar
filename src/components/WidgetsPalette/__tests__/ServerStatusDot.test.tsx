import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerStatusDot, placePopover } from '../ServerStatusDot'

describe('placePopover', () => {
  const vw = window.innerWidth
  const vh = window.innerHeight

  it('clamps the left edge so a 208px popover never overflows the right of the viewport', () => {
    // Dot near the right edge (like the right column of the palette) — left must pull in.
    const p = placePopover({ left: vw - 20, top: 40, bottom: 50 })
    expect(p.left).toBeLessThanOrEqual(vw - 208 - 8)
    expect(p.left).toBeGreaterThanOrEqual(8)
  })

  it('opens below when there is more room below the dot', () => {
    const p = placePopover({ left: 100, top: 10, bottom: 20 })
    expect(p.top).toBe(26) // bottom + GAP
    expect(p.bottom).toBeUndefined()
  })

  it('flips above when the dot sits low in the viewport', () => {
    const p = placePopover({ left: 100, top: vh - 20, bottom: vh - 10 })
    expect(p.bottom).toBe(vh - (vh - 20) + 6) // vh - rect.top + GAP
    expect(p.top).toBeUndefined()
  })
})

describe('ServerStatusDot', () => {
  it('renders a labelled dot reflecting status', () => {
    render(<ServerStatusDot pluginId="who" displayName="Who" status="down" startable onStart={vi.fn()} />)
    const dot = screen.getByTestId('server-status-dot-who')
    expect(dot.getAttribute('data-status')).toBe('down')
  })

  it('opens a popover with a Start button when down + startable, and calls onStart', () => {
    const onStart = vi.fn()
    render(<ServerStatusDot pluginId="who" displayName="Who" status="down" startable onStart={onStart} />)
    fireEvent.click(screen.getByTestId('server-status-dot-who'))
    fireEvent.click(screen.getByTestId('server-status-start-who'))
    expect(onStart).toHaveBeenCalledWith('who')
  })

  it('does not render a Start button when not startable', () => {
    render(<ServerStatusDot pluginId="who" displayName="Who" status="down" startable={false} onStart={vi.fn()} />)
    fireEvent.click(screen.getByTestId('server-status-dot-who'))
    expect(screen.queryByTestId('server-status-start-who')).toBeNull()
  })

  it('stops click propagation so opening the popover never starts a tile drag', () => {
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <ServerStatusDot pluginId="who" displayName="Who" status="up" startable onStart={vi.fn()} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('server-status-dot-who'))
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('nats kind shows broker labels and no Start/View-log popover content', () => {
    render(<ServerStatusDot pluginId="nats-traffic" displayName="Saloon" status="down" startable={false} kind="nats" onStart={vi.fn()} />)
    const dot = screen.getByTestId('server-status-dot-nats-traffic')
    expect(dot.getAttribute('aria-label')).toContain('NATS broker down')
    fireEvent.click(dot)
    expect(screen.queryByTestId('server-status-start-nats-traffic')).toBeNull()
    expect(screen.queryByText('View log')).toBeNull()
    expect(screen.getByText(/Host NATS observer is not connected/)).toBeTruthy()
  })

  it('stops a drag started on the dot from bubbling into the tile (native HTML5 drag)', () => {
    const parentDragStart = vi.fn()
    render(
      <div onDragStart={parentDragStart}>
        <ServerStatusDot pluginId="who" displayName="Who" status="down" startable onStart={vi.fn()} />
      </div>,
    )
    fireEvent.dragStart(screen.getByTestId('server-status-dot-who'))
    expect(parentDragStart).not.toHaveBeenCalled()
  })
})
