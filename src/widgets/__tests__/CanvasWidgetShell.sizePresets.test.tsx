import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWidgetShell } from '../CanvasWidgetShell'
import type { WidgetRegistration } from '../widgetComponentRegistry'

beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true) })
afterEach(() => cleanup())

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
  render(
    <CanvasWidgetShell
      registration={makeReg()}
      nodeId="pw-size"
      data={{}}
      layout={{ x: 0, y: 0, width: 200, height: 200 } as never}
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

describe('CanvasWidgetShell size-preset toolbar', () => {
  it('does not render the toolbar without onApplySizePreset', () => {
    renderShell({ isSelected: true })
    expect(screen.queryByTestId('size-preset-toolbar')).toBeNull()
  })

  it('renders S/M/L when selected and onApplySizePreset is provided', () => {
    renderShell({ isSelected: true, onApplySizePreset: vi.fn() })
    expect(screen.getByTestId('size-preset-toolbar')).toBeTruthy()
    expect(screen.getByTestId('size-preset-small')).toBeTruthy()
    expect(screen.getByTestId('size-preset-medium')).toBeTruthy()
    expect(screen.getByTestId('size-preset-large')).toBeTruthy()
  })

  it('fires onApplySizePreset with the clicked preset key', () => {
    const onApply = vi.fn()
    renderShell({ isSelected: true, onApplySizePreset: onApply })
    fireEvent.click(screen.getByTestId('size-preset-large'))
    expect(onApply).toHaveBeenCalledWith('large')
  })

  it('marks the active preset via aria-pressed', () => {
    renderShell({ isSelected: true, onApplySizePreset: vi.fn(), activeSizePreset: 'medium' })
    expect(screen.getByTestId('size-preset-medium').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('size-preset-small').getAttribute('aria-pressed')).toBe('false')
  })
})
