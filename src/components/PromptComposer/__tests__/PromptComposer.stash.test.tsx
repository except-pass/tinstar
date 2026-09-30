// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PromptComposer } from '../PromptComposer'
import type { RecapEntry } from '../../../types'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
  apiUrl: (path: string) => path,
}))

vi.mock('../../../hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({ commands: [], usage: {}, refresh: () => {} }),
}))

const ACCENT = '#ff7700'
const NO_ENTRIES: RecapEntry[] = []

function renderComposer(sessionId = 'stash-test-session') {
  return render(
    <PromptComposer
      recapEntries={NO_ENTRIES}
      rawLogs=""
      port={undefined}
      sessionId={sessionId}
      status="idle"
      accent={ACCENT}
      promptComposerExpanded={true}
      controlledTab="recap"
      onControlledTabChange={() => {}}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('<PromptComposer> stash slots', () => {
  it('renders two stash slot buttons, initially empty', () => {
    const { container } = renderComposer()
    const s1 = container.querySelector('[data-testid="stash-slot-1"]')
    const s2 = container.querySelector('[data-testid="stash-slot-2"]')
    expect(s1).toBeTruthy()
    expect(s2).toBeTruthy()
    expect(s1?.getAttribute('data-filled')).toBeNull()
    expect(s2?.getAttribute('data-filled')).toBeNull()
  })

  it('clicking an empty slot with composer text stashes it and clears the composer', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'stash me' } })
    fireEvent.click(container.querySelector('[data-testid="stash-slot-1"]')!)
    expect(textarea.value).toBe('')
    expect(container.querySelector('[data-testid="stash-slot-1"]')?.getAttribute('data-filled')).toBe('true')
  })

  it('clicking a filled slot with empty composer recalls (slot empties, composer fills)', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'recall me' } })
    const slot1 = () => container.querySelector('[data-testid="stash-slot-1"]')!
    fireEvent.click(slot1())
    expect(textarea.value).toBe('')
    fireEvent.click(slot1())
    expect(textarea.value).toBe('recall me')
    expect(slot1().getAttribute('data-filled')).toBeNull()
  })

  it('clicking a filled slot with composer text swaps them', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'first thought' } })
    fireEvent.click(container.querySelector('[data-testid="stash-slot-1"]')!)
    fireEvent.change(textarea, { target: { value: 'second thought' } })
    fireEvent.click(container.querySelector('[data-testid="stash-slot-1"]')!)
    expect(textarea.value).toBe('first thought')
    // slot now holds the previously-current text
    expect(container.querySelector('[data-testid="stash-slot-1"]')?.getAttribute('data-filled')).toBe('true')
  })

  it('shift+click on a filled slot clears it without touching the composer', () => {
    const { container } = renderComposer()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'temp' } })
    fireEvent.click(container.querySelector('[data-testid="stash-slot-1"]')!)
    fireEvent.change(textarea, { target: { value: 'keep this' } })
    fireEvent.click(container.querySelector('[data-testid="stash-slot-1"]')!, { shiftKey: true })
    expect(textarea.value).toBe('keep this')
    expect(container.querySelector('[data-testid="stash-slot-1"]')?.getAttribute('data-filled')).toBeNull()
  })

  it('persists stash to localStorage per session id and reloads it', () => {
    const { container, unmount } = renderComposer('persist-1')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'survives reload' } })
    fireEvent.click(container.querySelector('[data-testid="stash-slot-2"]')!)
    unmount()

    const remounted = renderComposer('persist-1')
    expect(remounted.container.querySelector('[data-testid="stash-slot-2"]')?.getAttribute('data-filled')).toBe('true')
    // recall and verify content
    fireEvent.click(remounted.container.querySelector('[data-testid="stash-slot-2"]')!)
    expect((remounted.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('survives reload')
  })

  it('isolates stash by sessionId', () => {
    const a = renderComposer('session-a')
    fireEvent.change(a.container.querySelector('textarea')!, { target: { value: 'A text' } })
    fireEvent.click(a.container.querySelector('[data-testid="stash-slot-1"]')!)
    a.unmount()

    const b = renderComposer('session-b')
    expect(b.container.querySelector('[data-testid="stash-slot-1"]')?.getAttribute('data-filled')).toBeNull()
  })
})
