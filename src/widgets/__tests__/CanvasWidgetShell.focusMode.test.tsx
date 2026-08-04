// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFocusPresentation } from '../../focusMode/FocusPresentationContext'
import { CanvasWidgetShell } from '../CanvasWidgetShell'
import type { WidgetRegistration } from '../widgetComponentRegistry'

afterEach(cleanup)

function Probe() {
  return <div data-testid="presentation">{useFocusPresentation()}</div>
}

const registration = {
  type: 'test-focus',
  component: Probe,
  minSize: { width: 100, height: 100 },
} as unknown as WidgetRegistration

function renderShell(props: Partial<React.ComponentProps<typeof CanvasWidgetShell>> = {}) {
  const onSelect = vi.fn()
  const onMove = vi.fn()
  render(
    <CanvasWidgetShell
      registration={registration}
      nodeId="run-one"
      data={{}}
      layout={{ x: 10, y: 20, width: 400, height: 300 }}
      zoom={1}
      isSelected
      spaceHeldRef={{ current: false }}
      onSelect={onSelect}
      onMove={onMove}
      onResize={vi.fn()}
      onAddWidget={vi.fn()}
      onApplySizePreset={vi.fn()}
      {...props}
    />,
  )
  return { onSelect, onMove }
}

describe('CanvasWidgetShell focus presentation', () => {
  it('locks canvas gestures and removes host editing chrome', () => {
    const { onSelect, onMove } = renderShell({ interactionLocked: true, presentation: 'focus' })
    const shell = screen.getByTestId('canvas-widget-run-one')

    fireEvent.pointerDown(shell, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(shell, { pointerId: 1, clientX: 80, clientY: 80 })

    expect(onSelect).not.toHaveBeenCalled()
    expect(onMove).not.toHaveBeenCalled()
    expect(screen.getByTestId('presentation')).toHaveTextContent('focus')
    expect(screen.queryByTestId('size-preset-toolbar')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Add widget')).not.toBeInTheDocument()
  })

  it('keeps hidden widgets mounted but inert and non-visible', () => {
    renderShell({ hidden: true })
    const shell = screen.getByTestId('canvas-widget-run-one')

    expect(shell).toHaveAttribute('aria-hidden', 'true')
    expect(shell).toHaveStyle({ visibility: 'hidden', pointerEvents: 'none' })
    expect((shell as HTMLDivElement & { inert: boolean }).inert).toBe(true)
    expect(screen.getByTestId('presentation')).toBeInTheDocument()
  })
})
