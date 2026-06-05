import { render, cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWidgetShell } from '../CanvasWidgetShell'
import type { WidgetRegistration } from '../widgetComponentRegistry'

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

function renderShell(overrides: Partial<React.ComponentProps<typeof CanvasWidgetShell>> = {}) {
  const layout = { x: 0, y: 0, width: 200, height: 200 }
  render(
    <CanvasWidgetShell
      registration={makeReg()}
      nodeId="pw-add"
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

describe('CanvasWidgetShell [+] add-widget affordance', () => {
  it('renders the [+] buttons for a snappable leaf when onAddWidget is provided and selected', () => {
    renderShell({ onAddWidget: vi.fn(), isSelected: true })
    expect(screen.getByTestId('add-widget-btn-right')).toBeTruthy()
    expect(screen.getAllByTitle('Add widget').length).toBeGreaterThan(0)
  })

  it('does NOT render the [+] buttons when registration.snappable === false', () => {
    renderShell({
      registration: makeReg({ snappable: false }),
      onAddWidget: vi.fn(),
      isSelected: true,
    })
    expect(screen.queryByTestId('add-widget-btn-right')).toBeNull()
    expect(screen.queryByTitle('Add widget')).toBeNull()
  })
})
