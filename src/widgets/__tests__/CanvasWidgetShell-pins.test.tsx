// @vitest-environment jsdom
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWidgetShell } from '../CanvasWidgetShell'
import type { WidgetRegistration } from '../widgetComponentRegistry'
import type { Pin } from '../../domain/pinSet'
import type { ComponentType } from 'react'
import type { WidgetProps } from '@tinstar/plugin-api'

// jsdom implements neither pointer capture nor hasFocus; stub both.
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
})

const LeafWidget: ComponentType<WidgetProps> = () => <div data-testid="leaf-body" />

/** Minimal well-typed WidgetRegistration; only required fields + explicit overrides. */
function makeReg(overrides: Partial<WidgetRegistration> = {}): WidgetRegistration {
  return {
    type: 'test-leaf',
    component: LeafWidget,
    isContainer: false,
    minSize: { width: 100, height: 100 },
    ...overrides,
  }
}

function pin(over: Partial<Pin> = {}): Pin {
  return { id: 'p1', nodeId: 'pw-pins', nx: 0.5, ny: 0.5, comment: '', createdAt: 0, ...over }
}

function renderShell(overrides: Partial<React.ComponentProps<typeof CanvasWidgetShell>> = {}) {
  const layout = { x: 0, y: 0, width: 200, height: 200 }
  render(
    <CanvasWidgetShell
      registration={makeReg()}
      nodeId="pw-pins"
      data={{}}
      layout={layout}
      zoom={1}
      isSelected={false}
      spaceHeldRef={{ current: false }}
      onSelect={() => {}}
      onMove={() => {}}
      onResize={() => {}}
      {...overrides}
    />,
  )
}

describe('CanvasWidgetShell pins', () => {
  it('renders the drop affordance for a pinnable widget when selected and onCreatePin is provided', () => {
    renderShell({ isSelected: true, onCreatePin: vi.fn() })
    expect(screen.getByTestId('pin-drop-affordance')).toBeTruthy()
  })

  it('does NOT render the affordance when registration is not pinnable', () => {
    renderShell({ registration: makeReg({ pinnable: false }), isSelected: true, onCreatePin: vi.fn() })
    expect(screen.queryByTestId('pin-drop-affordance')).toBeNull()
  })

  it('renders the default PinLayer markers for a non-rendersOwnPinMarkers widget', () => {
    renderShell({ pins: [pin({ id: 'p1' })], onRepositionPin: vi.fn() })
    expect(screen.getByTestId('pin-marker-p1')).toBeTruthy()
  })

  it('skips the default PinLayer when the widget renders its own pin markers', () => {
    renderShell({
      registration: makeReg({ rendersOwnPinMarkers: true }),
      pins: [pin({ id: 'p1' })],
      onRepositionPin: vi.fn(),
    })
    expect(screen.queryByTestId('pin-marker-p1')).toBeNull()
  })

  it('shows the pin cluster (count + send-all + clear-all) when hovered with pins', () => {
    renderShell({ isSelected: true, pins: [pin({ id: 'p1' })], onRepositionPin: vi.fn(), pinCanSubmit: true })
    expect(screen.getByTestId('pin-count').textContent).toBe('1')
    expect(screen.getByTestId('pin-send-all')).toBeTruthy()
    expect(screen.getByTestId('pin-clear-all')).toBeTruthy()
  })

  it('does NOT show the cluster when there are no pins', () => {
    renderShell({ isSelected: true, pins: [], onRepositionPin: vi.fn() })
    expect(screen.queryByTestId('pin-count')).toBeNull()
    expect(screen.queryByTestId('pin-send-all')).toBeNull()
  })

  it('send-all is disabled when there is no backing session, enabled with unsent pins', () => {
    const onSendAllPins = vi.fn()
    renderShell({ isSelected: true, pins: [pin({ id: 'p1' })], onRepositionPin: vi.fn(), pinCanSubmit: false, onSendAllPins })
    expect((screen.getByTestId('pin-send-all') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    renderShell({ isSelected: true, pins: [pin({ id: 'p1' })], onRepositionPin: vi.fn(), pinCanSubmit: true, onSendAllPins })
    const btn = screen.getByTestId('pin-send-all') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onSendAllPins).toHaveBeenCalledWith('pw-pins')
  })

  it('send-all is disabled when every pin is already sent', () => {
    renderShell({ isSelected: true, pins: [pin({ id: 'p1', sentAt: 123 })], onRepositionPin: vi.fn(), pinCanSubmit: true })
    expect((screen.getByTestId('pin-send-all') as HTMLButtonElement).disabled).toBe(true)
  })

  it('clear-all fires onClearAllPins with the nodeId', () => {
    const onClearAllPins = vi.fn()
    renderShell({ isSelected: true, pins: [pin({ id: 'p1' })], onRepositionPin: vi.fn(), onClearAllPins })
    fireEvent.click(screen.getByTestId('pin-clear-all'))
    expect(onClearAllPins).toHaveBeenCalledWith('pw-pins')
  })

  it('clears the iframe guard when capture is lost mid-place-drag (onPointerCancel path)', () => {
    const onPinDragActive = vi.fn()
    renderShell({ isSelected: true, onCreatePin: vi.fn(), onPinDragActive })

    const affordance = screen.getByTestId('pin-drop-affordance')

    // Start a place-drag — guard should raise
    fireEvent.pointerDown(affordance, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    expect(onPinDragActive).toHaveBeenLastCalledWith(true)

    // Simulate involuntary capture loss via pointercancel (exercises endPinPlace via onPointerCancel)
    fireEvent.pointerCancel(affordance, { pointerId: 1, clientX: 10, clientY: 10 })
    expect(onPinDragActive).toHaveBeenLastCalledWith(false)

    // Guard must not be raised any more — a subsequent cancel is idempotent (ref already null)
    const callCount = onPinDragActive.mock.calls.length
    fireEvent.pointerCancel(affordance, { pointerId: 1, clientX: 10, clientY: 10 })
    expect(onPinDragActive.mock.calls.length).toBe(callCount)
  })
})
