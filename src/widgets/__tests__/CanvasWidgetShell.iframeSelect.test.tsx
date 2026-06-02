import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWidgetShell } from '../CanvasWidgetShell'
import type { WidgetRegistration } from '../widgetComponentRegistry'

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true })
})

// A widget whose body is an iframe — mirrors the browser/terminal case.
const IframeWidget = () => <iframe title="body" data-testid="inner-frame" />

const registration = {
  type: 'test-iframe',
  component: IframeWidget,
  isContainer: false,
  minSize: { width: 100, height: 100 },
} as unknown as WidgetRegistration

function renderShell(overrides: Partial<React.ComponentProps<typeof CanvasWidgetShell>> = {}) {
  const onSelect = vi.fn()
  const layout = { x: 0, y: 0, width: 200, height: 200 }
  render(
    <CanvasWidgetShell
      registration={registration}
      nodeId="pw-abc"
      data={{}}
      layout={layout as never}
      zoom={1}
      isSelected={false}
      spaceHeldRef={{ current: false }}
      onSelect={onSelect}
      onMove={() => {}}
      onResize={() => {}}
      {...overrides}
    />,
  )
  return { onSelect }
}

describe('CanvasWidgetShell iframe focus → select', () => {
  it('selects the widget when its inner iframe becomes the active element on window blur', () => {
    const { onSelect } = renderShell()
    const frame = document.querySelector('[data-testid="inner-frame"]') as HTMLIFrameElement
    frame.focus()
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    window.dispatchEvent(new Event('blur'))
    expect(onSelect).toHaveBeenCalledWith('pw-abc', false)
  })

  it('does not fire onSelect when already selected', () => {
    const { onSelect } = renderShell({ isSelected: true })
    const frame = document.querySelector('[data-testid="inner-frame"]') as HTMLIFrameElement
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    window.dispatchEvent(new Event('blur'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not fire onSelect when the active element is not inside this shell', () => {
    const { onSelect } = renderShell()
    const stray = document.createElement('iframe')
    document.body.appendChild(stray)
    Object.defineProperty(document, 'activeElement', { value: stray, configurable: true })
    window.dispatchEvent(new Event('blur'))
    expect(onSelect).not.toHaveBeenCalled()
    stray.remove()
  })

  it('does not fire onSelect on OS-level window blur (document.hasFocus() false)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const { onSelect } = renderShell()
    const frame = document.querySelector('[data-testid="inner-frame"]') as HTMLIFrameElement
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    window.dispatchEvent(new Event('blur'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
