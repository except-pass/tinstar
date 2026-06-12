// @vitest-environment jsdom
import { render, cleanup, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWidgetShell } from '../CanvasWidgetShell'
import type { WidgetRegistration } from '../widgetComponentRegistry'
import type { Pin } from '../../domain/pinSet'

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

const LeafWidget = () => <div data-testid="leaf-body" />

function makeReg(overrides: Partial<WidgetRegistration> = {}): WidgetRegistration {
  return {
    type: 'test-leaf',
    component: LeafWidget,
    isContainer: false,
    minSize: { width: 100, height: 100 },
    ...overrides,
  } as unknown as WidgetRegistration
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
      layout={layout as never}
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
    renderShell({ registration: makeReg({ pinnable: false } as never), isSelected: true, onCreatePin: vi.fn() })
    expect(screen.queryByTestId('pin-drop-affordance')).toBeNull()
  })

  it('renders the default PinLayer markers for a non-rendersOwnPinMarkers widget', () => {
    renderShell({ pins: [pin({ id: 'p1' })], onRepositionPin: vi.fn() })
    expect(screen.getByTestId('pin-marker-p1')).toBeTruthy()
  })

  it('skips the default PinLayer when the widget renders its own pin markers', () => {
    renderShell({
      registration: makeReg({ rendersOwnPinMarkers: true } as never),
      pins: [pin({ id: 'p1' })],
      onRepositionPin: vi.fn(),
    })
    expect(screen.queryByTestId('pin-marker-p1')).toBeNull()
  })
})
