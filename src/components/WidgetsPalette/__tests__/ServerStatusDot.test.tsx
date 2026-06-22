import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerStatusDot } from '../ServerStatusDot'

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
