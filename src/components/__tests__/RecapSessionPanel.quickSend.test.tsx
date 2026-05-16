// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { RecapSessionPanel } from '../RecapSessionPanel'
import type { RecapEntry } from '../../types'

vi.mock('../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  })),
  apiUrl: (path: string) => path,
}))

vi.mock('../../hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({ commands: [], usage: {}, refresh: () => {} }),
}))

import { apiFetch } from '../../apiClient'

const ACCENT = '#ff7700'
const NO_ENTRIES: RecapEntry[] = []

function renderComposer(overrides: Partial<React.ComponentProps<typeof RecapSessionPanel>> = {}) {
  return render(
    <RecapSessionPanel
      recapEntries={NO_ENTRIES}
      rawLogs=""
      port={undefined}
      sessionId="run-1"
      status="idle"
      accent={ACCENT}
      promptComposerExpanded={true}
      controlledTab="recap"
      onControlledTabChange={() => {}}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('<RecapSessionPanel> quick-send buttons', () => {
  it('renders all seven quick-send buttons when the textarea is empty', () => {
    const { container } = renderComposer()
    for (const key of ['1', '2', '3', '4', '5', 'y', 'n']) {
      expect(container.querySelector(`[data-testid="quick-send-${key}"]`)).toBeTruthy()
    }
  })

  it('hides quick-send buttons when the textarea has content', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'drafting a prompt' } })
    expect(container.querySelector('[data-testid="quick-send-1"]')).toBeFalsy()
    expect(container.querySelector('[data-testid="quick-send-y"]')).toBeFalsy()
  })

  it('clicking quick-send button 3 posts send-keys with ["3"]', () => {
    const { container } = renderComposer()
    const btn = container.querySelector('[data-testid="quick-send-3"]') as HTMLButtonElement
    fireEvent.click(btn)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [path, init] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/sessions/run-1/send-keys')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ keys: ['3'] })
  })

  it('clicking the Y button posts send-keys with ["y"] (lowercase)', () => {
    const { container } = renderComposer()
    const btn = container.querySelector('[data-testid="quick-send-y"]') as HTMLButtonElement
    fireEvent.click(btn)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [, init] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ keys: ['y'] })
  })

  it('does not render quick-send buttons when sessionId is missing', () => {
    const { container } = renderComposer({ sessionId: undefined })
    expect(container.querySelector('[data-testid="quick-send-1"]')).toBeFalsy()
  })
})

describe('<RecapSessionPanel> quick-send hotkeys', () => {
  it('Alt+2 in the focused textarea posts send-keys with ["2"] (empty draft)', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '2', code: 'Digit2', altKey: true })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [path, init] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/sessions/run-1/send-keys')
    expect(JSON.parse(init.body)).toEqual({ keys: ['2'] })
  })

  it('Alt+2 still fires when the textarea has draft content', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'mid draft' } })
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '2', code: 'Digit2', altKey: true })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse((apiFetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ keys: ['2'] })
  })

  it('Alt+N posts send-keys with ["n"] (lowercase)', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'n', code: 'KeyN', altKey: true })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse((apiFetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ keys: ['n'] })
  })

  it('Alt+Y posts send-keys with ["y"] regardless of e.key case', () => {
    // On macOS, Alt+letter sometimes surfaces a non-ASCII e.key. The handler
    // must dispatch off e.code so it works on every layout.
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '¥', code: 'KeyY', altKey: true })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse((apiFetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ keys: ['y'] })
  })

  it('Alt+9 does not fire (out of supported range)', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '9', code: 'Digit9', altKey: true })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('plain "2" (no Alt) does not fire send-keys', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '2', code: 'Digit2', altKey: false })
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('<RecapSessionPanel> empty-prompt arrow/Enter passthrough', () => {
  it.each([
    ['ArrowUp',    'Up'],
    ['ArrowDown',  'Down'],
    ['ArrowLeft',  'Left'],
    ['ArrowRight', 'Right'],
    ['Enter',      'Enter'],
  ])('plain %s on empty prompt sends ["%s"] to terminal', (key, tmuxKey) => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [path, init] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/sessions/run-1/send-keys')
    expect(JSON.parse(init.body)).toEqual({ keys: [tmuxKey] })
  })

  it('arrow keys do NOT passthrough when textarea has content', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'drafting' } })
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('Shift+Enter on empty prompt does NOT passthrough (lets newline through)', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('renders nav quick-send buttons (up/down/left/right/enter)', () => {
    const { container } = renderComposer()
    for (const key of ['up', 'down', 'left', 'right', 'enter']) {
      expect(container.querySelector(`[data-testid="quick-send-${key}"]`)).toBeTruthy()
    }
  })

  it('clicking the up nav button sends ["Up"]', () => {
    const { container } = renderComposer()
    const btn = container.querySelector('[data-testid="quick-send-up"]') as HTMLButtonElement
    fireEvent.click(btn)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse((apiFetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ keys: ['Up'] })
  })

  it('plain ArrowUp flashes the up nav button', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    const btn = container.querySelector('[data-testid="quick-send-up"]') as HTMLButtonElement
    expect(btn.className).toMatch(/animate-\[quick-pop/)
  })
})

describe('<RecapSessionPanel> quick-send press flash', () => {
  it('hotkey press flashes the matching button', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '3', code: 'Digit3', altKey: true })
    const btn = container.querySelector('[data-testid="quick-send-3"]') as HTMLButtonElement
    expect(btn.className).toMatch(/animate-\[quick-pop/)
  })

  it('click press flashes the clicked button', () => {
    const { container } = renderComposer()
    const btn = container.querySelector('[data-testid="quick-send-y"]') as HTMLButtonElement
    fireEvent.click(btn)
    const flashed = container.querySelector('[data-testid="quick-send-y"]') as HTMLButtonElement
    expect(flashed.className).toMatch(/animate-\[quick-pop/)
  })
})
